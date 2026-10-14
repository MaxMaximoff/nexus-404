// App state (signals) and the controller that drives the device.

import { draftOf, draftsProject, dropDraft, drafts, editingSlot, fileSum, isDirty, restoreDrafts } from "./patternDraft";
import { batch, computed, effect, signal } from "@preact/signals";
import { safeFileName, saveFile } from "./download";
import {
  PAD_COUNT, SP404Device, SampleUploader, WebSerialTransport, bpmFromFileName, computeEnvelope, computePeaks, isSp404Port,
  BANKS, PPQ, MAX_BARS, encodeWav, BPM_MAX_X100, BPM_MIN_X100, BPM_RANGES, VARI_MODES, bpmFromLength, byteToFrame, detectBpm, formatBpm, newJob, padName, padSpeed, parsePadBlock, samplePath, smpToPcm,
  parsePattern, patternDir, patternMidiName, patternPads, patternPath, patternToMidi, rebuildDiff, slotOfFileName, writePattern,
  type BpmResult, type DeviceStatus, type ImportJob, type LogLevel, type PadBlock, type Pattern, type ProjectSettings,
} from "../sp404";

export type Conn = "unsupported" | "idle" | "connecting" | "loading" | "ready" | "lost";

export interface Waveform {
  key: string;
  peaks: Float32Array[];
  envelope: Uint16Array;
  channels: number;
  frames: number;
  /** Interleaved PCM for zooming in; dropped from all but the newest SAMPLE_CACHE waveforms. */
  samples?: Int16Array;
}
export interface LogLine { t: string; level: LogLevel; text: string }

const WAVE_POINTS = 640;
const SAMPLE_CACHE = 16;
const AUTO_WAVE_MAX_BYTES = 4 * 1024 * 1024;
const POLL_MS = 1000;

export const conn = signal<Conn>(WebSerialTransport.supported() ? "idle" : "unsupported");
export const hasGrant = signal(false);
export const status = signal<DeviceStatus | null>(null);
export const project = signal<(ProjectSettings & { names: string[] }) | null>(null);
export const pads = signal<(PadBlock | null)[]>(Array(PAD_COUNT).fill(null));
export const loadProgress = signal(0);
/** The project (1-based) the SP is switching to, until it is read here: the work area shows a spinner meanwhile. */
export const projectSwitching = signal<number | null>(null);
export const freeKb = signal<number | null>(null);
export const selectedBank = signal(0);
export const selectedPad = signal(0);
export const jobs = signal<ImportJob[]>([]);
export const waveforms = signal(new Map<number, Waveform>());
export const waveLoading = signal<{ pad: number; progress: number } | null>(null);
/** Channel count per pad (from the SMP header), keyed like waveforms so a new sample invalidates it. */
export const padChannels = signal(new Map<number, { key: string; channels: number }>());
export const logLines = signal<LogLine[]>([]);
export const showDebug = signal(false);
export const defaultBpm = signal("");
/** Detect the tempo of imported files whose names carry none (range: bpmRange). */
export const detectOnImport = signal(true);
export const notice = signal<{ kind: "error" | "info"; text: string } | null>(null);

export const project1 = computed(() => (status.value ? status.value.project + 1 : 0));
export const writeBlockReason = computed<string | null>(() => {
  if (conn.value !== "ready") return "SP is not connected";
  if (status.value && status.value.workingMode !== 0) return "SP is showing a menu — close it on the device";
  return null;
});
export const importing = computed(() => jobs.value.some((j) => j.state === "queued" || j.state === "decoding" || j.state === "uploading"));

let device: SP404Device | null = null;
let transport: WebSerialTransport | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let reloadTimer: ReturnType<typeof setTimeout> | null = null;
let importChain: Promise<unknown> = Promise.resolve();
const reserved = new Set<number>(); // pads targeted by queued jobs

export function log(level: LogLevel, text: string): void {
  const t = new Date().toTimeString().slice(0, 8);
  const next = [...logLines.value, { t, level, text }];
  logLines.value = next.length > 600 ? next.slice(-500) : next;
  if (level === "error") console.error(text);
}

function fail(e: unknown, context: string): void {
  const text = `${context}: ${(e as Error).message ?? e}`;
  log("error", text);
  notice.value = { kind: "error", text };
}

// ------------------------------------------------------------------ connection

export async function refreshGrant(): Promise<void> {
  hasGrant.value = (await WebSerialTransport.grantedPorts()).length > 0;
}

export async function connect(): Promise<void> {
  try {
    await openPort(await WebSerialTransport.request());
  } catch (e) {
    if ((e as DOMException).name === "NotFoundError") return; // chooser cancelled
    fail(e, "Connect");
    conn.value = "idle";
  }
}

export async function reconnect(silent = false): Promise<void> {
  const [port] = await WebSerialTransport.grantedPorts();
  if (!port) return silent ? undefined : connect();
  try {
    await openPort(port);
  } catch (e) {
    if (silent) log("info", `Auto-connect failed: ${(e as Error).message}`);
    else fail(e, "Reconnect");
    teardown();
    conn.value = "idle";
  }
}

async function openPort(port: SerialPort): Promise<void> {
  conn.value = "connecting";
  notice.value = null;
  const t = new WebSerialTransport(port);
  t.onLost = (reason) => {
    if (transport !== t) return;
    log("warn", `Connection lost: ${reason}`);
    teardown();
    conn.value = "lost";
  };
  try {
    await t.open();
  } catch (e) {
    throw new Error(`${(e as Error).message}. Port busy? Close SP-404MKII App and other tabs`);
  }
  transport = t;
  device = new SP404Device(t, (level, text) => (level !== "debug" || showDebug.value) && log(level, text));
  device.onNotification = (m) => {
    if (m.payload[0] === 0x1a) scheduleReload(500);
  };
  await loadAll(true);
  pollTimer = setInterval(poll, POLL_MS);
  refreshGrant();
}

function teardown(): void {
  if (pollTimer) clearInterval(pollTimer);
  if (reloadTimer) clearTimeout(reloadTimer);
  pollTimer = reloadTimer = null;
  playing.value = null;
  projectSwitching.value = null;
  device = null;
  transport = null;
}

export async function disconnect(): Promise<void> {
  const d = device, t = transport;
  teardown();
  try { await d?.exclusive((x) => x.mkiiExit()); } catch { /* the link may already be gone */ }
  await t?.close();
  batch(() => {
    conn.value = "idle";
    status.value = null;
    if (demo.value) {
      demo.value = false;
      project.value = null;
      pads.value = Array(PAD_COUNT).fill(null);
      patterns.value = null;
      waveforms.value = new Map();
      padChannels.value = new Map();
      picked.value = new Set();
    }
  });
  log("info", "Disconnected");
}

/** Demo mode (`?demo`): made-up data in the store, no device behind it (ui/demo.ts). */
export const demo = signal(new URLSearchParams(location.search).has("demo"));

export async function startDemo(): Promise<void> {
  const { demoData } = await import("./demo");
  const d = demoData();
  batch(() => {
    demo.value = true;
    status.value = d.status;
    project.value = d.project;
    pads.value = d.pads;
    patterns.value = d.patterns;
    freeKb.value = d.freeKb;
    selectedBank.value = 0;
    selectedPad.value = 0;
    for (const [pad, w] of d.waves) setWaveform(pad, d.pads[pad], w.samples, w.channels);
    conn.value = "ready";
  });
  log("info", "Demo mode: sample data, SP is not connected");
}

if (demo.value) startDemo();

