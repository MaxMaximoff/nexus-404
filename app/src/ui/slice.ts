// Cutting a long track into loops of whole bars. All of it happens here: decoding, the beat grid
// (gridWorker), where the cuts go, listening; the SP gets only the finished loops, written as WAV
// files to a new folder of IMPORT/ on the SD card. From there they go onto pads like any card file
// (drag from the card browser; the BPM is in each file name).
// A track can come as several stems of the same length (voice and instrumental from UVR, Demucs'
// four…): one grid (from the stem that carries the beat) and the same cuts. The ticked stems are
// written: one as it is into its own subfolder (vocals/), several mixed into one file per loop
// (mix/, or drums+bass/ for some of them), so the numbers match across subfolders.
// Or the stems go in groups (vocal, drums, bass, others), each mixed into one sound per loop and
// laid out on pads, a group a column and a loop a row (sp404/groups.ts).

import { batch, computed, effect, signal } from "@preact/signals";
import {
  BPM_MAX_X100, BPM_MIN_X100, BPM_RANGES, CARD, barFrames, computePeaks, decodeAudio, encodeWav, evenCuts, extractLoop, formatBpm, gridStem, loopFileName, mixLoop,
  keyFullName, keyName, loopsFromCuts, type CleanLevel, type CleanRole, padName, stemBase, stemKinds, trackName, wholeBars, uniqueName, type BeatGrid, type Loop,
  BANKS, DEFAULT_GROUP_NAMES, GROUP_COUNT, banksFor, banksText, defaultGroups, groupSampleName, groupSlugs, padLayout, type Cell, type StemFamily,
} from "../sp404";
import type { EssentiaKey, EssentiaKeyAnalysis } from "../sp404/essentiaKey";
import type { GridReply, GridRequest } from "./gridWorker";
import { cardBusy, openCardDir, showSide, sideTab } from "./card";
import { mainView, showView } from "./Patterns";
import { bpmRange, conn, demo, importToPads, importing, log, notice, padPcm, pads, placeDemoPad, project, selectedBank, withDevice, writeBlockReason } from "./store";

const RATE = 48000;
const MAX_MINUTES = 15;
/** Columns of the precomputed waveform (zoomed views read the samples). */
export const OVERVIEW_COLS = 8192;
/** Stems more than this apart in length are probably not of one track: said, not refused. */
const STEM_LENGTH_SLACK = 0.05 * RATE;
/** A stem quieter than this (RMS, 16-bit; −45 dBFS) over a loop is silent there. */
const SILENT_RMS = 184;

export interface Stem {
  /** File (or pad) name. */
  name: string;
  /** Its kind as a card subfolder ("vocals", "inst"…) and a short tag for file names; "" for a track of one stem. */
  label: string;
  tag: string;
  /** What it is (its group on pads starts from it); "others" for a track of one stem. */
  family: StemFamily;
  samples: Int16Array;
  channels: 1 | 2;
  frames: number;
  /** Min/max per column over the whole stem, per channel. */
  peaks: Float32Array[];
}

export interface Track {
  /** Tells tracks apart (a track keeps it when stems are added or removed). */
  id: number;
  /** Names the card folder and the loop files (a file name; its extension is dropped). */
  name: string;
  /** The longest stem. */
  frames: number;
  stems: Stem[];
  /** The pad it came from. */
  pad?: number;
  /** Tempo for a grid set by hand when no beat is found (the pad's BPM). */
  fallbackX100?: number;
}

export const slTrack = signal<Track | null>(null);
/** The stem the grid is built from (index into the track's stems). */
export const slGridStem = signal(0);
/** Stems muted (indices): not heard, and not written to the card. */
export const slMuted = signal<ReadonlySet<number>>(new Set());
/** Soloed stems and group bus controls, shared by listening and export. */
export const slSolo = signal<ReadonlySet<number>>(new Set());
export const slGroupMuted = signal<ReadonlySet<number>>(new Set());
export const slGroupSolo = signal<ReadonlySet<number>>(new Set());
/** Volume of each stem in dB (stem index → dB; 0 when left out), for every loop. */
export const slGain = signal<ReadonlyMap<number, number>>(new Map());
/** A loop's own balance: its first bar → (stem index → dB on top of the stem's volume). */
export const slLoopGain = signal<ReadonlyMap<number, ReadonlyMap<number, number>>>(new Map());
/** Clean-up of the stems (UVR leftovers): off, or how much; the cleaned sound is heard and written. */
export const slClean = signal<"off" | CleanLevel>("off");
/** The cleaned PCM of the open track's stems at that level; null while off or not ready. */
const slCleaned = signal<{ stems: Stem[]; level: CleanLevel; out: Int16Array[] } | null>(null);
/** Cleaning is running. */
export const slCleaning = signal(false);
/** The track's key (Essentia): undefined while it is being found, null when there is no clear one (or no pitched stem). */
export const slKey = signal<EssentiaKey | null | undefined>(undefined);
/** Why the key could not be found (Essentia failed to load or run); null when it did not fail. */
export const slKeyError = signal<string | null>(null);
/** The stem the key is found from (index into the track's stems); -1 when no stem is pitched (drums only). */
export const slKeyStem = signal(0);
/** What the slicer is busy with before the grid is there. */
export const slState = signal<"idle" | "decoding" | "analyzing" | "ready">("idle");
export const slGrid = signal<BeatGrid | null>(null);
/** The grid as detected, for "Reset grid"; null when no beat was found. */
export const slDetected = signal<BeatGrid | null>(null);
/** Bar lines where the track is cut; a loop lies between two neighbouring cuts. */
export const slCuts = signal<ReadonlySet<number>>(new Set());
/** Loops left out of the write, by their first bar. */
export const slOff = signal<ReadonlySet<number>>(new Set());
/** The loop picked in the list or on the wave, by its first bar. */
export const slSel = signal<number | null>(null);
const DEFAULT_EVERY = 4;
/** "Cut every N bars"; every new track starts at DEFAULT_EVERY. */
export const slEvery = signal(DEFAULT_EVERY);
export const slPreRollMs = signal(0);
export const slFadeMs = signal(1);
export const slMetronome = signal(false);
/** Picking bar 1 on the wave with the next click. */
export const slPickBar1 = signal(false);
/** Writing to the card: what and how far; `cancel` stops after the file being written. */
export const slBusy = signal<{ text: string; progress: number } | null>(null);
let cancel = false;
/** Loops written to the card, per output label ("" for a track of one stem): "bar:bars" of each. */
export const slWritten = signal<ReadonlyMap<string, ReadonlySet<string>>>(new Map());
/** The track's grid, cuts and choices came back from the browser (from an earlier session). */
export const slRestored = signal(false);
/** Each stem's group on pads (its column, 0–3), by stem index; -1: in none. */
export const slStemGroup = signal<readonly number[]>([]);
/** The groups' names, a column each. */
export const slGroupNames = signal<readonly string[]>(DEFAULT_GROUP_NAMES);
/** The bank the groups' first loops go to; the fifth loop and on go on in the next banks. */
export const slStartBank = signal(0);

/** Stems suppressed by either their own controls or their group's controls. Mute takes priority. */
export const slInactive = computed<ReadonlySet<number>>(() => {
  const out = new Set<number>(), groups = slStemGroup.value;
  const solo = slSolo.value, groupSolo = slGroupSolo.value, hasSolo = solo.size > 0 || groupSolo.size > 0;
  slTrack.value?.stems.forEach((_, i) => {
    const g = groups[i] ?? -1;
    if (slMuted.value.has(i) || slGroupMuted.value.has(g) || (hasSolo && !solo.has(i) && !groupSolo.has(g))) out.add(i);
  });
  return out;
});

