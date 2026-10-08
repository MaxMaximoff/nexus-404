// App state (signals) and the controller that drives the device.

import { batch, computed, effect, signal } from "@preact/signals";
import { safeFileName, saveFile } from "./download";
import {
  PAD_COUNT, SP404Device, SampleUploader, WebSerialTransport, bpmFromFileName, computeEnvelope, computePeaks, isSp404Port,
  BANKS, encodeWav, BPM_MAX_X100, BPM_MIN_X100, BPM_RANGES, VARI_MODES, bpmFromLength, byteToFrame, detectBpm, formatBpm, newJob, padName, padSpeed, samplePath, smpToPcm,
  parsePattern, patternDir, patternMidiName, patternPads, patternPath, patternToMidi, slotOfFileName,
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
  if (conn.value !== "ready") return "SP не подключён";
  if (status.value && status.value.workingMode !== 0) return "SP показывает меню — закройте его на устройстве";
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
    fail(e, "Подключение");
    conn.value = "idle";
  }
}

export async function reconnect(silent = false): Promise<void> {
  const [port] = await WebSerialTransport.grantedPorts();
  if (!port) return silent ? undefined : connect();
  try {
    await openPort(port);
  } catch (e) {
    if (silent) log("info", `Автоподключение не удалось: ${(e as Error).message}`);
    else fail(e, "Переподключение");
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
    log("warn", `Связь потеряна: ${reason}`);
    teardown();
    conn.value = "lost";
  };
  try {
    await t.open();
  } catch (e) {
    throw new Error(`${(e as Error).message}. Порт занят? Закройте SP-404MKII App и другие вкладки`);
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
  });
  log("info", "Отключено");
}