if (WebSerialTransport.supported() && !demo.value) {
  navigator.serial.addEventListener("connect", (e) => {
    refreshGrant();
    const port = e.target as SerialPort;
    if (isSp404Port(port) && conn.value === "lost") {
      log("info", "SP is available again — reconnecting");
      setTimeout(() => conn.value === "lost" && reconnect(true), 1500);
    }
  });
  navigator.serial.addEventListener("disconnect", () => refreshGrant());
  refreshGrant().then(() => {
    // Previously granted port and the unit plugged in: connect without asking.
    if (hasGrant.value && conn.value === "idle") reconnect(true);
  });
}

// ------------------------------------------------------------------ reading

/** The project (0-based) whose data was read last, and the one before it (1-based): where the SP goes for a moment to reload a project. */
let loadedProject: number | null = null, prevProject1: number | null = null;

async function loadAll(first = false): Promise<void> {
  const d = device;
  if (!d) return;
  conn.value = "loading";
  loadProgress.value = 0;
  try {
    await d.exclusive(async (x) => {
      const st = await x.status();
      const ps = await x.projectSettings(st.project);
      const blocks = await x.allPadBlocks((done, total) => (loadProgress.value = done / total));
      const kb = await x.freeKb().catch(() => null);
      const pats = await readPatterns(x, st.project + 1).catch((e) => (log("warn", `Could not read patterns: ${(e as Error).message}`), null));
      batch(() => {
        // Drafts belong to the project they were made in (status may already show the new project: compare with the one read last).
        // On opening a project, its drafts come back from the browser — those whose SP file is still the one they started from.
        if (loadedProject !== st.project) {
          if (loadedProject !== null) prevProject1 = loadedProject + 1;
          editingSlot.value = null;
          if (pats) {
            const files = patternFiles.value;
            const r = restoreDrafts(st.project + 1, (slot) => {
              const p = pats.get(slot), f = files.get(slot);
              return p && typeof p !== "string" && f ? { p, sum: fileSum(f.bytes) } : null;
            }, (slot) => !pats.has(slot));
            drafts.value = r.map;
            draftsProject.value = st.project + 1;
            if (r.map.size) log("info", `Pattern drafts restored from browser: ${[...r.map.keys()].map(padName).join(", ")}`);
            if (r.stale.length) log("warn", `Drafts ${r.stale.map(padName).join(", ")} discarded: the patterns on SP have changed since they were saved`);
          } else {
            drafts.value = new Map();
            draftsProject.value = null; // patterns not read: keep what the browser has for later
          }
        }
        loadedProject = st.project;
        status.value = st;
        project.value = ps;
        pads.value = blocks;
        picked.value = new Set();
        freeKb.value = kb;
        patterns.value = pats;
        waveforms.value = new Map();
        padChannels.value = new Map();
        if (first) {
          selectedBank.value = st.bank;
          selectedPad.value = st.bank * 16 + st.pad;
        }
      });
      log("info", `Project ${st.project + 1} “${ps.name || ps.names[st.project]}”: ${blocks.filter((b) => b.size).length} samples${pats ? `, patterns ${pats.size}` : ""}`);
    });
    if (device === d) conn.value = "ready";
    loadWaveformIfSmall(selectedPad.value);
  } catch (e) {
    if (device === d) {
      fail(e, "Read SP");
      conn.value = "ready";
    }
  } finally {
    if (device === d) projectSwitching.value = null;
  }
}

export function scheduleReload(ms: number): void {
  if (reloadTimer) clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    reloadTimer = null;
    // Pattern writers reload explicitly after the entire batch, including partial writes.
    if (device && !importing.value && !patternWriting.value) loadAll();
  }, ms);
}

export const reload = () => device && loadAll();

/**
 * Switch the SP to another project (1-based) and read it once loaded. The unit needs a moment:
 * pad blocks read empty meanwhile, so wait for its `1A` notification or 2.5 s (report §0).
 */
export async function selectProject(p1: number): Promise<void> {
  const d = device;
  if (!d || importing.value || p1 === project1.value) return;
  try {
    await d.exclusive((x) => x.selectProject(p1));
    batch(() => {
      if (status.value) status.value = { ...status.value, project: p1 - 1 }; // the poll should not take it for a change made on the SP
      playing.value = null;
      conn.value = "loading";
      loadProgress.value = 0;
      projectSwitching.value = p1;
    });
    log("info", `Selected project ${p1} — waiting for SP to load it`);
    scheduleReload(2500);
  } catch (e) {
    fail(e, "Switch project");
  }
}

async function poll(): Promise<void> {
  const d = device;
  if (!d || conn.value !== "ready") return;
  try {
    const st = await d.tryExclusive((x) => x.status());
    if (!st || device !== d) return;
    const prev = status.value;
    status.value = st;
    if (prev && prev.project !== st.project) {
      log("info", `SP selected project ${st.project + 1} — waiting for it to load`);
      projectSwitching.value = st.project + 1;
      // Pad blocks read empty while the device is still loading a project (report §0).
      scheduleReload(2500);
    }
  } catch {
    /* a missed poll is not worth reporting; a dead link reports itself via onLost */
  }
}

// ------------------------------------------------------------------ patterns

/** A pattern slot as read: the pattern, or why its file could not be read. */
export type PatternSlot = Pattern | string;
/** Patterns of the current project by slot (0..159); null until read. */
export const patterns = signal<Map<number, PatternSlot> | null>(null);
export const patternsLoading = signal(false);

/**
 * The files the patterns were read from, by slot: what a write starts from (writePattern keeps
 * every record it does not change), and `exact` — our writer gives this file back byte for byte.
 */
export const patternFiles = signal<ReadonlyMap<number, { bytes: Uint8Array; exact: boolean }>>(new Map());

/** Every pattern file in the project's PTN/ folder: one listing, then one small read per file. */
async function readPatterns(x: SP404Device, p1: number): Promise<Map<number, PatternSlot>> {
  const out = new Map<number, PatternSlot>(), files = new Map<number, { bytes: Uint8Array; exact: boolean }>();
  const slots = (await x.listDir(patternDir(p1))).flatMap((e) => (e.dir ? [] : [slotOfFileName(e.name)])).filter((s): s is number => s !== null).sort((a, b) => a - b);
  for (const slot of slots) {
    const bytes = await x.readFile(patternPath(p1, slot));
    try {
      if (!bytes) throw new Error("file disappeared");
      const p = parsePattern(bytes), again = writePattern(p, bytes);
      out.set(slot, p);
      files.set(slot, { bytes, exact: again.length === bytes.length && again.every((b, i) => b === bytes[i]) });
    } catch (e) {
      out.set(slot, (e as Error).message);
      log("warn", `Pattern ${padName(slot)}: ${(e as Error).message}`);
    }
  }
  patternFiles.value = files;
  reportPatternFiles(files);
  return out;
}

/**
 * Into the log: does our writer give every file back byte for byte (it must: writing depends on
 * it), and how close is a file laid out from scratch to the SP's own (it tells what the SP puts
 * in its files that we do not model).
 */
function reportPatternFiles(files: ReadonlyMap<number, { bytes: Uint8Array; exact: boolean }>): void {
  if (!files.size) return;
  const bad = [...files].filter(([, f]) => !f.exact).map(([s]) => padName(s));
  if (bad.length) log("warn", `Patterns: our encoder does not reproduce SP's file for ${bad.join(", ")} — edits to these patterns cannot be written to SP`);
  else log("info", `Patterns: all ${files.size} files are reproduced byte-for-byte by our encoder`);
  const diffs = [...files].map(([s, f]) => ({ s, d: rebuildDiff(f.bytes) }));
  const same = diffs.filter((x) => x.d.same).length;
  log("debug", `Patterns built from scratch: ${same} of ${files.size} match SP's files`);
  for (const { s, d } of diffs.filter((x) => !x.d.same).slice(0, 4)) log("debug", `  ${padName(s)}: writing ${d.record}: SP ${d.sp} · ours ${d.ours}`);
}