const preRoll = () => Math.round((slPreRollMs.value * RATE) / 1000);

/** All loops between the cuts, in order. */
export const slLoops = computed<Loop[]>(() => (slGrid.value ? loopsFromCuts(slGrid.value, slCuts.value, preRoll()) : []));
/** The loops that go to the card, in order. */
export const slChosen = computed(() => slLoops.value.filter((l) => !slOff.value.has(l.bar)));
/** The bars wholly inside the track (cuts may go on lines first … last + 1). */
export const slBars = computed(() => (slGrid.value && slTrack.value ? wholeBars(slGrid.value, slTrack.value.frames, preRoll()) : null));

// ---------- opening and analysing ----------

let worker: Worker | null = null;
let job = 0;
let req = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

/** A request without its id (Omit spread over each kind). */
type Request = GridRequest extends infer R ? (R extends GridRequest ? Omit<R, "id"> : never) : never;

/** One request to the analysis worker; requests may overlap (the grid of one stem, the key of another). */
function ask<T>(msg: Request): Promise<T> {
  if (!worker) {
    worker = new Worker(new URL("./gridWorker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<GridReply>) => {
      const r = e.data, p = pending.get(r.id);
      pending.delete(r.id);
      if ("error" in r) p?.reject(new Error(r.error));
      else p?.resolve(r.result);
    };
    worker.onerror = (e) => {
      for (const p of pending.values()) p.reject(new Error(e.message || "analysis failed"));
      pending.clear();
      worker?.terminate();
      worker = null;
    };
  }
  const id = ++req;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    worker!.postMessage({ ...msg, id } as GridRequest);
  });
}
let nextTrack = 1;

/** Decode files: one track, or stems of one track; then find the grid. */
export async function openTrack(files: File | File[]): Promise<void> {
  const list = Array.isArray(files) ? files : [files];
  if (slBusy.value || !list.length) return;
  stopPlay();
  const id = ++job;
  slState.value = "decoding";
  slGrid.value = slDetected.value = null;
  slTrack.value = null;
  try {
    const stems = await decodeStems(list, () => id !== job);
    if (!stems) return;
    const name = stems.length > 1 ? `${list.map((f) => stemBase(f.name)).find(Boolean) ?? "track"}.wav` : list[0]!.name;
    setTrack({ id: nextTrack++, name, stems: labelled(stems) });
    if (recall()) void findKey();
    else await analyze(true);
  } catch (e) {
    if (id !== job) return;
    slState.value = "idle";
    notice.value = { kind: "error", text: `${list.map((f) => f.name).join(", ")}: ${(e as Error).message}` };
  }
}

/** More stems of the open track (the same length), added to it; the grid stays. */
export async function addStems(files: File[]): Promise<void> {
  const t = slTrack.value;
  if (!t || slBusy.value || !files.length) return;
  stopPlay();
  try {
    const added = await decodeStems(files, () => slTrack.value?.id !== t.id);
    if (!added) return;
    const cur = slTrack.value!;
    // A single track named after its file is named after the stems' track from now on.
    const name = cur.stems.length > 1 || cur.pad !== undefined ? cur.name : `${[cur.stems[0]!, ...added].map((x) => stemBase(x.name)).find(Boolean) ?? "track"}.wav`;
    const groups = slStemGroup.value;
    setTrack({ ...cur, name, stems: labelled([...cur.stems, ...added]) });
    // A track of one stem had no kinds: then every stem gets its group from its kind now.
    const keep = cur.stems.length > 1;
    slStemGroup.value = slTrack.value!.stems.map((x, i) => (keep && i < groups.length ? groups[i]! : defaultGroups([x.family])[0]!));
    void findKey();
  } catch (e) {
    notice.value = { kind: "error", text: `${files.map((f) => f.name).join(", ")}: ${(e as Error).message}` };
  }
}

/** Take a stem out of the open track (at least one stays). */
export function removeStem(i: number): void {
  const t = slTrack.value;
  if (!t || t.stems.length < 2 || slBusy.value) return;
  stopPlay();
  const without = (set: ReadonlySet<number>) => new Set([...set].filter((j) => j !== i).map((j) => (j > i ? j - 1 : j)));
  slMuted.value = without(slMuted.value);
  slSolo.value = without(slSolo.value);
  const shift = (m: ReadonlyMap<number, number>) => new Map([...m].filter(([j]) => j !== i).map(([j, v]) => [j > i ? j - 1 : j, v] as [number, number]));
  slGain.value = shift(slGain.value);
  slLoopGain.value = new Map([...slLoopGain.value].map(([bar, m]) => [bar, shift(m)] as [number, ReadonlyMap<number, number>]));
  slStemGroup.value = slStemGroup.value.filter((_, j) => j !== i);
  if (slGridStem.value === i) slGridStem.value = 0;
  else if (slGridStem.value > i) slGridStem.value--;
  setTrack({ ...t, stems: labelled(t.stems.filter((_, j) => j !== i)) });
  void findKey();
}

/** Labels and tags from the stems' names, each used once; none for a single stem. */
function labelled(stems: Stem[]): Stem[] {
  if (stems.length < 2) return stems.map((x) => ({ ...x, label: "", tag: "", family: "others" as const }));
  const kinds = stemKinds(stems.map((x) => x.name));
  return stems.map((x, i) => ({ ...x, label: kinds[i]!.label, tag: kinds[i]!.tag, family: kinds[i]!.family }));
}

/** Decode files into stems; null when `stale()` turns true meanwhile. */
async function decodeStems(files: File[], stale: () => boolean): Promise<Stem[] | null> {
  const out: Stem[] = [];
  for (const f of files) {
    const a = await decodeAudio(f);
    if (stale()) return null;
    out.push({ name: f.name, label: "", tag: "", family: "others", samples: a.samples, channels: a.channels, frames: a.frames, peaks: computePeaks(a.samples, a.channels, OVERVIEW_COLS) });
    log("info", `Slicer: ${f.name}, ${a.note}, ${(a.frames / RATE / 60).toFixed(2)} min`);
  }
  return out;
}

/**
 * A pad's whole sample (Start/End aside) in the slicer: the pad's name names the folder and the
 * files; its BPM is the tempo to start from when the sound has no clear beat.
 */
export async function openPad(pad: number): Promise<void> {
  if (slBusy.value) return;
  stopPlay();
  const id = ++job;
  slState.value = "decoding";
  slGrid.value = slDetected.value = null;
  slTrack.value = null;
  const b = pads.value[pad];
  const pcm = await padPcm(pad);
  if (id !== job) return;
  if (!b || !pcm) return void (slState.value = "idle");
  try {
    const bpm = b.bpmX100 >= BPM_MIN_X100 && b.bpmX100 <= BPM_MAX_X100 ? b.bpmX100 : undefined;
    const name = `${b.name || padName(pad)}.wav`, channels = pcm.channels === 1 ? 1 : 2;
    const stem: Stem = { name, label: "", tag: "", family: "others", samples: pcm.samples, channels, frames: pcm.frames, peaks: computePeaks(pcm.samples, channels, OVERVIEW_COLS) };
    log("info", `Slicer: pad ${padName(pad)}, ${(pcm.frames / RATE / 60).toFixed(2)} min`);
    setTrack({ id: nextTrack++, name, stems: [stem], pad, fallbackX100: bpm });
    if (recall()) void findKey();
    else await analyze(true);
  } catch (e) {
    slState.value = "idle";
    notice.value = { kind: "error", text: `${padName(pad)}: ${(e as Error).message}` };
  }
}