if (WebSerialTransport.supported()) {
  navigator.serial.addEventListener("connect", (e) => {
    refreshGrant();
    const port = e.target as SerialPort;
    if (isSp404Port(port) && conn.value === "lost") {
      log("info", "SP снова подключён — переподключаюсь");
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
      const pats = await readPatterns(x, st.project + 1).catch((e) => (log("warn", `Паттерны не прочитаны: ${(e as Error).message}`), null));
      batch(() => {
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
      log("info", `Проект ${st.project + 1} «${ps.name || ps.names[st.project]}»: ${blocks.filter((b) => b.size).length} сэмплов${pats ? `, паттернов ${pats.size}` : ""}`);
    });
    if (device === d) conn.value = "ready";
    loadWaveformIfSmall(selectedPad.value);
  } catch (e) {
    if (device === d) {
      fail(e, "Чтение SP");
      conn.value = "ready";
    }
  }
}

export function scheduleReload(ms: number): void {
  if (reloadTimer) clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    reloadTimer = null;
    if (device && !importing.value) loadAll();
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
    });
    log("info", `Выбран проект ${p1} — жду, пока SP его загрузит`);
    scheduleReload(2500);
  } catch (e) {
    fail(e, "Смена проекта");
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
      log("info", `На SP выбран проект ${st.project + 1} — жду, пока он загрузится`);
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

/** Every pattern file in the project's PTN/ folder: one listing, then one small read per file. */
async function readPatterns(x: SP404Device, p1: number): Promise<Map<number, PatternSlot>> {
  const out = new Map<number, PatternSlot>();
  const slots = (await x.listDir(patternDir(p1))).flatMap((e) => (e.dir ? [] : [slotOfFileName(e.name)])).filter((s): s is number => s !== null).sort((a, b) => a - b);
  for (const slot of slots) {
    const bytes = await x.readFile(patternPath(p1, slot));
    try {
      if (!bytes) throw new Error("файл пропал");
      out.set(slot, parsePattern(bytes));
    } catch (e) {
      out.set(slot, (e as Error).message);
      log("warn", `Паттерн ${padName(slot)}: ${(e as Error).message}`);
    }
  }
  return out;
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
    fail(e, "Чтение паттернов");
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
  const p = patterns.value?.get(slot), t = tempoFor(slot >> 4);
  if (!p || typeof p === "string" || !t) return;
  const name = patternMidiName(project1.value, slot);
  saveFile(name, patternToMidi(p, t.tempoX100), "audio/midi");
  log("info", `Паттерн ${padName(slot)} → ${name} (${formatBpm(t.tempoX100)} BPM ${t.of})`);
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
    if (followed.length) log("info", `Паттерны ${followed.map(padName).join(", ")}: SP перевёл ноты ${padName(from)} на ${padName(to)}`);
    if (stayed.length) log("warn", `Паттерны ${stayed.map(padName).join(", ")} по-прежнему играют ${padName(from)}${swapped ? ` (там теперь сэмпл с ${padName(to)})` : " (он теперь пуст)"}`);
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
      .catch((e) => log("warn", `Выбор pad'а на SP: ${(e as Error).message}`));
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
    if (!pcm) throw new Error("файл сэмпла не найден");
    setWaveform(pad, b, pcm.samples, pcm.channels);
  } catch (e) {
    fail(e, `Волна ${padName(pad)}`);
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
  return ps.useProjectTempo || !b ? { tempoX100: ps.projectTempoX100, of: "проекта" } : { tempoX100: b.tempoX100, of: `банка ${b.letter}` };
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
  const pitch = p.vinyl ? ` · с Vinyl ${st > 0 ? "выше" : "ниже"} на ${Math.abs(st).toFixed(1)} st` : "";
  return { from, to, text: `${padName(src)}: ×${from.toFixed(2)} → ×${to.toFixed(2)} в банке ${BANKS[bank]} (${formatBpm(b.tempoX100)} BPM)${pitch}` };
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
  groupProgress.value = { done, total: list.length, verb: "Удаляю" };
  try {
    for (const pad of list) {
      if (!(await deletePad(pad))) break;
      done++;
      const n = new Set(picked.value);
      n.delete(pad);
      batch(() => { picked.value = n; groupProgress.value = { done, total: list.length, verb: "Удаляю" }; });
    }
  } finally {
    groupProgress.value = null;
  }
  log(done === list.length ? "info" : "warn", done === list.length ? `Удалено pad'ов: ${done}` : `Удалено ${done} из ${list.length}: остановлено на ошибке`);
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
  const verb = copy ? "Копирую" : "Переношу";
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
  const what = copy ? "Скопировано" : "Перенесено";
  log(done === list.length ? "info" : "warn", done === list.length ? `${what} pad'ов: ${done}` : `${what} ${done} из ${list.length}: остановлено на ошибке`);
}

/** Pad whose deletion waits for the user's confirmation in the inspector header. */
export const confirmDelete = signal<number | null>(null);

/** Delete a pad's sample on the SP, for good (the user has confirmed it). */
export async function deletePad(pad: number): Promise<boolean> {
  confirmDelete.value = null;
  const d = device;
  const blocked = writeBlockReason.value ?? (importing.value ? "Идёт импорт — дождитесь конца" : null);
  if (!d) return false;
  if (blocked) {
    notice.value = { kind: "error", text: blocked };
    return false;
  }
  const name = pads.value[pad]?.name || "без имени";
  try {
    const b = await d.exclusive((x) => x.deletePad(project1.value, pad));
    const drop = <T,>(m: Map<number, T>) => { const n = new Map(m); n.delete(pad); return n; };
    batch(() => {
      setPad(b);
      waveforms.value = drop(waveforms.value);
      padChannels.value = drop(padChannels.value);
      if (playing.value === pad) playing.value = null;
    });
    log("info", `${padName(pad)}: удалён «${name}»`);
    return true;
  } catch (e) {
    fail(e, `Удаление ${padName(pad)}`);
    return false;
  }
}

/** Copy a pad onto an empty one (Ctrl-drag): read its sample, import it there, copy the settings. */
export async function copyPad(src: number, dst: number): Promise<boolean> {
  const d = device;
  const blocked = writeBlockReason.value ?? (importing.value ? "Идёт импорт — дождитесь конца" : copying.value ? "Уже идёт копирование" : null);
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
    if (r.differs.length) log("warn", `${padName(src)} ⧉ ${padName(dst)}: скопирован, но отличаются параметры ${r.differs.join(", ")}`);
    else log("info", `${padName(src)} ⧉ ${padName(dst)}: скопирован «${r.block.name}»`);
    selectPad(dst);
    return true;
  } catch (e) {
    fail(e, `Копирование ${padName(src)} → ${padName(dst)}`);
    return false;
  } finally {
    copying.value = null;
  }
}