/** A pattern being saved (what and at which stage), for the buttons. */
export const patternWriting = signal<string | null>(null);

/** Same 64-bar limit as the device and the pattern editor. */
export const SAVE_MAX_BARS = MAX_BARS;
/** Projects saved into in this session after the user confirmed it once: no question again. */
const trustedProjects = new Set<number>();
/** The slot whose first save into this project waits for the user's yes. */
export const saveConfirm = signal<number | null>(null);

/** Where the SP goes for a moment so that it reads the open project again: the project used before, or project 1 (2). */
export const reloadVia = (): number => {
  const cur = project1.value;
  return prevProject1 && prevProject1 !== cur ? prevProject1 : cur === 1 ? 2 : 1;
};

/** Why the draft of `slot` cannot be saved now, or null. */
/** The SP file a new pattern is written over as a template (its skeleton only): the first one our writer reproduces. */
export function patternTemplate(): { slot: number; bytes: Uint8Array; p: Pattern } | null {
  for (const [slot, f] of patternFiles.value) {
    const p = patterns.value?.get(slot);
    if (f.exact && p && typeof p !== "string") return { slot, bytes: f.bytes, p };
  }
  return null;
}

/** An empty pattern of `bars` bars, in the template's time signature (4/4 without one). */
export function emptyPattern(bars: number): Pattern {
  const t = patternTemplate(), bpb = t?.p.beatsPerBar ?? 4;
  return { notes: [], controls: [], length: bars * bpb * PPQ, bars, beatsPerBar: bpb, unknown: 0, records: t?.p.records ?? 0 };
}

/**
 * The file of `slot` as it is now: the SP's own, or with the draft's edits written over it. Null when
 * the SP's file is not read or our writer does not reproduce it (then it is not copied).
 */
export function currentPatternFile(slot: number): Uint8Array | null {
  const f = patternFiles.value.get(slot), d = draftOf(slot);
  if (d?.source) return isDirty(d) || d.p !== d.base ? writePattern(d.p, d.source) : d.source;
  if (!f || !f.exact) return null;
  return d && isDirty(d) ? writePattern(d.p, f.bytes) : f.bytes;
}

/**
 * Silence pads that play on after their note-off: Gate off (and Loop) pads ignore note-off, and
 * neither MIDI All Sound Off / All Notes Off nor `9D` stops them (checked on the SP). What works
 * is the pad stop the inspector uses (SP404Device.stopPad: Gate on, press and release, Gate off).
 */
export async function silencePads(list: number[]): Promise<void> {
  const d = device;
  if (!d || conn.value !== "ready" || !list.length) return;
  try {
    await d.exclusive(async (x) => { for (const pad of list) setPad(await x.stopPad(project1.value, pad)); });
    log("info", `Stop pattern: muted ${list.map(padName).join(", ")} (Gate off)`);
  } catch (e) {
    fail(e, "Stop pattern pads");
  }
}

/** How long pad `pad` sounds after a hit, in ms (Infinity with Loop), at the tempo of its bank. */
export function padSoundMs(pad: number): number {
  const b = pads.value[pad];
  if (!b?.size) return 0;
  if (b.loop) return Infinity;
  const ch = padChannels.value.get(pad)?.channels ?? 1; // unknown: take mono, the longer guess
  const ratio = padSpeed(b, tempoFor(pad >> 4)?.tempoX100 ?? 12000).ratio || 1;
  return ((b.endByte - b.startByte) / (2 * ch) / 48000 / ratio) * 1000;
}

/** Whether `slot` holds no pattern on the SP (a draft there is a new pattern). */
export const isNewSlot = (slot: number): boolean => !!patterns.value && !patterns.value.has(slot);

export function saveBlockReason(slot: number): string | null {
  const f = patternFiles.value.get(slot), draft = draftOf(slot), base = patterns.value?.get(slot);
  if (demo.value) return "Demo mode: SP is not connected";
  if (!device || conn.value !== "ready") return "SP is not connected";
  if (patternWriting.value) return `Writing in progress: ${patternWriting.value}`;
  if (!draft || !isDirty(draft)) return "No changes";
  if (draft.source) {
    // A copy: written over its source file, which our writer reproduced when the copy was made.
  } else if (isNewSlot(slot)) {
    if (!patternTemplate()) return "A reference is required: the project must contain at least one pattern recorded on SP";
    if (!draft.p.notes.length) return "Pattern is empty";
  } else {
    if (!f) return "This pattern file has not been read from SP";
    if (!f.exact) return "Our encoder does not reproduce this SP file: saving it would be unsafe";
  }
  const was = base && typeof base !== "string" ? base.bars : 0;
  if (draft.p.bars > Math.max(SAVE_MAX_BARS, was)) return `Pattern length exceeds ${Math.max(SAVE_MAX_BARS, was)} bars`;
  return writeBlockReason.value;
}

/** Save the draft of `slot` to the SP; the first time in a project this session, after a confirmation. */
export function requestSave(slot: number): void {
  if (saveBlockReason(slot)) return;
  if (trustedProjects.has(project1.value)) void savePattern(slot);
  else saveConfirm.value = slot;
}

export function confirmSave(yes: boolean): void {
  const slot = saveConfirm.value;
  saveConfirm.value = null;
  if (!yes || slot === null) return;
  trustedProjects.add(project1.value);
  void savePattern(slot);
}

/**
 * Save the edited pattern into the project open on the SP: write its file (every record we did not
 * change kept as the SP wrote it), then the SP leaves the project for a moment and comes back to
 * read it again (checked on the SP: the edit plays). Then the project is read here too and the
 * draft, now on the SP, is closed.
 */
async function savePattern(slot: number): Promise<boolean> {
  const reason = saveBlockReason(slot);
  if (reason) { notice.value = { kind: "error", text: `${padName(slot)}: ${reason}` }; return false; }
  const d = device!, draft = draftOf(slot)!, p1 = project1.value, via = reloadVia(), fresh = isNewSlot(slot);
  // An existing pattern: its own file, every record we did not change kept. A new one: over a template's skeleton.
  const bytes = draft.source ? writePattern(draft.p, draft.source)
    : fresh ? writePattern(draft.p, patternTemplate()!.bytes, { fresh: true }) : writePattern(draft.p, patternFiles.value.get(slot)!.bytes);
  const what = `${padName(slot)} to project ${p1}${draft.source ? " (copy)" : fresh ? " (new)" : ""}`;
  patternWriting.value = what;
  try {
    const r = await d.exclusive((x) => x.writePatternAndReload(p1, slot, bytes, via, (s) => (patternWriting.value = `${what}: ${s}`)));
    if (r.kept) {
      log("info", `Pattern saved: ${what} (${bytes.length} bytes); SP reloaded the project via project ${via}`);
      notice.value = { kind: "info", text: `Saved to SP: ${padName(slot)}` };
      if (editingSlot.value === slot) editingSlot.value = null;
      dropDraft(slot);
    } else {
      log("warn", `${what}: after returning to the project, the file differs — SP overwrote it with its own copy`);
      notice.value = { kind: "error", text: `${what}: SP overwrote our pattern with its own copy while switching projects. The draft is kept` };
    }
    patternWriting.value = `${what}: reading the project back`;
    await loadAll();
    return r.kept;
  } catch (e) {
    fail(e, `Save pattern ${what}`);
    void loadAll();
    return false;
  } finally {
    patternWriting.value = null;
  }
}