/** From the pad inspector: the slicer on screen (the card beside it, where the loops go) with the pad's sample. */
export function openInSlicer(pad: number): void {
  showView("slicer");
  if (sideTab.value === "pad") showSide("card");
  void openPad(pad);
}

function setTrack(t: Omit<Track, "frames">): void {
  const frames = Math.max(...t.stems.map((x) => x.frames)), shortest = Math.min(...t.stems.map((x) => x.frames));
  if (frames > MAX_MINUTES * 60 * RATE) throw new Error(`longer than ${MAX_MINUTES} minutes`);
  if (shortest < 4 * RATE) throw new Error("shorter than 4 seconds: nothing to cut");
  if (frames - shortest > STEM_LENGTH_SLACK)
    notice.value = { kind: "info", text: `The stems differ in length by ${((frames - shortest) / RATE).toFixed(2)} s: are they of one track?` };
  if (slTrack.value?.id !== t.id) {
    slGain.value = new Map();
    slLoopGain.value = new Map();
    slWritten.value = new Map();
    slRestored.value = false;
    slKey.value = undefined;
    slKeyError.value = null;
    slMuted.value = new Set();
    slSolo.value = new Set();
    slGroupMuted.value = new Set();
    slGroupSolo.value = new Set();
    slGridStem.value = Math.max(0, gridStem(stemKinds(t.stems.map((x) => x.name))));
    slStemGroup.value = defaultGroups(t.stems.map((x) => x.family));
    slGroupNames.value = DEFAULT_GROUP_NAMES;
    slStartBank.value = selectedBank.value;
  }
  slTrack.value = { ...t, frames };
}

/** The grid of one stem, from the worker. */
function detect(stem: Stem): Promise<BeatGrid | null> {
  return ask<BeatGrid | null>({ kind: "grid", samples: stem.samples, channels: stem.channels, minBpm: BPM_RANGES[bpmRange.value]![0] });
}

/** How good a stem is for finding the key: the instrumental, then the instruments, the bass, the voice; drums never. */
const KEY_RANK: Record<string, number> = { inst: 6, piano: 5, guitar: 5, synth: 5, strings: 5, other: 4, brass: 4, track: 3, bass: 2, vocals: 1, backvox: 1, fx: 1 };
const keyRank = (stem: Stem) => (stem.family === "drums" ? 0 : KEY_RANK[stem.label.replace(/_\d+$/, "").replace(/^track\d+$/, "track")] ?? 3);

let keyJob = 0;

/**
 * Find the open track's key from its most tonal stem (in the background; the grid does not wait
 * for it). Only the latest request counts: an answer for another track, other stems or an earlier
 * request is dropped.
 */
export async function findKey(): Promise<void> {
  const t = slTrack.value;
  if (!t) return;
  const id = ++keyJob;
  const i = t.stems.reduce((b, x, j) => (keyRank(x) > keyRank(t.stems[b]!) ? j : b), 0);
  const stem = t.stems[i]!;
  slKey.value = undefined;
  slKeyError.value = null;
  if (t.stems.length > 1 && keyRank(stem) === 0) {
    slKeyStem.value = -1;
    slKey.value = null;
    return void log("info", "Slicer: no key: drums only, no pitched stem");
  }
  slKeyStem.value = i;
  const from = t.stems.length > 1 ? ` from ${stem.label}` : "";
  const current = () => id === keyJob && slTrack.value?.id === t.id;
  try {
    const r = await ask<EssentiaKeyAnalysis>({ kind: "key", samples: stem.samples, channels: stem.channels, sampleRate: RATE });
    if (!current()) return;
    slKey.value = r.key;
    const timing = `Essentia ${r.backend} EDMA, ${(r.analysisMs / 1000).toFixed(2)} s${r.coldStart ? `, loaded in ${(r.initMs / 1000).toFixed(2)} s` : ""}`;
    log("info", r.key ? `Slicer: key ${keyName(r.key)} (${keyFullName(r.key)})${from}; strength ${r.key.strength.toFixed(2)} (profile match, not a probability); ${timing}`
      : `Slicer: no clear key${from}; ${timing}`);
  } catch (e) {
    if (!current()) return;
    slKey.value = null;
    slKeyError.value = (e as Error).message || "analysis failed";
    log("warn", `Slicer: key${from}: ${slKeyError.value}`);
  }
}

/**
 * Find the grid again: after the tempo range or the grid's stem has changed, or (`fresh`) for a
 * newly opened track, whose stems, when no name tells which one carries the beat, are all tried
 * and the one with the clearest beat is taken.
 */
export async function analyze(fresh = false): Promise<void> {
  const t = slTrack.value;
  if (!t) return;
  const id = ++job;
  slState.value = "analyzing";
  slRestored.value = false;
  let grid: BeatGrid | null = null;
  try {
    if (fresh && t.stems.length > 1 && gridStem(stemKinds(t.stems.map((x) => x.name))) < 0) {
      for (const [i, stem] of t.stems.entries()) {
        const g = await detect(stem);
        if (id !== job) return;
        if (g && (!grid || g.clarity > grid.clarity)) { grid = g; slGridStem.value = i; }
      }
    } else grid = await detect(t.stems[Math.min(slGridStem.value, t.stems.length - 1)]!);
  } catch (e) {
    if (id !== job) return;
    slState.value = "ready";
    return void (notice.value = { kind: "error", text: `Tempo analysis: ${(e as Error).message}` });
  }
  if (id !== job) return;
  if (grid && (grid.x100 < BPM_MIN_X100 || grid.x100 > BPM_MAX_X100)) grid = null;
  slDetected.value = grid;
  slState.value = "ready";
  const from = t.stems.length > 1 ? ` (from ${t.stems[slGridStem.value]!.label})` : "";
  if (grid) log("info", `Slicer: ${formatBpm(grid.x100)} BPM${from}, bar 1 at ${(grid.origin / RATE).toFixed(3)} s, clarity ${grid.clarity.toFixed(2)}`);
  else notice.value = { kind: "info", text: "No clear beat found: set the tempo and bar 1 by hand" };
  slEvery.value = DEFAULT_EVERY;
  // No clear beat: a grid from the start (at the pad's BPM, or 120), to be set by hand.
  setGrid(grid ?? { x100: t.fallbackX100 ?? 12000, beatsPerBar: 4, origin: 0, clarity: 0 }, true);
  // A short sample (a pad's loop): fewer bars per loop until it gives at least two.
  for (const n of [2, 1]) if (slLoops.value.length < 2) cutEvery(n);
  if (fresh) void findKey();
}

/** Build the grid from another stem. */
export function setGridStem(i: number): void {
  const t = slTrack.value;
  if (!t || i === slGridStem.value || i < 0 || i >= t.stems.length || slBusy.value) return;
  slGridStem.value = i;
  void analyze();
}

/** Stem `i`'s volume in dB for every loop; the loop playing is heard with it. */
export function setStemGain(i: number, db: number): void {
  const next = new Map(slGain.value);
  if (db) next.set(i, db); else next.delete(i);
  slGain.value = next;
}

/** Stem `i`'s volume in the loop starting at `bar`, in dB on top of its own (0: none). */
export function setLoopGain(bar: number, i: number, db: number): void {
  const next = new Map(slLoopGain.value), m = new Map(next.get(bar) ?? []);
  if (db) m.set(i, db); else m.delete(i);
  if (m.size) next.set(bar, m); else next.delete(bar);
  slLoopGain.value = next;
}

/** The loop at `bar` back to the stems' own volumes. */
export function resetLoopGain(bar: number): void {
  const next = new Map(slLoopGain.value);
  next.delete(bar);
  slLoopGain.value = next;
}