export async function movePad(src: number, dst: number, onlyToEmpty = false): Promise<boolean> {
  const d = device;
  const blocked = writeBlockReason.value ?? (importing.value ? "Идёт импорт — дождитесь конца" : null);
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
    log("info", r.swapped ? `${padName(src)} ⇄ ${padName(dst)}: поменялись местами` : `${padName(src)} → ${padName(dst)}: перенесён`);
    selectPad(dst);
    await reportPatternsAfterMove(src, dst, r.swapped);
    return true;
  } catch (e) {
    fail(e, `Перенос ${padName(src)} → ${padName(dst)}`);
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
  groupProgress.value = { done, total: list.length, verb: "Меняю" };
  try {
    for (const pad of list) {
      try {
        setPad(await d.exclusive((x) => fn(x, project1.value, pad)));
      } catch (e) {
        fail(e, `${padName(pad)}, ${what}`);
        if (done) log("warn", `${what}: изменено ${done} из ${list.length}, остановлено на ${padName(pad)}`);
        return false;
      }
      groupProgress.value = { done: ++done, total: list.length, verb: "Меняю" };
    }
    log("info", `${what}: ${list.map(padName).join(", ")}`);
    return true;
  } finally {
    groupProgress.value = null;
  }
}

const onOff = (on: boolean) => (on ? "вкл" : "выкл");

export const setBpm = (pad: number, x100: number) => editPad(pad, `BPM ${(x100 / 100).toFixed(2)}`, (d, p1) => d.setBpm(p1, pad, x100));
export const setLevel = (pad: number, level: number) => editPad(pad, `Level ${level}`, (d, p1) => d.setLevel(p1, pad, level));
export const setGate = (pad: number, on: boolean) => editPad(pad, `Gate ${onOff(on)}`, (d, p1) => d.setGate(p1, pad, on));
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
  editPad(pad, `Start/End ${start}–${end} кадров`, (d, p1) => d.setRange(p1, pad, start, end));

/** Run one project-wide edit (tempos) and show the settings it returns. */
async function editProject(what: string, fn: (d: SP404Device, p1: number) => Promise<ProjectSettings & { names: string[] }>): Promise<boolean> {
  const d = device;
  if (!d) return false;
  try {
    project.value = await d.exclusive((x) => fn(x, project1.value));
    log("info", `Проект ${project1.value}: ${what}`);
    return true;
  } catch (e) {
    fail(e, `Проект ${project1.value}, ${what}`);
    return false;
  }
}

const bpmText = (x100: number) => `${(x100 / 100).toFixed(2)} BPM`;
export const setProjectTempo = (x100: number) => editProject(`темп проекта ${bpmText(x100)}`, (d, p1) => d.setProjectTempo(p1, x100));
export const setBankTempo = (bank: number, x100: number) =>
  editProject(`темп банка ${padName(bank * 16)[0]} ${bpmText(x100)}`, (d, p1) => d.setBankTempo(p1, bank, x100));