/** Export has already been requested by the user; create only unoccupied pattern slots. */
export async function createLoopPatterns(items: readonly { slot: number; bytes: Uint8Array }[], onStep: (what: string) => void,
  shouldStop: () => boolean): Promise<{ done: number; kept: boolean; cancelled: boolean }> {
  if (patterns.value === null || items.some(({ slot }) => patterns.value!.has(slot) || drafts.value.has(slot)))
    throw new Error("Pattern slots changed — refresh the export layout");
  const p1 = project1.value;
  patternWriting.value = "Creating loop patterns";
  try {
    if (demo.value) {
      const next = new Map(patterns.value), files = new Map(patternFiles.value);
      let done = 0;
      for (const { slot, bytes } of items) {
        if (shouldStop()) break;
        next.set(slot, parsePattern(bytes)); files.set(slot, { bytes, exact: true }); done++;
      }
      patterns.value = next; patternFiles.value = files;
      return { done, kept: true, cancelled: shouldStop() };
    }
    const result = await withDevice((d) => d.writePatternsAndReload(p1, items, reloadVia(), (what) => {
      patternWriting.value = what; onStep(what);
    }, shouldStop));
    onStep("Reading the project back");
    await loadAll();
    if (!result.kept) throw new Error("SP changed the pattern files while reloading the project");
    return result;
  } catch (e) {
    // Show partial writes too, so the next export cannot reuse those slots.
    if (!demo.value) await loadAll().catch(() => {});
    throw e;
  } finally { patternWriting.value = null; }
}

/** Read the patterns again (they change when one is recorded on the SP). */
export async function refreshPatterns(): Promise<Map<number, PatternSlot> | null> {
  const d = device, p1 = project1.value;
  if (!d || conn.value !== "ready" || patternsLoading.value) return null;
  patternsLoading.value = true;
  try {
    const m = await d.exclusive((x) => readPatterns(x, p1));
    if (device === d && project1.value === p1) patterns.value = m;
    return m;
  } catch (e) {
    fail(e, "Read patterns");
    return null;
  } finally {
    patternsLoading.value = false;
  }
}

/** For each pad: the pattern slots that play it. */
export const patternUse = computed(() => {
  const m = new Map<number, number[]>();
  for (const [slot, p] of patterns.value ?? []) if (typeof p !== "string") for (const pad of patternPads(p)) m.set(pad, [...(m.get(pad) ?? []), slot]);
  return m;
});
export const patternsOf = (pad: number): number[] => patternUse.value.get(pad) ?? [];

/** Save a pattern as a MIDI file, as the SP's own export, but with the tempo that plays now (project or bank). */
export function downloadPatternMidi(slot: number): void {
  const p = draftOf(slot)?.p ?? patterns.value?.get(slot), t = tempoFor(slot >> 4);
  if (!p || typeof p === "string" || !t) return;
  const name = patternMidiName(project1.value, slot);
  saveFile(name, patternToMidi(p, t.tempoX100), "audio/midi");
  log("info", `Pattern ${padName(slot)} → ${name} (${formatBpm(t.tempoX100)} BPM ${t.of})`);
}

/** A bounce in progress: the slot and the SP's progress 0..1. */
export const bouncing = signal<{ slot: number; progress: number } | null>(null);

/**
 * Bounce a pattern: the SP plays it in real time and sends the WAV back (nothing is written on
 * the SP). Returns the WAV, or null when it failed (reported).
 */