/** Stem `i`'s linear gain in the loop starting at `bar`. */
export const gainOf = (i: number, bar: number): number => 10 ** (((slGain.value.get(i) ?? 0) + (slLoopGain.value.get(bar)?.get(i) ?? 0)) / 20);

/** Play the loop again (after a change in what is heard), if one is playing. */
export function replay(): void {
  const p = slPlay.value;
  if (p) play(p.bar, !p.loop);
}

/** A stem in or out of listening — and of the write. */
export function toggleMute(i: number): void {
  if (slBusy.value) return;
  const next = new Set(slMuted.value);
  if (!next.delete(i)) next.add(i);
  slMuted.value = next;
  const p = slPlay.value;
  if (p) play(p.bar, !p.loop);
}

export function toggleSolo(i: number): void {
  if (slBusy.value) return;
  const next = new Set(slSolo.value);
  if (!next.delete(i)) next.add(i);
  slSolo.value = next;
  replay();
}

export function toggleGroupMute(g: number): void {
  if (slBusy.value) return;
  const next = new Set(slGroupMuted.value);
  if (!next.delete(g)) next.add(g);
  slGroupMuted.value = next;
  replay();
}

export function toggleGroupSolo(g: number): void {
  if (slBusy.value) return;
  const next = new Set(slGroupSolo.value);
  if (!next.delete(g)) next.add(g);
  slGroupSolo.value = next;
  replay();
}

/** The stems written to the card: the ones heard (not muted) — what you hear is what you get. */
export const writtenStems = (t: Track): Stem[] => t.stems.filter((_, i) => !slInactive.value.has(i));

/** Per loop (by its first bar), the labels of stems that are silent there; only with several stems. */
export const slSilent = computed<Map<number, string[]>>(() => {
  const t = slTrack.value, out = new Map<number, string[]>();
  if (!t || t.stems.length < 2) return out;
  for (const l of slLoops.value) {
    const quiet = t.stems.filter((x) => rms(x, l) < SILENT_RMS).map((x) => x.label);
    if (quiet.length) out.set(l.bar, quiet);
  }
  return out;
});

/** RMS of a stem over a loop (first channel, a sparse look). */
function rms(stem: Stem, l: Loop): number {
  const a = Math.max(0, l.start), b = Math.min(stem.frames, l.start + l.frames);
  let sum = 0, n = 0;
  for (let f = a; f < b; f += 16, n++) sum += stem.samples[f * stem.channels]! ** 2;
  return n ? Math.sqrt(sum / n) : 0;
}

// ---------- clean-up of stems ----------

/** What the clean-up does to a stem: the voice is de-essed, the music ducked by the voice's "s", the bass left alone. */
export const cleanRole = (stem: Stem): CleanRole => (stem.family === "vocal" ? "voice" : stem.family === "bass" ? "none" : "music");

/** The sound of a stem as heard and written: cleaned when the clean-up is on and ready. */
export function samplesOf(stem: Stem): Int16Array {
  const c = slCleaned.value;
  if (slClean.value === "off" || !c || c.level !== slClean.value) return stem.samples;
  const i = c.stems.indexOf(stem);
  return i >= 0 ? c.out[i]! : stem.samples;
}

let cleanJob = 0;
// The cleaned copy follows the level and the stems (only for a track of several stems).
effect(() => {
  const level = slClean.value, t = slTrack.value;
  const id = ++cleanJob;
  if (level === "off" || !t || t.stems.length < 2) { slCleaned.value = null; slCleaning.value = false; return; }
  const c = slCleaned.peek();
  if (c && c.level === level && c.stems.length === t.stems.length && c.stems.every((x, i) => x === t.stems[i])) return;
  slCleaning.value = true;
  const stems = t.stems;
  void ask<Int16Array[]>({ kind: "clean", level, stems: stems.map((x) => ({ samples: x.samples, channels: x.channels, role: cleanRole(x) })) })
    .then((out) => {
      if (id !== cleanJob) return;
      slCleaned.value = { stems, level, out };
      log("info", `Slicer: stems cleaned (${level}): ${stems.map((x) => `${x.label} ${cleanRole(x) === "voice" ? "de-essed" : cleanRole(x) === "music" ? "ducked by the voice's s" : "as is"}`).join(", ")}`);
      const p = slPlay.peek();
      if (p) play(p.bar, !p.loop); // heard cleaned from now on
    })
    .catch((e: Error) => { if (id === cleanJob) notice.value = { kind: "error", text: `Clean-up: ${e.message}` }; })
    .finally(() => { if (id === cleanJob) slCleaning.value = false; });
});

// ---------- the grid and the cuts ----------

/** A new grid; `recut` lays the cuts out evenly again, otherwise the cuts outside the track are dropped. */
function setGrid(g: BeatGrid, recut: boolean): void {
  slGrid.value = g;
  if (recut) return cutEvery(slEvery.value);
  keepInside();
}

function keepInside(): void {
  const b = slBars.value;
  if (!b) return;
  slCuts.value = new Set([...slCuts.value].filter((c) => c >= b.first && c <= b.last + 1));
  pruneOff();
}

/** Forget left-out marks and the pick of loops that are no longer there. */
function pruneOff(): void {
  const starts = new Set(slLoops.value.map((l) => l.bar));
  slOff.value = new Set([...slOff.value].filter((b) => starts.has(b)));
  if ([...slLoopGain.value.keys()].some((b) => !starts.has(b))) slLoopGain.value = new Map([...slLoopGain.value].filter(([b]) => starts.has(b)));
  if (slSel.value !== null && !starts.has(slSel.value)) slSel.value = slLoops.value.find((l) => l.bar <= slSel.value! && l.bar + l.bars > slSel.value!)?.bar ?? null;
}

/** Cut every `bars` bars from bar 1; every loop is in again. */
export function cutEvery(bars: number): void {
  const g = slGrid.value, t = slTrack.value;
  slEvery.value = bars;
  if (!g || !t) return;
  stopPlay();
  slCuts.value = new Set(evenCuts(g, t.frames, bars, preRoll()));
  slOff.value = new Set();
  slLoopGain.value = new Map();
  slSel.value = slLoops.value.find((l) => l.bar >= 1)?.bar ?? slLoops.value[0]?.bar ?? null;
}

export function setTempo(x100: number): void {
  const g = slGrid.value;
  if (!g || x100 < BPM_MIN_X100 || x100 > BPM_MAX_X100 || x100 === g.x100) return;
  setGrid({ ...g, x100 }, true);
}

export function resetGrid(): void {
  if (slDetected.value) setGrid(slDetected.value, true);
}

/** Move the whole grid by `ms` (later when positive). */
export function nudge(ms: number): void {
  const g = slGrid.value;
  if (!g) return;
  stopPlay();
  setGrid({ ...g, origin: Math.max(0, g.origin + Math.round((ms * RATE) / 1000)) }, false);
}

/** Bar 1 at the beat nearest to `frame`; the cuts are laid out again from it. */
export function setBar1(frame: number): void {
  const g = slGrid.value;
  slPickBar1.value = false;
  if (!g) return;
  const beat = barFrames(g) / g.beatsPerBar;
  const k = Math.round((frame - g.origin) / beat);
  let origin = g.origin + k * beat;
  while (origin < 0) origin += beat;
  setGrid({ ...g, origin: Math.round(origin) }, true);
}

export function setPreRoll(ms: number): void {
  slPreRollMs.value = Math.max(0, Math.min(50, ms));
  keepInside();
}