export const setTempoSelect = (useProject: boolean) =>
  editProject(`действует темп ${useProject ? "проекта" : "банков"}`, (d, p1) => d.setTempoSelect(p1, useProject));

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
  log("info", `${padName(pad)}: BPM ${r ? (r.x100 / 100).toFixed(2) + (r.beats ? `, луп ${r.beats} долей` : "") + `, чёткость ${r.clarity.toFixed(2)}` : "не определён"} (диапазон ${min}–${max})`);
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
  const verb = how === "detect" ? "Анализирую" : "Считаю";
  const out: BpmPlan[] = [];
  groupProgress.value = { done: 0, total: list.length, verb };
  try {
    for (const pad of list) {
      const b = pads.value[pad]!, from = b.bpmX100;
      if (how === "detect") {
        const r = await detectPadBpm(pad);
        out.push(r ? { pad, from, x100: r.x100, note: r.beats ? `${r.beats} долей` : r.clarity < 0.4 ? "ритм нечёткий" : "" }
          : { pad, from, x100: null, note: r === null ? "чёткого ритма нет" : "сэмпл не прочитан" });
      } else {
        await loadChannels(pad);
        const ch = channelsOf(pad);
        const r = ch ? bpmFromLength(byteToFrame(b.endByte, ch) - byteToFrame(b.startByte, ch), from) : null;
        const beats = r && (r.beats >= 1 ? String(r.beats) : `1/${1 / r.beats}`);
        out.push(!ch ? { pad, from, x100: null, note: "заголовок сэмпла не прочитан" }
          : !r ? { pad, from, x100: null, note: "слишком короткий участок" }
          : r.x100 < BPM_MIN_X100 || r.x100 > BPM_MAX_X100 ? { pad, from, x100: null, note: `выходит ${formatBpm(r.x100)} — вне 40–200` }
          : { pad, from, x100: r.x100, note: `${beats} долей` });
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
  return editGroup("BPM по каждому pad'у", (d, p1, pad) => d.setBpm(p1, pad, to.get(pad)!), (b) => to.get(b.index) === undefined || to.get(b.index) === b.bpmX100);
}

/**
 * Save a pad's whole sample to the computer as a 48 kHz 16-bit WAV: from the waveform cache when
 * its PCM is there, else read from the SP. The BPM goes into the name, so importing the file
 * again picks it up.
 */
export async function downloadPadWav(pad: number): Promise<void> {
  const b = pads.value[pad];
  if (!b?.size) return;
  const cached = () => { const w = waveforms.value.get(pad); return w?.key === waveKey(b) && w.samples ? w : undefined; };
  if (!cached()) await loadWaveform(pad);
  const w = cached();
  if (!w?.samples) return void (notice.value = { kind: "error", text: `${padName(pad)}: не удалось прочитать сэмпл` });
  const base = safeFileName(b.name || padName(pad));
  const name = bpmFromFileName(base) === null && b.bpmX100 >= 4000 && b.bpmX100 <= 20000 ? `${base}_${formatBpm(b.bpmX100)}bpm.wav` : `${base}.wav`;
  saveFile(name, encodeWav(w.samples, w.channels), "audio/wav");
  log("info", `${padName(pad)} → ${name} (${(w.frames / 48000).toFixed(2)} s, ${w.channels === 1 ? "моно" : "стерео"})`);
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
    fail(e, "Прослушивание");
  }
}

/** Stop the pad left playing by preview, then select the app's pad on the unit again. */
export async function stopPlaying(): Promise<void> {
  const pad = playing.value;
  if (pad === null) return;
  playing.value = null;
  if (!(await editPad(pad, "стоп", (d, p1) => d.stopPad(p1, pad)))) return;
  const sel = selectedPad.value;
  if (sel === pad) return;
  await device?.exclusive((x) => x.selectOnDevice(sel))
    .then(() => { if (status.value) status.value = { ...status.value, bank: sel >> 4, pad: sel & 15 }; })
    .catch((e) => log("warn", `Выбор pad'а на SP: ${(e as Error).message}`));
}

/** Free pads from `startPad` to the end of its bank, skipping pads already queued. */
/** Run `fn` with the device to itself (for modules beside the store, e.g. the card browser). */
export function withDevice<T>(fn: (d: SP404Device) => Promise<T>): Promise<T> {
  const d = device;
  if (!d || conn.value !== "ready") return Promise.reject(new Error("SP не подключён"));
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
  if (!audio.length) return void (notice.value = { kind: "error", text: "Перетащите аудиофайлы (WAV, AIFF, FLAC, MP3…)" });
  const block = writeBlockReason.value;
  if (!d || block) return void (notice.value = { kind: "error", text: block ?? "SP не подключён" });
  const bank = startPad >> 4;
  if (project.value?.banks[bank]?.protected) return void (notice.value = { kind: "error", text: `Банк ${padName(bank * 16)[0]} защищён (BANK Protect на SP)` });
  if (pads.value[startPad]?.size) return void (notice.value = { kind: "error", text: `${padName(startPad)} занят. Перетащите на пустой pad — перезапись пока не поддерживается` });
  const targets = targetPads(startPad, audio.length);
  if (targets.length < audio.length)
    notice.value = { kind: "info", text: `В банке хватает места для ${targets.length} из ${audio.length} файлов — остальные пропущены` };
  else notice.value = null;
  const fallback = parseDefaultBpm();
  const detectMin = detectOnImport.value ? BPM_RANGES[bpmRange.value]![0] : null;
  const given = (i: number) => (Array.isArray(bpmX100) ? bpmX100[i] : bpmX100);
  const newJobs = targets.map((pad, i) => newJob(audio[i], pad, given(i) ?? bpmFromFileName(audio[i].name), fallback, detectMin, given(i) !== undefined ? "source" : "name"));
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
  importChain = importChain.then(() => uploader.run(p1, newJobs)).then((ok) => {
    if (ok < newJobs.length) notice.value = { kind: "error", text: `Импортировано ${ok} из ${newJobs.length} — подробности в журнале` };
  });
}

function parseDefaultBpm(): number | null {
  const t = defaultBpm.value.trim().replace(",", ".");
  const x = Math.round(parseFloat(t) * 100);
  return t && x >= 4000 && x <= 20000 ? x : null;
}

export function clearFinishedJobs(): void {
  jobs.value = jobs.value.filter((j) => j.state !== "done" && j.state !== "error");
}