export async function bouncePattern(slot: number): Promise<Uint8Array | null> {
  const d = device;
  const blocked = writeBlockReason.value ?? (importing.value ? "Import in progress — wait for it to finish" : bouncing.value ? "Bounce is already running" : null);
  if (!d) return null;
  if (blocked) return void (notice.value = { kind: "error", text: blocked }), null;
  bouncing.value = { slot, progress: 0 };
  const t0 = performance.now();
  try {
    const wav = await d.exclusive((x) => x.bouncePattern(project1.value, slot, (f) => (bouncing.value = { slot, progress: f })));
    log("info", `Bounce ${padName(slot)}: ${(wav.length / 1048576).toFixed(2)} MB in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    return wav;
  } catch (e) {
    fail(e, `Bounce ${padName(slot)}`);
    return null;
  } finally {
    bouncing.value = null;
  }
}

/**
 * After a move or swap: read the patterns again and say what became of those that played the
 * moved pads (whether the SP rewrites them is not known yet; this shows it).
 */
async function reportPatternsAfterMove(src: number, dst: number, swapped: boolean): Promise<void> {
  const before = new Map([[src, patternsOf(src)], [dst, patternsOf(dst)]]);
  if (!before.get(src)!.length && !before.get(dst)!.length) return;
  const after = await refreshPatterns();
  if (!after) return;
  const plays = (slot: number, pad: number) => { const p = after.get(slot); return !!p && typeof p !== "string" && p.notes.some((n) => n.pad === pad); };
  for (const [from, to] of [[src, dst], ...(swapped ? [[dst, src]] : [])]) {
    const slots = before.get(from)!;
    if (!slots.length) continue;
    const followed = slots.filter((s) => !plays(s, from) && plays(s, to));
    const stayed = slots.filter((s) => plays(s, from));
    if (followed.length) log("info", `Patterns ${followed.map(padName).join(", ")}: SP moved notes from ${padName(from)} to ${padName(to)}`);
    if (stayed.length) log("warn", `Patterns ${stayed.map(padName).join(", ")} still play ${padName(from)}${swapped ? ` (now contains the sample from ${padName(to)})` : " (now empty)"}`);
  }
}

// ------------------------------------------------------------------ selection & waveform

let selectTimer: ReturnType<typeof setTimeout> | null = null;

export function selectPad(pad: number): void {
  batch(() => {
    selectedPad.value = pad;
    selectedBank.value = pad >> 4;
  });
  // Keep the unit on the same pad, like the official app (debounced for quick clicking).
  if (selectTimer) clearTimeout(selectTimer);
  selectTimer = setTimeout(() => {
    const d = device, st = status.value;
    if (!d || conn.value !== "ready" || (st && st.bank * 16 + st.pad === pad)) return;
    d.exclusive((x) => x.selectOnDevice(pad))
      .then(() => { if (status.value) status.value = { ...status.value, bank: pad >> 4, pad: pad & 15 }; })
      .catch((e) => log("warn", `Select pad on SP: ${(e as Error).message}`));
  }, 120);
  loadWaveformIfSmall(pad);
}

const waveKey = (b: PadBlock) => `${b.size}:${b.name}`;

function loadWaveformIfSmall(pad: number): void {
  const b = pads.value[pad];
  if (!b?.size || waveforms.value.get(pad)?.key === waveKey(b)) return;
  if (b.size <= AUTO_WAVE_MAX_BYTES) loadWaveform(pad);
  else loadChannels(pad);
}

export async function loadWaveform(pad: number): Promise<void> {
  const d = device, b = pads.value[pad];
  if (!d || !b?.size || waveLoading.value) return;
  waveLoading.value = { pad, progress: 0 };
  try {
    const smp = await d.exclusive((x) => x.readFile(samplePath(project1.value, pad), Infinity, (done, total) => (waveLoading.value = { pad, progress: done / total })));
    const pcm = smp && smpToPcm(smp);
    if (!pcm) throw new Error("sample file not found");
    setWaveform(pad, b, pcm.samples, pcm.channels);
  } catch (e) {
    fail(e, `Waveform ${padName(pad)}`);
  } finally {
    waveLoading.value = null;
  }
}

function setWaveform(pad: number, b: PadBlock, samples: Int16Array, channels: number): void {
  const m = new Map(waveforms.value);
  m.delete(pad); // re-insert so the map stays in age order
  m.set(pad, {
    key: waveKey(b), peaks: computePeaks(samples, channels, WAVE_POINTS), envelope: computeEnvelope(samples, channels),
    channels, frames: samples.length / channels, samples,
  });
  let keep = SAMPLE_CACHE;
  for (const [k, w] of [...m].reverse()) if (w.samples && --keep < 0) m.set(k, { ...w, samples: undefined });
  batch(() => {
    waveforms.value = m;
    rememberChannels(pad, b, channels);
  });
}

function rememberChannels(pad: number, b: PadBlock, channels: number): void {
  const m = new Map(padChannels.value);
  m.set(pad, { key: waveKey(b), channels });
  padChannels.value = m;
}

/** Channels of the selected pad's sample, as far as known; Start/End need it to convert bytes to frames. */
export const channelsOf = (pad: number): number | null => {
  const b = pads.value[pad], c = padChannels.value.get(pad);
  return b?.size && c?.key === waveKey(b) ? c.channels : null;
};

/** Read just the 512-byte SMP header when the sample is too big to load its waveform on its own. */
async function loadChannels(pad: number): Promise<void> {
  const d = device, b = pads.value[pad];
  if (!d || !b?.size || channelsOf(pad) !== null) return;
  try {
    const ch = await d.exclusive((x) => x.sampleChannels(project1.value, pad));
    const now = pads.value[pad];
    if (now && waveKey(now) === waveKey(b)) rememberChannels(pad, now, ch);
  } catch (e) {
    log("warn", `${padName(pad)}: ${(e as Error).message}`);
  }
}

// ------------------------------------------------------------------ writing

function setPad(block: PadBlock): void {
  const next = [...pads.value];
  next[block.index] = block;
  pads.value = next;
}

/** Drag type of a pad dragged within the app; the data is its index. */
export const PAD_DRAG = "application/x-nexus-pad";
/** The pad being dragged in the grid (drop targets elsewhere can't read the drag data until drop). */
export const draggedPad = signal<number | null>(null);

/** Ctrl held while a pad is dragged: the drop copies instead of moving. */
export const dragCopy = signal(false);
/** A copy in progress: shown on the destination pad (read, then write: 0..1). */
export const copying = signal<{ src: number; dst: number; progress: number } | null>(null);

/** The bank under the pointer while a pad is dragged (a bank tile or a pad of the grid). */
export const dragOverBank = signal<number | null>(null);

export function endPadDrag(): void {
  batch(() => { draggedPad.value = null; dragOverBank.value = null; dragCopy.value = false; groupDrop.value = null; });
}

/** The tempo a pad in `bank` plays to: the project's, or the bank's when Tempo Select is on banks. */
export function tempoFor(bank: number): { tempoX100: number; of: string } | null {
  const ps = project.value, b = ps?.banks[bank];
  if (!ps) return null;
  return ps.useProjectTempo || !b ? { tempoX100: ps.projectTempoX100, of: "project" } : { tempoX100: b.tempoX100, of: `bank ${b.letter}` };
}

/**
 * How moving pad `src` into `bank` changes its speed: only with BPM Sync on and bank tempos in use,
 * when the two banks' tempos differ. Null when it plays as before.
 */
export function moveSpeedChange(src: number, bank: number): { from: number; to: number; text: string } | null {
  const p = pads.value[src], a = tempoFor(src >> 4), b = tempoFor(bank);
  if (!p?.size || !p.bpmSync || !a || !b || bank === src >> 4) return null;
  const from = padSpeed(p, a.tempoX100).ratio, to = padSpeed(p, b.tempoX100).ratio;
  if (Math.abs(to / from - 1) < 0.005) return null;
  const st = 12 * Math.log2(to / from);
  const pitch = p.vinyl ? ` · with Vinyl ${st > 0 ? "higher" : "lower"} by ${Math.abs(st).toFixed(1)} st` : "";
  return { from, to, text: `${padName(src)}: ×${from.toFixed(2)} → ×${to.toFixed(2)} in bank ${BANKS[bank]} (${formatBpm(b.tempoX100)} BPM)${pitch}` };
}

/** First empty pad of a bank as last read, or null when the bank is full. */
export function firstEmptyPad(bank: number): number | null {
  for (let i = bank * 16; i < bank * 16 + 16; i++) if (!pads.value[i]?.size) return i;
  return null;
}

/**
 * Move a pad onto an empty pad, or swap two pads, on the SP (any banks of the current project).
 * Cached waveforms and channel counts travel with the samples.
 */
// ------------------------------------------------------------------ group selection

/** Pads picked for group actions (Ctrl-click, Shift-click, Ctrl+A): only pads with a sample, current project. */
export const picked = signal<ReadonlySet<number>>(new Set());
// Picked pads belong to one project: another project on the SP must never inherit them.
effect(() => { void project1.value; picked.value = new Set(); });
/** The group delete waits for confirmation above the grid. */
export const confirmGroupDelete = signal(false);
export const groupProgress = signal<{ done: number; total: number; verb: string } | null>(null);

export const pickedList = computed(() => [...picked.value].filter((i) => pads.value[i]?.size).sort((a, b) => a - b));

/** Ctrl-click toggles a pad (the selected one joins on the first pick); Shift-click adds the range from the selected pad (from the bank's first pad when that is in another bank). */
export function pickPad(pad: number, how: "toggle" | "range"): void {
  const n = new Set(picked.value), sel = selectedPad.value;
  if (how === "toggle") {
    if (!n.size && sel !== pad && pads.value[sel]?.size) n.add(sel);
    if (n.has(pad)) n.delete(pad);
    else if (pads.value[pad]?.size) n.add(pad);
  } else {
    const from = sel >> 4 === pad >> 4 ? sel : pad & ~15; // within the clicked pad's bank only
    for (let i = Math.min(from, pad); i <= Math.max(from, pad); i++) if (pads.value[i]?.size) n.add(i);
  }
  batch(() => {
    picked.value = n;
    confirmGroupDelete.value = false;
  });
  if (how === "toggle") selectPad(pad);
}

/** Ctrl+A: every pad with a sample in the bank. */
export function pickBank(bank: number): void {
  const n = new Set<number>();
  for (let i = bank * 16; i < bank * 16 + 16; i++) if (pads.value[i]?.size) n.add(i);
  batch(() => { picked.value = n; confirmGroupDelete.value = false; });
}

export function clearPicked(): void {
  batch(() => { picked.value = new Set(); confirmGroupDelete.value = false; });
}

/** Delete the picked pads one by one (confirmed by the user); stops at the first one that fails. */
export async function deletePicked(): Promise<void> {
  confirmGroupDelete.value = false;
  const list = pickedList.value;
  if (!list.length || groupProgress.value) return;
  let done = 0;
  groupProgress.value = { done, total: list.length, verb: "Deleting" };
  try {
    for (const pad of list) {
      if (!(await deletePad(pad))) break;
      done++;
      const n = new Set(picked.value);
      n.delete(pad);
      batch(() => { picked.value = n; groupProgress.value = { done, total: list.length, verb: "Deleting" }; });
    }
  } finally {
    groupProgress.value = null;
  }
  log(done === list.length ? "info" : "warn", done === list.length ? `Pads deleted: ${done}` : `Deleted ${done} of ${list.length}: stopped due to an error`);
}

/** The pads that travel with the dragged one: the picked group, when the drag starts on one of them. */
export const dragGroup = computed(() => {
  const d = draggedPad.value, list = pickedList.value;
  return d !== null && list.length > 1 && list.includes(d) ? list : null;
});
/** Pads a group drop would fill, highlighted while dragging. */
export const groupDrop = signal<number[] | null>(null);

/**
 * Where a group of `n` lands in `bank`: the pad `from` and the empty pads after it (like files
 * dropped on a pad), or the bank's first empty pads for a bank tile. Null when they don't fit.
 */
export function groupTargets(bank: number, from: number | null, n: number): number[] | null {
  const out: number[] = [];
  for (let i = from ?? bank * 16; i < bank * 16 + 16 && out.length < n; i++) if (!pads.value[i]?.size) out.push(i);
  return out.length === n ? out : null;
}

/** Move (or copy) the picked pads onto `targets`, in order, one by one; stops at the first that fails. */
export async function dropGroup(targets: number[], copy: boolean): Promise<void> {
  const list = pickedList.value;
  if (list.length !== targets.length || groupProgress.value) return;
  const verb = copy ? "Copying" : "Moving";
  let done = 0;
  groupProgress.value = { done, total: list.length, verb };
  try {
    for (let i = 0; i < list.length; i++) {
      if (!(await (copy ? copyPad(list[i], targets[i]) : movePad(list[i], targets[i], true)))) break;
      groupProgress.value = { done: ++done, total: list.length, verb };
    }
  } finally {
    groupProgress.value = null;
  }
  // Done: nothing stays picked. Stopped by an error: the pads not handled yet stay picked.
  picked.value = new Set(list.slice(done));
  const what = copy ? "Copied" : "Moved";
  log(done === list.length ? "info" : "warn", done === list.length ? `${what} pads: ${done}` : `${what} ${done} of ${list.length}: stopped due to an error`);
}

/** Pad whose deletion waits for the user's confirmation in the inspector header. */
export const confirmDelete = signal<number | null>(null);

/** Delete a pad's sample on the SP, for good (the user has confirmed it). */
export async function deletePad(pad: number): Promise<boolean> {
  confirmDelete.value = null;
  const d = device;
  const blocked = writeBlockReason.value ?? (importing.value ? "Import in progress — wait for it to finish" : null);
  if (!d) return false;
  if (blocked) {
    notice.value = { kind: "error", text: blocked };
    return false;
  }
  const name = pads.value[pad]?.name || "untitled";
  try {
    const b = await d.exclusive((x) => x.deletePad(project1.value, pad));
    const drop = <T,>(m: Map<number, T>) => { const n = new Map(m); n.delete(pad); return n; };
    batch(() => {
      setPad(b);
      waveforms.value = drop(waveforms.value);
      padChannels.value = drop(padChannels.value);
      if (playing.value === pad) playing.value = null;
    });
    log("info", `${padName(pad)}: deleted “${name}”`);
    return true;
  } catch (e) {
    fail(e, `Delete ${padName(pad)}`);
    return false;
  }
}

/** Copy a pad onto an empty one (Ctrl-drag): read its sample, import it there, copy the settings. */
export async function copyPad(src: number, dst: number): Promise<boolean> {
  const d = device;
  const blocked = writeBlockReason.value ?? (importing.value ? "Import in progress — wait for it to finish" : copying.value ? "Copy already in progress" : null);
  if (!d || src === dst) return false;
  if (blocked) {
    notice.value = { kind: "error", text: blocked };
    return false;
  }
  copying.value = { src, dst, progress: 0 };
  try {
    const r = await d.exclusive((x) => x.copyPad(project1.value, src, dst, (a, b) => (copying.value = { src, dst, progress: a / b })));
    batch(() => {
      setPad(r.block);
      const ch = padChannels.value.get(src);
      if (ch) padChannels.value = new Map(padChannels.value).set(dst, ch);
    });
    if (r.differs.length) log("warn", `${padName(src)} ⧉ ${padName(dst)}: copied, but these parameters differ: ${r.differs.join(", ")}`);
    else log("info", `${padName(src)} ⧉ ${padName(dst)}: copied “${r.block.name}”`);
    selectPad(dst);
    return true;
  } catch (e) {
    fail(e, `Copy ${padName(src)} → ${padName(dst)}`);
    return false;
  } finally {
    copying.value = null;
  }
}

export async function movePad(src: number, dst: number, onlyToEmpty = false): Promise<boolean> {
  const d = device;
  const blocked = writeBlockReason.value ?? (importing.value ? "Import in progress — wait for it to finish" : null);
  if (!d || src === dst) return false;
  if (blocked) {
    notice.value = { kind: "error", text: blocked };
    return false;
  }
  try {
    const r = await d.exclusive((x) => x.movePad(project1.value, src, dst, onlyToEmpty));
    const swap = <T,>(m: Map<number, T>) => {
      const n = new Map(m), a = m.get(src), b = m.get(dst);
      n.delete(src); n.delete(dst);
      if (a) n.set(dst, a);
      if (b && r.swapped) n.set(src, b);
      return n;
    };
    batch(() => {
      setPad(r.src);
      setPad(r.dst);
      waveforms.value = swap(waveforms.value);
      padChannels.value = swap(padChannels.value);
      if (playing.value === src || playing.value === dst) playing.value = null;
    });
    log("info", r.swapped ? `${padName(src)} ⇄ ${padName(dst)}: swapped` : `${padName(src)} → ${padName(dst)}: moved`);
    selectPad(dst);
    await reportPatternsAfterMove(src, dst, r.swapped);
    return true;
  } catch (e) {
    fail(e, `Move ${padName(src)} → ${padName(dst)}`);
    return false;
  }
}

/** Run one pad edit on the device and show the block it returns. */
async function editPad(pad: number, what: string, fn: (d: SP404Device, p1: number) => Promise<PadBlock>): Promise<boolean> {
  const d = device;
  if (!d) return false;
  try {
    const b = await d.exclusive((x) => fn(x, project1.value));
    setPad(b);
    log("info", `${padName(pad)}: ${what}`);
    return true;
  } catch (e) {
    fail(e, `${padName(pad)}, ${what}`);
    return false;
  }
}

/**
 * Apply one edit to every picked pad, one by one, with progress above the grid; stops at the first
 * error. `skip` leaves out pads that already have the value (nothing is sent to them).
 */
export async function editGroup(what: string, fn: (d: SP404Device, p1: number, pad: number) => Promise<PadBlock>, skip?: (b: PadBlock) => boolean): Promise<boolean> {
  const d = device, list = pickedList.value.filter((i) => !skip?.(pads.value[i]!));
  if (!d || groupProgress.value) return false;
  if (writeBlockReason.value) {
    notice.value = { kind: "error", text: writeBlockReason.value };
    return false;
  }
  if (!list.length) return true;
  let done = 0;
  groupProgress.value = { done, total: list.length, verb: "Updating" };
  try {
    for (const pad of list) {
      try {
        setPad(await d.exclusive((x) => fn(x, project1.value, pad)));
      } catch (e) {
        fail(e, `${padName(pad)}, ${what}`);
        if (done) log("warn", `${what}: updated ${done} of ${list.length}, stopped at ${padName(pad)}`);
        return false;
      }
      groupProgress.value = { done: ++done, total: list.length, verb: "Updating" };
    }
    log("info", `${what}: ${list.map(padName).join(", ")}`);
    return true;
  } finally {
    groupProgress.value = null;
  }
}

const onOff = (on: boolean) => (on ? "on" : "off");

export const setBpm = (pad: number, x100: number) => editPad(pad, `BPM ${(x100 / 100).toFixed(2)}`, (d, p1) => d.setBpm(p1, pad, x100));
export const setLevel = (pad: number, level: number) => editPad(pad, `Level ${level}`, (d, p1) => d.setLevel(p1, pad, level));
export const setGate = (pad: number, on: boolean) => editPad(pad, `Gate ${onOff(on)}`, (d, p1) => d.setGate(p1, pad, on));
export async function configureLoopPad(pad: number): Promise<boolean> {
  if (!demo.value) return editPad(pad, "Loop playback: Gate off, BPM Sync on, Vinyl off, Ensemble", (d, p1) => d.setLoopPlayback(p1, pad));
  const b = pads.value[pad];
  if (!b?.size) return false;
  const raw = b.raw.slice(), view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  for (const [field, value] of [[4, 0], [8, 1], [17, 0], [10, (b.flags & ~0x06) | 4]]) view.setUint32(3 + field * 4, value, true);
  setPad(parsePadBlock(raw));
  return true;
}
export const setLoop = (pad: number, on: boolean) => editPad(pad, `Loop ${onOff(on)}`, (d, p1) => d.setLoop(p1, pad, on));
export const setBpmSync = (pad: number, on: boolean) => editPad(pad, `BPM Sync ${onOff(on)}`, (d, p1) => d.setBpmSync(p1, pad, on));
export const setPadParam = (pad: number, id: number, value: number, what: string) => editPad(pad, what, (d, p1) => d.setPadParam(p1, pad, id, value));
export const setFixedVelocity = (pad: number, on: boolean) => editPad(pad, `Fixed Velocity ${onOff(on)}`, (d, p1) => d.setFixedVelocity(p1, pad, on));
export const setVinyl = (pad: number, on: boolean) => editPad(pad, `Vinyl ${onOff(on)}`, (d, p1) => d.setVinyl(p1, pad, on));
export const setTimeStretch = (pad: number, x100: number) =>
  editPad(pad, `Time Stretch ${(x100 / 100).toFixed(2)} %`, (d, p1) => d.setTimeStretch(p1, pad, x100));
export const setPitch = (pad: number, coarse: number, fine: number) =>
  editPad(pad, `Pitch ${coarse} st ${fine} ct`, (d, p1) => d.setPitch(p1, pad, coarse, fine));
export const setVari = (pad: number, mode: number) => editPad(pad, `VARI MODE ${VARI_MODES[mode]}`, (d, p1) => d.setVari(p1, pad, mode));
export const setOneShot = (pad: number, on: boolean) => editPad(pad, `One Shot ${onOff(on)}`, (d, p1) => d.setOneShot(p1, pad, on));
export const setRange = (pad: number, start: number, end: number) =>
  editPad(pad, `Start/End ${start}–${end} frames`, (d, p1) => d.setRange(p1, pad, start, end));

/** Run one project-wide edit (tempos) and show the settings it returns. */
async function editProject(what: string, fn: (d: SP404Device, p1: number) => Promise<ProjectSettings & { names: string[] }>): Promise<boolean> {
  const d = device;
  if (!d) return false;
  try {
    project.value = await d.exclusive((x) => fn(x, project1.value));
    log("info", `Project ${project1.value}: ${what}`);
    return true;
  } catch (e) {
    fail(e, `Project ${project1.value}, ${what}`);
    return false;
  }
}

const bpmText = (x100: number) => `${(x100 / 100).toFixed(2)} BPM`;
export const setProjectTempo = (x100: number) => editProject(`project tempo ${bpmText(x100)}`, (d, p1) => d.setProjectTempo(p1, x100));
export const setBankTempo = (bank: number, x100: number) =>
  editProject(`bank tempo ${padName(bank * 16)[0]} ${bpmText(x100)}`, (d, p1) => d.setBankTempo(p1, bank, x100));
export const setTempoSelect = (useProject: boolean) =>
  editProject(`active tempo: ${useProject ? "project" : "banks"}`, (d, p1) => d.setTempoSelect(p1, useProject));

/** Range of BPM detection, index into BPM_RANGES (80–159 by default), as BPM SET AUTO on the SP. */
export const bpmRange = signal(1);

/**
 * Detect the tempo of a pad's sample between Start and End, reading the sample from the SP when
 * its PCM is not cached. Null: no clear beat; undefined: could not read the sample.
 */
export async function detectPadBpm(pad: number): Promise<BpmResult | null | undefined> {
  const b = pads.value[pad];
  if (!b?.size) return undefined;
  const cached = () => { const w = waveforms.value.get(pad); return w?.key === waveKey(b) ? w : undefined; };
  if (!cached()?.samples) await loadWaveform(pad);
  const w = cached();
  if (!w?.samples) return undefined;
  const ch = w.channels, from = Math.round(byteToFrame(b.startByte, ch)), to = Math.round(byteToFrame(b.endByte, ch));
  await new Promise((r) => setTimeout(r, 0)); // let "анализ…" paint: a long sample takes up to a second
  const [min, max] = BPM_RANGES[bpmRange.value]!;
  const r = detectBpm(w.samples.subarray(from * ch, to * ch), ch, min);
  log("info", `${padName(pad)}: BPM ${r ? (r.x100 / 100).toFixed(2) + (r.beats ? `, loop ${r.beats} beats` : "") + `, clarity ${r.clarity.toFixed(2)}` : "Not detected"} (range ${min}–${max})`);
  return r;
}

/** A BPM worked out for one picked pad: `x100` null when there is none, with the reason in `note`. */
export interface BpmPlan { pad: number; from: number; x100: number | null; note: string }

/**
 * Work out a BPM for every picked pad, by sound ("Определить") or by Start/End ("По Start/End");
 * nothing is written: the user looks at the list first, then applyGroupBpm writes it.
 */
export async function planGroupBpm(how: "detect" | "range"): Promise<BpmPlan[] | null> {
  const list = pickedList.value;
  if (!list.length || groupProgress.value) return null;
  const verb = how === "detect" ? "Analyzing" : "Calculating";
  const out: BpmPlan[] = [];
  groupProgress.value = { done: 0, total: list.length, verb };
  try {
    for (const pad of list) {
      const b = pads.value[pad]!, from = b.bpmX100;
      if (how === "detect") {
        const r = await detectPadBpm(pad);
        out.push(r ? { pad, from, x100: r.x100, note: r.beats ? `${r.beats} beats` : r.clarity < 0.4 ? "unclear rhythm" : "" }
          : { pad, from, x100: null, note: r === null ? "no clear rhythm" : "sample not read" });
      } else {
        await loadChannels(pad);
        const ch = channelsOf(pad);
        const r = ch ? bpmFromLength(byteToFrame(b.endByte, ch) - byteToFrame(b.startByte, ch), from) : null;
        const beats = r && (r.beats >= 1 ? String(r.beats) : `1/${1 / r.beats}`);
        out.push(!ch ? { pad, from, x100: null, note: "sample header not read" }
          : !r ? { pad, from, x100: null, note: "region is too short" }
          : r.x100 < BPM_MIN_X100 || r.x100 > BPM_MAX_X100 ? { pad, from, x100: null, note: `result: ${formatBpm(r.x100)} — outside 40–200` }
          : { pad, from, x100: r.x100, note: `${beats} beats` });
      }
      groupProgress.value = { done: out.length, total: list.length, verb };
    }
  } finally {
    groupProgress.value = null;
  }
  return out;
}

/** Write the BPMs of a plan to the pads that got one and still have another BPM. */
export function applyGroupBpm(plan: BpmPlan[]): Promise<boolean> {
  const to = new Map(plan.flatMap((p) => (p.x100 === null ? [] : [[p.pad, p.x100] as const])));
  return editGroup("BPM for each pad", (d, p1, pad) => d.setBpm(p1, pad, to.get(pad)!), (b) => to.get(b.index) === undefined || to.get(b.index) === b.bpmX100);
}

/**
 * A pad's whole sample as interleaved PCM: from the waveform cache when its PCM is there, else read
 * from the SP. Null (with a notice) when it cannot be read.
 */
export async function padPcm(pad: number): Promise<{ samples: Int16Array; channels: number; frames: number } | null> {
  const b = pads.value[pad];
  if (!b?.size) return null;
  const cached = () => { const w = waveforms.value.get(pad); return w?.key === waveKey(b) && w.samples ? w : undefined; };
  if (!cached()) await loadWaveform(pad);
  const w = cached();
  if (!w?.samples) { notice.value = { kind: "error", text: `${padName(pad)}: could not read the sample` }; return null; }
  return { samples: w.samples, channels: w.channels, frames: w.frames };
}

/**
 * Save a pad's whole sample to the computer as a 48 kHz 16-bit WAV: from the waveform cache when
 * its PCM is there, else read from the SP. The BPM goes into the name, so importing the file
 * again picks it up.
 */
export async function downloadPadWav(pad: number): Promise<void> {
  const b = pads.value[pad];
  if (!b?.size) return;
  const w = await padPcm(pad);
  if (!w) return;
  const base = safeFileName(b.name || padName(pad));
  const name = bpmFromFileName(base) === null && b.bpmX100 >= 4000 && b.bpmX100 <= 20000 ? `${base}_${formatBpm(b.bpmX100)}bpm.wav` : `${base}.wav`;
  saveFile(name, encodeWav(w.samples, w.channels), "audio/wav");
  log("info", `${padName(pad)} → ${name} (${(w.frames / 48000).toFixed(2)} s, ${w.channels === 1 ? "mono" : "stereo"})`);
}

/** Pad started by preview that may still be playing (Gate off), for the stop button; null when none. */
export const playing = signal<number | null>(null);

export async function preview(pad: number, on: boolean): Promise<void> {
  const d = device;
  if (!d) return;
  try {
    await d.exclusive((x) => (on ? x.previewStart(pad) : x.previewStop(pad)));
    if (on) playing.value = pad;
    else if (pads.value[pad]?.gate) playing.value = null; // Gate on: the release has stopped it
  } catch (e) {
    fail(e, "Preview");
  }
}

/** Stop the pad left playing by preview, then select the app's pad on the unit again. */
export async function stopPlaying(): Promise<void> {
  const pad = playing.value;
  if (pad === null) return;
  playing.value = null;
  if (!(await editPad(pad, "stop", (d, p1) => d.stopPad(p1, pad)))) return;
  const sel = selectedPad.value;
  if (sel === pad) return;
  await device?.exclusive((x) => x.selectOnDevice(sel))
    .then(() => { if (status.value) status.value = { ...status.value, bank: sel >> 4, pad: sel & 15 }; })
    .catch((e) => log("warn", `Select pad on SP: ${(e as Error).message}`));
}

/** Free pads from `startPad` to the end of its bank, skipping pads already queued. */
/** Run `fn` with the device to itself (for modules beside the store, e.g. the card browser). */
export function withDevice<T>(fn: (d: SP404Device) => Promise<T>): Promise<T> {
  const d = device;
  if (!d || conn.value !== "ready") return Promise.reject(new Error("SP is not connected"));
  return d.exclusive(fn);
}

function targetPads(startPad: number, count: number): number[] {
  const out: number[] = [];
  for (let i = startPad; i < ((startPad >> 4) + 1) * 16 && out.length < count; i++)
    if (!pads.value[i]?.size && !reserved.has(i)) out.push(i);
  return out;
}

/** `bpmX100`: the BPM for these files when the caller knows it (a resample takes its source pad's), one for all or one per file. */
export function importFiles(files: File[], startPad: number, bpmX100?: number | (number | undefined)[]): void {
  const d = device;
  const audio = files.filter((f) => /^audio\//.test(f.type) || /\.(wav|aiff?|flac|mp3|ogg|m4a|aac)$/i.test(f.name));
  if (!audio.length) return void (notice.value = { kind: "error", text: "Drop audio files (WAV, AIFF, FLAC, MP3…)" });
  const block = writeBlockReason.value;
  if (!d || block) return void (notice.value = { kind: "error", text: block ?? "SP is not connected" });
  const bank = startPad >> 4;
  if (project.value?.banks[bank]?.protected) return void (notice.value = { kind: "error", text: `Bank ${padName(bank * 16)[0]} is protected (BANK Protect on SP)` });
  if (pads.value[startPad]?.size) return void (notice.value = { kind: "error", text: `${padName(startPad)} is occupied. Drop onto an empty pad — overwriting is not currently supported` });
  const targets = targetPads(startPad, audio.length);
  if (targets.length < audio.length)
    notice.value = { kind: "info", text: `The bank has room for ${targets.length} of ${audio.length} files — the rest were skipped` };
  else notice.value = null;
  const fallback = parseDefaultBpm();
  const detectMin = detectOnImport.value ? BPM_RANGES[bpmRange.value]![0] : null;
  const given = (i: number) => (Array.isArray(bpmX100) ? bpmX100[i] : bpmX100);
  const newJobs = targets.map((pad, i) => newJob(audio[i], pad, given(i) ?? bpmFromFileName(audio[i].name), fallback, detectMin, given(i) !== undefined ? "source" : "name"));
  void runJobs(d, newJobs).then((ok) => {
    if (ok < newJobs.length) notice.value = { kind: "error", text: `Imported ${ok} of ${newJobs.length} — details in the log` };
  });
}

/**
 * Files onto the pads given (each one empty, not queued, its bank not protected), each with its
 * BPM: loops laid out by the caller (the slicer's groups). Resolves with how many were imported.
 */
export function importToPads(items: { file: File; pad: number; bpmX100: number }[]): Promise<number> {
  const d = device, block = writeBlockReason.value;
  if (!d || block) return Promise.reject(new Error(block ?? "SP is not connected"));
  const taken = items.find(({ pad }) => pads.value[pad]?.size || reserved.has(pad) || project.value?.banks[pad >> 4]?.protected);
  if (taken) return Promise.reject(new Error(`${padName(taken.pad)} is not free`));
  return runJobs(d, items.map(({ file, pad, bpmX100 }) => newJob(file, pad, bpmX100, null, null, "source")));
}

/** Queue jobs after the imports before them; resolves with how many of them succeeded. */
function runJobs(d: SP404Device, newJobs: ImportJob[]): Promise<number> {
  newJobs.forEach((j) => reserved.add(j.pad));
  jobs.value = [...jobs.value.filter((j) => j.state !== "done"), ...newJobs];
  const p1 = project1.value;
  const uploader = new SampleUploader(d, {
    onJob: (job) => {
      jobs.value = jobs.value.map((j) => (j.id === job.id ? job : j));
      if (job.state === "done" || job.state === "error") reserved.delete(job.pad);
    },
    onPad: (b, a) => {
      setPad(b);
      setWaveform(b.index, b, a.samples, a.channels);
      if (selectedPad.value === b.index) selectPad(b.index);
    },
  }, (level, text) => log(level, text));
  const run = importChain.then(() => uploader.run(p1, newJobs));
  importChain = run.catch(() => 0);
  return run;
}

/** Demo mode only: a pad as if a sample had been imported onto it (no device behind it). */
export function placeDemoPad(b: PadBlock, samples: Int16Array, channels: number): void {
  if (!demo.value) return;
  setPad(b);
  setWaveform(b.index, b, samples, channels);
  if (selectedPad.value === b.index) selectPad(b.index);
}

function parseDefaultBpm(): number | null {
  const t = defaultBpm.value.trim().replace(",", ".");
  const x = Math.round(parseFloat(t) * 100);
  return t && x >= 4000 && x <= 20000 ? x : null;
}

export function clearFinishedJobs(): void {
  jobs.value = jobs.value.filter((j) => j.state !== "done" && j.state !== "error");
}