/** Add or remove the cut at `bar` (a bar line inside the track). */
export function toggleCut(bar: number): void {
  const b = slBars.value;
  if (!b || bar < b.first || bar > b.last + 1) return;
  stopPlay();
  const next = new Set(slCuts.value);
  if (!next.delete(bar)) next.add(bar);
  slCuts.value = next;
  pruneOff();
}

/** The picked loop in two halves (an odd length: the longer half first). */
export function splitSel(): void {
  const l = selLoop();
  if (l && l.bars >= 2) toggleCut(l.bar + Math.ceil(l.bars / 2));
}

/** The picked loop together with the next one. */
export function joinNext(): void {
  const l = selLoop();
  if (!l || !slLoops.value.some((x) => x.bar === l.bar + l.bars)) return;
  toggleCut(l.bar + l.bars);
}

export function toggleOff(bar: number): void {
  const next = new Set(slOff.value);
  if (!next.delete(bar)) next.add(bar);
  slOff.value = next;
}

export function setAllOff(off: boolean): void {
  slOff.value = off ? new Set(slLoops.value.map((l) => l.bar)) : new Set();
}

export const selLoop = (): Loop | null => slLoops.value.find((l) => l.bar === slSel.value) ?? null;

/** Pick the loop `step` places after the picked one. */
export function selStep(step: number): void {
  const list = slLoops.value;
  if (!list.length) return;
  const i = list.findIndex((l) => l.bar === slSel.value);
  slSel.value = list[Math.max(0, Math.min(list.length - 1, i < 0 ? 0 : i + step))]!.bar;
}

// ---------- listening ----------

let ctx: AudioContext | null = null;
let source: AudioBufferSourceNode | null = null;
/** What plays: from `start` (a frame of the track), `frames` long, started at `t0` (context time); `loop` = round and round. */
export const slPlay = signal<{ start: number; frames: number; t0: number; loop: boolean; bar: number } | null>(null);

/** Where the playhead is now, as a frame of the track; null when nothing plays. */
export function playheadFrame(): number | null {
  const p = slPlay.value;
  if (!p || !ctx) return null;
  const t = (ctx.currentTime - p.t0) * RATE;
  return p.start + (p.loop ? ((t % p.frames) + p.frames) % p.frames : Math.min(t, p.frames));
}

/**
 * Play the loop starting at `bar` round and round (the stems not muted, mixed); with `seam`, it
 * and the next one once, to hear the joint.
 */
export function play(bar: number, seam = false): void {
  const t = slTrack.value, g = slGrid.value, list = slLoops.value;
  const i = list.findIndex((l) => l.bar === bar);
  if (!t || !g || i < 0) return;
  stopPlay();
  const a = list[i]!, b = seam ? list[i + 1] : undefined;
  if (seam && (!b || b.start !== a.start + a.frames)) return;
  const frames = a.frames + (b?.frames ?? 0);
  ctx ??= new AudioContext({ sampleRate: RATE });
  void ctx.resume();
  const outCh = t.stems.some((x) => x.channels === 2) ? 2 : 1;
  const buf = ctx.createBuffer(outCh, frames, RATE);
  const fade = Math.round((slFadeMs.value * RATE) / 1000);
  for (const [s, stem] of t.stems.entries()) {
    if (slInactive.value.has(s)) continue;
    for (const [loop, at] of [[a, 0], ...(b ? [[b, a.frames]] : [])] as [Loop, number][]) {
      const pcm = extractLoop(samplesOf(stem), stem.channels, loop, fade), k = (t.stems.length > 1 ? gainOf(s, loop.bar) : 1) / 32768;
      for (let c = 0; c < outCh; c++) {
        const ch = buf.getChannelData(c), from = Math.min(c, stem.channels - 1);
        for (let f = 0; f < loop.frames; f++) ch[at + f] += pcm[f * stem.channels + from]! * k;
      }
    }
  }
  if (slMetronome.value) addClicks(buf, g, a.start);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = !seam;
  src.connect(ctx.destination);
  src.onended = () => { if (source === src) { source = null; slPlay.value = null; } };
  source = src;
  const t0 = ctx.currentTime + 0.03;
  src.start(t0);
  slPlay.value = { start: a.start, frames, t0, loop: !seam, bar };
}

export function stopPlay(): void {
  try { source?.stop(); } catch { /* already stopped */ }
  source = null;
  slPlay.value = null;
}

/** Space: the picked loop on and off. */
export function togglePlay(): void {
  if (slPlay.value) return stopPlay();
  if (slSel.value !== null) play(slSel.value);
}

/** A short click on every beat over the buffer, brighter on the first beat of a bar. */
function addClicks(buf: AudioBuffer, g: BeatGrid, start: number): void {
  const beat = barFrames(g) / g.beatsPerBar, shift = preRoll();
  const first = Math.ceil((start + shift - g.origin) / beat);
  const len = Math.round(0.02 * RATE);
  for (let k = first; ; k++) {
    const at = Math.round(g.origin + k * beat) - shift - start;
    if (at >= buf.length) break;
    const freq = ((k % g.beatsPerBar) + g.beatsPerBar) % g.beatsPerBar === 0 ? 2000 : 1200;
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const ch = buf.getChannelData(c);
      for (let i = 0; i < len && at + i < buf.length; i++) ch[at + i] += Math.sin((2 * Math.PI * freq * i) / RATE) * Math.exp(-i / (0.004 * RATE)) * 0.35;
    }
  }
}

// ---------- writing to the card ----------

/** Why nothing can be written to the card now, or null. */
export const slCardBlock = computed<string | null>(() =>
  conn.value !== "ready" ? "SP is not connected" : demo.value ? "Demo: no SD card to write to"
    : writeBlockReason.value ?? (cardBusy.value || slBusy.value ? "Card is busy — wait for the operation to finish" : null)
    ?? (slCleaning.value ? "Cleaning the stems — a moment" : null));
/** Why the chosen loops cannot be written now, or null. */
export const slWriteBlock = computed<string | null>(() => slCardBlock.value ?? slStemBlock.value ?? (!slChosen.value.length ? "No loops chosen" : null));
/** Why no loop can be written for want of stems, or null. */
export const slStemBlock = computed<string | null>(() => (slTrack.value && !writtenStems(slTrack.value).length ? "No stem is audible: check stem and group Mute / Solo" : null));

/** What the loops are written as: the ticked stems, one as it is, several mixed into one file. */
export interface Output {
  /** Subfolder in the track's folder ("" for a track of one stem): the stem's label, "mix" for all, "drums+bass" for some. */
  label: string;
  /** Tag in the file names ("vox", "mix"; "" for a track of one stem). */
  tag: string;
  stems: Stem[];
  channels: 1 | 2;
}

/** The output of the open track as ticked now; null when no stem is ticked. */
export function outputOf(t: Track): Output | null {
  const w = writtenStems(t);
  if (!w.length) return null;
  if (t.stems.length < 2) return { label: "", tag: "", stems: w, channels: w[0]!.channels };
  if (w.length === 1) return { label: w[0]!.label, tag: w[0]!.tag, stems: w, channels: w[0]!.channels };
  return { label: w.length === t.stems.length ? "mix" : w.map((x) => x.label).join("+"), tag: "mix", stems: w, channels: w.some((x) => x.channels === 2) ? 2 : 1 };
}

/** The card folder for the open track as it will be named, with the subfolder (before a `_2` for a taken name). */
export const folderPreview = (t: Track) => { const out = outputOf(t); return `IMPORT/${trackName(t.name)}/${out?.label ? `${out.label}/` : ""}`; };

/** A loop of the output as 16-bit PCM: the stem as it is, or the stems summed. */
function renderLoop(t: Track, out: Output, loop: Loop, fade: number): Int16Array {
  const parts = out.stems.map((x) => ({ samples: samplesOf(x), channels: x.channels, gain: t.stems.length > 1 ? gainOf(t.stems.indexOf(x), loop.bar) : 1 }));
  return parts.length === 1 && parts[0]!.gain === 1 ? extractLoop(parts[0]!.samples, parts[0]!.channels, loop, fade) : mixLoop(parts, loop, out.channels, fade);
}

/** Where files go on the card: IMPORT/<folder>/<sub>/ ("" sub: right in the folder). */
interface Target { folder: string; sub: string }
const targetPath = (tg: Target) => `IMPORT/${tg.folder}/${tg.sub ? `${tg.sub}/` : ""}`;
/** The last place written to for a track in this session (by the track's id and the output's label); single loops go there too. */
let lastTarget: { track: number; label: string; target: Target } | null = null;

/**
 * Where a write of the whole set goes. A track of several stems keeps one folder IMPORT/<track>/
 * (made when missing), and each write gets its own subfolder named after the output — `vocals`,
 * `mix`, `mix_2` when that one is taken — so a mix lands next to the stems written before. A track
 * of one stem gets a new folder each time (`_2`, `_3`…).
 */
function batchTarget(t: Track, out: Output): Promise<Target> {
  return withDevice(async (d) => {
    const root = `${CARD}/IMPORT`, base = trackName(t.name), names = (await d.listDir(root)).map((e) => e.name);
    if (!out.label) {
      const folder = uniqueName(base, names);
      await d.mkdirCard(`${root}/${folder}`);
      return { folder, sub: "" };
    }
    const folder = names.find((n) => n.toLowerCase() === base.toLowerCase()) ?? base;
    if (!(await d.stat(`${root}/${folder}`))) await d.mkdirCard(`${root}/${folder}`);
    const sub = uniqueName(out.label, (await d.listDir(`${root}/${folder}`)).map((e) => e.name));
    await d.mkdirCard(`${root}/${folder}/${sub}`);
    return { folder, sub };
  });
}

/**
 * Where a single loop goes, and the names already there: the last place this output of this track
 * was written to in this session, while it is on the card; else IMPORT/<track>/<output>/ for a
 * track of several stems (made when missing), or a new folder for a track of one stem.
 */
function singleTarget(t: Track, out: Output): Promise<{ target: Target; taken: string[] }> {
  return withDevice(async (d) => {
    const root = `${CARD}/IMPORT`;
    const names = async (tg: Target) => (await d.listDir(`${CARD}/${targetPath(tg)}`)).map((e) => e.name.toLowerCase());
    const last = lastTarget?.track === t.id && lastTarget.label === out.label ? lastTarget.target : null;
    if (last && (await d.stat(`${CARD}/${targetPath(last)}`))) return { target: last, taken: await names(last) };
    if (!out.label) {
      const folder = uniqueName(trackName(t.name), (await d.listDir(root)).map((e) => e.name));
      await d.mkdirCard(`${root}/${folder}`);
      return { target: { folder, sub: "" }, taken: [] };
    }
    const base = trackName(t.name);
    const folder = (await d.listDir(root)).map((e) => e.name).find((n) => n.toLowerCase() === base.toLowerCase()) ?? base;
    if (!(await d.stat(`${root}/${folder}`))) await d.mkdirCard(`${root}/${folder}`);
    const target = { folder, sub: out.label };
    if (!(await d.stat(`${root}/${folder}/${out.label}`))) await d.mkdirCard(`${root}/${folder}/${out.label}`);
    return { target, taken: await names(target) };
  });
}

interface CardFile { loop: Loop; name: string }

/** The file of a loop numbered `n` of `count`, with the output's tag in its name. */
function fileOf(t: Track, x100: number, loop: Loop, n: number, count: number): CardFile {
  return { loop, name: loopFileName(t.name, n, count, x100, outputOf(t)?.tag ?? "") };
}

/**
 * Write `files` of the output to where `place` says (asked once the progress shows), one by one;
 * "Stop" ends after the file being written. Then the card browser shows the folder. Returns the
 * target and how many were written.
 */
async function writeFiles(files: CardFile[], place: (t: Track, out: Output) => Promise<Target>): Promise<{ target: Target | null; done: number }> {
  const t = slTrack.value!, out = outputOf(t)!;
  stopPlay();
  cancel = false;
  const fade = Math.round((slFadeMs.value * RATE) / 1000);
  const busy = (text: string, progress: number) => { slBusy.value = { text, progress }; cardBusy.value = { text, progress }; };
  let target: Target | null = null, done = 0;
  try {
    busy("Preparing folder…", 0);
    target = await place(t, out);
    lastTarget = { track: t.id, label: out.label, target };
    for (const [i, { loop, name }] of files.entries()) {
      if (cancel) break;
      const text = files.length > 1 ? `Writing ${i + 1} of ${files.length}: ${name}` : `Writing ${name}`;
      busy(text, i / files.length);
      const data = new Uint8Array(encodeWav(renderLoop(t, out, loop, fade), out.channels));
      await withDevice((d) => d.writeCardFile(`${CARD}/${targetPath(target!)}${name}`, data, (a, b) => busy(text, (i + a / b) / files.length)));
      done++;
      if (slTrack.value?.id === t.id) markWritten(out.label, loop);
    }
  } catch (e) {
    notice.value = { kind: "error", text: `Write to card: ${(e as Error).message}` };
  } finally {
    slBusy.value = null;
    cardBusy.value = null;
  }
  if (target) {
    showSide("card");
    await openCardDir(["IMPORT", target.folder, ...(target.sub ? [target.sub] : [])]);
  }
  return { target, done };
}

/** The chosen loops as WAV files on the card (see batchTarget for where); then the card browser shows them. */
export async function writeLoops(): Promise<void> {
  const t = slTrack.value, g = slGrid.value, loops = slChosen.value;
  if (!t || !g || slWriteBlock.value) return;
  const files = loops.map((l, i) => fileOf(t, g.x100, l, i + 1, loops.length));
  const { target, done } = await writeFiles(files, batchTarget);
  if (!target || !done) return;
  log("info", `Slicer: ${done} of ${files.length} loops at ${formatBpm(g.x100)} BPM → ${targetPath(target)}`);
  notice.value = { kind: "info", text: `${done} loop${done === 1 ? "" : "s"} written to ${targetPath(target)} on the card${done < files.length ? " (stopped)" : ""}. Drag them from the card onto pads.` };
}

/**
 * The loop's number in file names: its place among the chosen loops (as the list shows it), or
 * among all loops when it is not chosen; and how many that counts.
 */
function loopNumber(bar: number): { n: number; count: number } {
  const chosen = slChosen.value.findIndex((l) => l.bar === bar);
  return chosen >= 0 ? { n: chosen + 1, count: slChosen.value.length } : { n: slLoops.value.findIndex((l) => l.bar === bar) + 1, count: slLoops.value.length };
}

/** One loop to the card (see singleTarget for where); a name taken there gets `_2`, `_3`… */
export async function writeOne(bar: number): Promise<void> {
  const t = slTrack.value, g = slGrid.value, loop = slLoops.value.find((l) => l.bar === bar);
  if (!t || !g || !loop || slCardBlock.value || slStemBlock.value) return;
  const { n, count } = loopNumber(bar);
  const plain = fileOf(t, g.x100, loop, n, count);
  let name = plain.name;
  const { target, done } = await writeFiles([plain], async (tr, out) => {
    const { target, taken } = await singleTarget(tr, out);
    for (let k = 2; taken.includes(name.toLowerCase()); k++) name = plain.name.replace(/\.wav$/, `_${k}.wav`);
    plain.name = name;
    return target;
  });
  if (!target || !done) return;
  log("info", `Slicer: bars ${loop.bar}–${loop.bar + loop.bars - 1} → ${targetPath(target)}${name}`);
  notice.value = { kind: "info", text: `${name} written to ${targetPath(target)} on the card` };
}

export function cancelWrite(): void {
  cancel = true;
}

const loopKey = (l: Loop) => `${l.bar}:${l.bars}`;

function markWritten(label: string, l: Loop): void {
  const next = new Map(slWritten.value);
  next.set(label, new Set([...(next.get(label) ?? []), loopKey(l)]));
  slWritten.value = next;
}

/** The outputs a loop has been written to the card as ("" for a track of one stem), as it is cut now. */
export const writtenAs = (l: Loop): string[] => [...slWritten.value].filter(([, s]) => s.has(loopKey(l))).map(([label]) => label);

// ---------- groups on pads ----------

/** Stem `i` into group `g` (a column, 0–3), or out of every group (-1). */
export function setStemGroup(i: number, g: number): void {
  if (slBusy.value || !Number.isInteger(g) || g < -1 || g >= GROUP_COUNT) return;
  const next = [...slStemGroup.value];
  next[i] = g;
  slStemGroup.value = next;
  replay();
}

/** Stem `i` into the next group: vocal → drums → bass → others → none → vocal. */
export function cycleStemGroup(i: number): void {
  const g = slStemGroup.value[i] ?? -1;
  setStemGroup(i, g + 1 >= GROUP_COUNT ? -1 : g + 1);
}

export function renameGroup(g: number, name: string): void {
  const next = [...slGroupNames.value];
  next[g] = name;
  slGroupNames.value = next;
}

/** A group as written: its column, its name in file names (`tag` = `label`), its stems mixed. */
export interface GroupOutput extends Output { col: number }

/** The groups that have an audible stem after Mute / Solo, by column. */
export function groupOutputs(t: Track): GroupOutput[] {
  const slugs = groupSlugs(slGroupNames.value), out: GroupOutput[] = [];
  for (let col = 0; col < GROUP_COUNT; col++) {
    const stems = t.stems.filter((_, i) => slStemGroup.value[i] === col && !slInactive.value.has(i));
    if (stems.length) out.push({ col, label: slugs[col]!, tag: slugs[col]!, stems, channels: stems.some((x) => x.channels === 2) ? 2 : 1 });
  }
  return out;
}

/** Where the chosen loops of the groups go on pads, row by row; null when they run past bank J (or no stems). */
export const slLayout = computed<Cell[] | null>(() => {
  const t = slTrack.value;
  return t && t.stems.length > 1 ? padLayout(groupOutputs(t).map((o) => o.col), slChosen.value.length, slStartBank.value) : null;
});

/** Pads of the layout that cannot take a loop now: a sample on them, or their bank protected. */
export const slPadConflicts = computed<number[]>(() =>
  (slLayout.value ?? []).map((c) => c.pad).filter((p) => pads.value[p]?.size || project.value?.banks[p >> 4]?.protected));

/** The first bank from which the layout lies on free pads only; null when there is none. */
export const slFreeStart = computed<number | null>(() => {
  const t = slTrack.value;
  if (!t || t.stems.length < 2) return null;
  const cols = groupOutputs(t).map((o) => o.col), n = slChosen.value.length;
  for (let b = 0; b < BANKS.length; b++) {
    const cells = padLayout(cols, n, b);
    if (cells?.every((c) => !pads.value[c.pad]?.size && !project.value?.banks[c.pad >> 4]?.protected)) return b;
  }
  return null;
});

/** Why the groups cannot be written now, or null. */
export const slGroupBlock = computed<string | null>(() => {
  const t = slTrack.value;
  if (!t || t.stems.length < 2) return "Groups are for a track of several stems";
  if (conn.value !== "ready") return "SP is not connected";
  if (!demo.value && writeBlockReason.value) return writeBlockReason.value;
  if (slBusy.value) return "Writing — wait for it to finish";
  if (importing.value) return "Imports are running — wait for them to finish";
  if (slCleaning.value) return "Cleaning the stems — a moment";
  if (!groupOutputs(t).length) return "No grouped stem is audible: assign a group or check stem and group Mute / Solo";
  const n = slChosen.value.length, start = slStartBank.value;
  if (!n) return "No loops chosen";
  if (!slLayout.value) return `${n} loops take ${banksFor(n)} banks: from bank ${BANKS[start]} there ${BANKS.length - start === 1 ? "is 1" : `are ${BANKS.length - start}`} — start earlier or choose fewer loops`;
  const busy = slPadConflicts.value;
  if (busy.length) return `Not free: ${busy.slice(0, 6).map(padName).join(", ")}${busy.length > 6 ? ` and ${busy.length - 6} more` : ""} — clear them or start from another bank`;
  return null;
});

/** Demo mode: the loop on its pad as the SP would show it after the import. */
async function demoImport(pad: number, name: string, pcm: Int16Array, channels: 1 | 2, x100: number): Promise<void> {
  const { demoPadBlock } = await import("./demo");
  placeDemoPad(demoPadBlock(pad, name, pcm.length / channels / RATE, channels === 2, x100 / 100), pcm, channels);
  await new Promise((r) => setTimeout(r, 60)); // the progress shows
}

/**
 * The chosen loops of every group onto their pads (slLayout) with the track's BPM,
 * named after the pad (`drums_A2`). "Stop" ends after the current import.
 */
export async function writeGroups(): Promise<void> {
  const t = slTrack.value, g = slGrid.value, loops = slChosen.value, cells = slLayout.value;
  if (!t || !g || !cells || slGroupBlock.value) return;
  const outs = groupOutputs(t), start = slStartBank.value;
  stopPlay();
  cancel = false;
  const fade = Math.round((slFadeMs.value * RATE) / 1000);
  const busy = (text: string, progress: number) => {
    slBusy.value = { text, progress };
  };
  let done = 0;
  try {
    for (const [i, cell] of cells.entries()) {
      if (cancel) break;
      const k = outs.findIndex((o) => o.col === cell.group), out = outs[k]!, loop = loops[cell.loop]!;
      const name = groupSampleName(out.tag, cell.pad), text = `${i + 1} of ${cells.length}: ${name}`;
      busy(text, i / cells.length);
      const pcm = renderLoop(t, out, loop, fade), wav = encodeWav(pcm, out.channels);
      if (demo.value) await demoImport(cell.pad, name, pcm, out.channels, g.x100);
      else if (!(await importToPads([{ file: new File([wav], `${name}.wav`, { type: "audio/wav" }), pad: cell.pad, bpmX100: g.x100 }])))
        throw new Error(`${padName(cell.pad)}: the import failed — details in the log`);
      done++;
    }
  } catch (e) {
    notice.value = { kind: "error", text: `Groups: ${(e as Error).message}` };
  } finally {
    slBusy.value = null;
  }
  if (!done) return;
  const where = `pads of bank${banksFor(loops.length) > 1 ? "s" : ""} ${banksText(start, loops.length)}`;
  log("info", `Slicer: ${done} of ${cells.length} loops of ${outs.map((o) => o.tag).join(", ")} at ${formatBpm(g.x100)} BPM → ${where}`);
  if (done === cells.length) notice.value = { kind: "info", text: `${done} loop${done === 1 ? "" : "s"} written to ${where}` };
  else if (cancel) notice.value = { kind: "info", text: `Stopped: ${done} of ${cells.length} loops written to ${where}` };
  selectedBank.value = start;
}

// ---------- kept in the browser ----------
// The work on a track (grid, cuts, choices, volumes, what went to the card) is kept in the browser
// and comes back when the same audio is opened again, so a track can be finished another day. The
// audio is told by its sound, not its file name: a renamed file comes back too.

const KEEP_KEY = "nexus404.slicer";
/** Tracks kept, the latest first. */
const KEEP_MAX = 40;

interface Kept {
  /** The stems it was for (stemId). */
  stems: string[];
  grid: BeatGrid;
  detected: BeatGrid | null;
  every: number;
  cuts: number[];
  off: number[];
  sel: number | null;
  preRoll: number;
  fade: number;
  clean: "off" | CleanLevel;
  gridStem: string;
  muted: string[];
  solo?: string[];
  groupMuted?: number[];
  groupSolo?: number[];
  gain: [string, number][];
  loopGain: [number, [string, number][]][];
  written: [string, string[]][];
  /** Each stem's group (stemId → column, -1 for none), the groups' names, the bank they start in. */
  groups?: [string, number][];
  groupNames?: string[];
  startBank?: number;
}

const ids = new WeakMap<Stem, string>();
/** A stem told by its sound: its length and a sum over every 61st sample. */
function stemId(x: Stem): string {
  let id = ids.get(x);
  if (!id) {
    let h = 0x811c9dc5;
    for (let i = 0; i < x.samples.length; i += 61) h = Math.imul(h ^ (x.samples[i]! & 0xffff), 0x01000193) >>> 0;
    ids.set(x, (id = `${x.frames}:${x.channels}:${h.toString(16)}`));
  }
  return id;
}

function loadKept(): Kept[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEEP_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((k) => Array.isArray(k?.stems) && Array.isArray(k.cuts)) : [];
  } catch { return []; }
}

const isGrid = (g: unknown): g is BeatGrid => {
  const x = g as BeatGrid | null;
  return !!x && Number.isFinite(x.origin) && x.origin >= 0 && x.x100 >= BPM_MIN_X100 && x.x100 <= BPM_MAX_X100 && x.beatsPerBar > 0;
};

/** The open track's work back from the browser, when it was kept; true when it was. */
function recall(): boolean {
  const t = slTrack.value;
  if (!t) return false;
  const now = t.stems.map(stemId), at = (id: string) => now.indexOf(id);
  // Kept tracks never share a stem (a save replaces those that do), so one at most matches.
  const k = loadKept().find((x) => x.stems.some((s) => now.includes(s)));
  if (!k || !isGrid(k.grid)) return false;
  const byStem = (pairs: [string, number][]) => new Map(pairs.map(([id, v]) => [at(id), v] as [number, number]).filter(([i]) => i >= 0));
  batch(() => {
    slDetected.value = isGrid(k.detected) ? k.detected : null;
    slEvery.value = k.every || DEFAULT_EVERY;
    slPreRollMs.value = k.preRoll ?? 0;
    slFadeMs.value = k.fade ?? 1;
    if (t.stems.length > 1) slClean.value = k.clean ?? "off";
    if (at(k.gridStem) >= 0) slGridStem.value = at(k.gridStem);
    slMuted.value = new Set((k.muted ?? []).map(at).filter((i) => i >= 0));
    slSolo.value = new Set((k.solo ?? []).map(at).filter((i) => i >= 0));
    const validGroups = (gs: number[]) => new Set(gs.filter((g) => Number.isInteger(g) && g >= 0 && g < GROUP_COUNT));
    slGroupMuted.value = validGroups(k.groupMuted ?? []);
    slGroupSolo.value = validGroups(k.groupSolo ?? []);
    slGain.value = byStem(k.gain ?? []);
    slLoopGain.value = new Map((k.loopGain ?? []).map(([bar, m]) => [bar, byStem(m)] as [number, ReadonlyMap<number, number>]).filter(([, m]) => m.size));
    slWritten.value = new Map((k.written ?? []).map(([label, s]) => [label, new Set(s)]));
    const groups = new Map(k.groups ?? []);
    slStemGroup.value = t.stems.map((x, i) => groups.get(now[i]!) ?? defaultGroups([x.family])[0]!);
    if (k.groupNames?.length === GROUP_COUNT) slGroupNames.value = k.groupNames;
    if (k.startBank !== undefined && k.startBank >= 0 && k.startBank < BANKS.length) slStartBank.value = k.startBank;
    slGrid.value = k.grid;
    slCuts.value = new Set(k.cuts);
    slOff.value = new Set(k.off ?? []);
    slSel.value = k.sel ?? null;
    keepInside();
    if (slSel.value === null) slSel.value = slLoops.value.find((l) => l.bar >= 1)?.bar ?? slLoops.value[0]?.bar ?? null;
    slRestored.value = true;
    slState.value = "ready";
  });
  const written = [...slWritten.value.values()].reduce((n, s) => n + s.size, 0);
  log("info", `Slicer: grid and cuts from last time, ${formatBpm(k.grid.x100)} BPM, ${slChosen.value.length} of ${slLoops.value.length} loops chosen${written ? `, ${written} written before` : ""}`);
  return true;
}

/** Forget what was kept and find the grid anew, as for a track never opened. */
export function startOver(): void {
  const t = slTrack.value;
  if (!t || slBusy.value) return;
  stopPlay();
  slGain.value = new Map();
  slLoopGain.value = new Map();
  slMuted.value = new Set();
  slSolo.value = new Set();
  slGroupMuted.value = new Set();
  slGroupSolo.value = new Set();
  slGridStem.value = Math.max(0, gridStem(stemKinds(t.stems.map((x) => x.name))));
  slStemGroup.value = defaultGroups(t.stems.map((x) => x.family));
  slGroupNames.value = DEFAULT_GROUP_NAMES;
  void analyze(true);
}

// Keep the open track's work in the browser on every change.
effect(() => {
  const t = slTrack.value, g = slGrid.value;
  if (!t || !g || slState.value !== "ready") return;
  const now = t.stems.map(stemId), id = (i: number) => now[i]!;
  const pairs = (m: ReadonlyMap<number, number>) => [...m].filter(([i]) => i < now.length).map(([i, v]) => [id(i), v] as [string, number]);
  const k: Kept = {
    stems: now, grid: g, detected: slDetected.value, every: slEvery.value,
    cuts: [...slCuts.value], off: [...slOff.value], sel: slSel.value,
    preRoll: slPreRollMs.value, fade: slFadeMs.value, clean: slClean.value,
    gridStem: id(Math.min(slGridStem.value, now.length - 1)),
    muted: [...slMuted.value].filter((i) => i < now.length).map(id),
    solo: [...slSolo.value].filter((i) => i < now.length).map(id),
    groupMuted: [...slGroupMuted.value],
    groupSolo: [...slGroupSolo.value],
    gain: pairs(slGain.value),
    loopGain: [...slLoopGain.value].map(([bar, m]) => [bar, pairs(m)] as [number, [string, number][]]),
    written: [...slWritten.value].map(([label, s]) => [label, [...s]] as [string, string[]]),
    groups: now.map((x, i) => [x, slStemGroup.value[i] ?? -1] as [string, number]),
    groupNames: [...slGroupNames.value],
    startBank: slStartBank.value,
  };
  try {
    const rest = loadKept().filter((x) => !x.stems.some((s) => now.includes(s)));
    localStorage.setItem(KEEP_KEY, JSON.stringify([k, ...rest].slice(0, KEEP_MAX)));
  } catch { /* storage blocked or full: kept in memory only */ }
});

// Listening stops when the slicer leaves the screen (after `source` above exists: the effect runs at once).
effect(() => { if (mainView.value !== "slicer") stopPlay(); });
