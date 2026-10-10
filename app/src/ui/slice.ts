// Cutting a long track into loops of whole bars. All of it happens here: decoding, the beat grid
// (gridWorker), where the cuts go, listening; the SP gets only the finished loops, written as WAV
// files to a new folder of IMPORT/ on the SD card. From there they go onto pads like any card file
// (drag from the card browser; the BPM is in each file name).
// A track can come as several stems of the same length (voice and instrumental from UVR, Demucs'
// four…): one grid (from the stem that carries the beat), the same cuts, and each loop written once
// per stem, into a subfolder per stem with matching numbers.

import { computed, effect, signal } from "@preact/signals";
import {
  BPM_MAX_X100, BPM_MIN_X100, BPM_RANGES, CARD, barFrames, computePeaks, decodeAudio, encodeWav, evenCuts, extractLoop, formatBpm, gridStem, loopFileName,
  loopsFromCuts, padName, stemBase, stemKinds, trackName, wholeBars, uniqueName, type BeatGrid, type Loop,
} from "../sp404";
import type { GridRequest } from "./gridWorker";
import { cardBusy, openCardDir, showSide, sideTab } from "./card";
import { mainView, showView } from "./Patterns";
import { bpmRange, conn, demo, log, notice, padPcm, pads, withDevice, writeBlockReason } from "./store";

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
/** Stems left out of listening (indices). */
export const slMuted = signal<ReadonlySet<number>>(new Set());
/** Stems left out of writing to the card (indices): write the voice, the instrumental or both. */
export const slUnwritten = signal<ReadonlySet<number>>(new Set());
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
    await analyze(true);
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
    setTrack({ ...cur, name, stems: labelled([...cur.stems, ...added]) });
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
  slUnwritten.value = without(slUnwritten.value);
  if (slGridStem.value === i) slGridStem.value = 0;
  else if (slGridStem.value > i) slGridStem.value--;
  setTrack({ ...t, stems: labelled(t.stems.filter((_, j) => j !== i)) });
}

/** Labels and tags from the stems' names, each used once; none for a single stem. */
function labelled(stems: Stem[]): Stem[] {
  if (stems.length < 2) return stems.map((x) => ({ ...x, label: "", tag: "" }));
  const kinds = stemKinds(stems.map((x) => x.name));
  return stems.map((x, i) => ({ ...x, label: kinds[i]!.label, tag: kinds[i]!.tag }));
}

/** Decode files into stems; null when `stale()` turns true meanwhile. */
async function decodeStems(files: File[], stale: () => boolean): Promise<Stem[] | null> {
  const out: Stem[] = [];
  for (const f of files) {
    const a = await decodeAudio(f);
    if (stale()) return null;
    out.push({ name: f.name, label: "", tag: "", samples: a.samples, channels: a.channels, frames: a.frames, peaks: computePeaks(a.samples, a.channels, OVERVIEW_COLS) });
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
    const stem: Stem = { name, label: "", tag: "", samples: pcm.samples, channels, frames: pcm.frames, peaks: computePeaks(pcm.samples, channels, OVERVIEW_COLS) };
    log("info", `Slicer: pad ${padName(pad)}, ${(pcm.frames / RATE / 60).toFixed(2)} min`);
    setTrack({ id: nextTrack++, name, stems: [stem], pad, fallbackX100: bpm });
    await analyze(true);
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
    slMuted.value = new Set();
    slUnwritten.value = new Set();
    slGridStem.value = Math.max(0, gridStem(stemKinds(t.stems.map((x) => x.name))));
  }
  slTrack.value = { ...t, frames };
}

/** The grid of one stem, from the worker. */
function detect(stem: Stem, id: number): Promise<BeatGrid | null> {
  const minBpm = BPM_RANGES[bpmRange.value]![0];
  worker ??= new Worker(new URL("./gridWorker.ts", import.meta.url), { type: "module" });
  return new Promise<BeatGrid | null>((resolve, reject) => {
    worker!.onmessage = (e: MessageEvent<{ id: number; grid: BeatGrid | null }>) => { if (e.data.id === id) resolve(e.data.grid); };
    worker!.onerror = (e) => reject(new Error(e.message || "analysis failed"));
    worker!.postMessage({ id, samples: stem.samples, channels: stem.channels, minBpm } satisfies GridRequest);
  });
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
  let grid: BeatGrid | null = null;
  try {
    if (fresh && t.stems.length > 1 && gridStem(stemKinds(t.stems.map((x) => x.name))) < 0) {
      for (const [i, stem] of t.stems.entries()) {
        const g = await detect(stem, id);
        if (id !== job) return;
        if (g && (!grid || g.clarity > grid.clarity)) { grid = g; slGridStem.value = i; }
      }
    } else grid = await detect(t.stems[Math.min(slGridStem.value, t.stems.length - 1)]!, id);
  } catch (e) {
    worker?.terminate();
    worker = null;
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
}

/** Build the grid from another stem. */
export function setGridStem(i: number): void {
  const t = slTrack.value;
  if (!t || i === slGridStem.value || i < 0 || i >= t.stems.length || slBusy.value) return;
  slGridStem.value = i;
  void analyze();
}

/** A stem in or out of listening. */
export function toggleMute(i: number): void {
  const next = new Set(slMuted.value);
  if (!next.delete(i)) next.add(i);
  slMuted.value = next;
  const p = slPlay.value;
  if (p) play(p.bar, !p.loop);
}

/** A stem in or out of writing to the card. */
export function toggleWritten(i: number): void {
  const next = new Set(slUnwritten.value);
  if (!next.delete(i)) next.add(i);
  slUnwritten.value = next;
}

/** The stems written to the card (all but the ones left out). */
export const writtenStems = (t: Track): Stem[] => t.stems.filter((_, i) => !slUnwritten.value.has(i));

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
    if (slMuted.value.has(s)) continue;
    for (const [loop, at] of [[a, 0], ...(b ? [[b, a.frames]] : [])] as [Loop, number][]) {
      const pcm = extractLoop(stem.samples, stem.channels, loop, fade);
      for (let c = 0; c < outCh; c++) {
        const ch = buf.getChannelData(c), from = Math.min(c, stem.channels - 1);
        for (let f = 0; f < loop.frames; f++) ch[at + f] += pcm[f * stem.channels + from]! / 32768;
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
    : writeBlockReason.value ?? (cardBusy.value || slBusy.value ? "Card is busy — wait for the operation to finish" : null));
/** Why the chosen loops cannot be written now, or null. */
export const slWriteBlock = computed<string | null>(() => slCardBlock.value ?? slStemBlock.value ?? (!slChosen.value.length ? "No loops chosen" : null));
/** Why no loop can be written for want of stems, or null. */
export const slStemBlock = computed<string | null>(() => (slTrack.value && slTrack.value.stems.length > 1 && !writtenStems(slTrack.value).length ? "No stems chosen to write" : null));

/** The card folder made for a track in this session (by the track's id); single loops of that track go into it too. */
let folderOf: { track: number; name: string } | null = null;

/** Where a stem's loops go inside the track's folder: its own subfolder when there are several stems. */
const subOf = (t: Track, stem: Stem) => (t.stems.length > 1 ? `/${stem.label}` : "");

/** The track's card folder as it will be named (before a `_2` for a taken name), with its subfolders. */
export const folderPreview = (t: Track) => `IMPORT/${trackName(t.name)}/${t.stems.length > 1 ? `{${writtenStems(t).map((x) => x.label).join(", ")}}/` : ""}`;

/** A new folder IMPORT/<track>/ (`_2`, `_3`… when taken), with a subfolder per stem; it becomes the track's folder. */
async function newFolder(t: Track): Promise<string> {
  const name = await withDevice(async (d) => {
    const n = uniqueName(trackName(t.name), (await d.listDir(`${CARD}/IMPORT`)).map((e) => e.name));
    await d.mkdirCard(`${CARD}/IMPORT/${n}`);
    for (const stem of writtenStems(t)) if (subOf(t, stem)) await d.mkdirCard(`${CARD}/IMPORT/${n}${subOf(t, stem)}`);
    return n;
  });
  folderOf = { track: t.id, name };
  return name;
}

interface CardFile { stem: Stem; loop: Loop; name: string }

/** The files of a loop numbered `n` of `count`: one per written stem, the stem's tag in the name when there are several. */
function filesOf(t: Track, x100: number, loop: Loop, n: number, count: number): CardFile[] {
  return writtenStems(t).map((stem) => ({ stem, loop, name: loopFileName(t.name, n, count, x100, t.stems.length > 1 ? stem.tag : "") }));
}

/**
 * Write `files` into `folder` (a new one when null), one by one with progress; "Stop" ends after
 * the file being written. Then the card browser shows the folder. Returns how many were written.
 */
async function writeFiles(files: CardFile[], folder: string | null): Promise<number> {
  const t = slTrack.value!;
  stopPlay();
  cancel = false;
  const fade = Math.round((slFadeMs.value * RATE) / 1000);
  const busy = (text: string, progress: number) => { slBusy.value = { text, progress }; cardBusy.value = { text, progress }; };
  let done = 0;
  try {
    if (!folder) {
      busy("Creating folder…", 0);
      folder = await newFolder(t);
    }
    for (const [i, { stem, loop, name }] of files.entries()) {
      if (cancel) break;
      const text = files.length > 1 ? `Writing ${i + 1} of ${files.length}: ${name}` : `Writing ${name}`;
      busy(text, i / files.length);
      const data = new Uint8Array(encodeWav(extractLoop(stem.samples, stem.channels, loop, fade), stem.channels));
      await withDevice((d) => d.writeCardFile(`${CARD}/IMPORT/${folder}${subOf(t, stem)}/${name}`, data, (a, b) => busy(text, (i + a / b) / files.length)));
      done++;
    }
  } catch (e) {
    notice.value = { kind: "error", text: `Write to card: ${(e as Error).message}` };
  } finally {
    slBusy.value = null;
    cardBusy.value = null;
  }
  if (folder) {
    showSide("card");
    await openCardDir(["IMPORT", folder]);
  }
  return done;
}

const where = (t: Track) => `IMPORT/${folderOf!.name}/${t.stems.length > 1 ? ` (${writtenStems(t).map((x) => `${x.label}/`).join(", ")})` : ""}`;

/** The chosen loops as WAV files in a new folder IMPORT/<track>/ on the card (a subfolder per stem); then the card browser shows it. */
export async function writeLoops(): Promise<void> {
  const t = slTrack.value, g = slGrid.value, loops = slChosen.value;
  if (!t || !g || slWriteBlock.value) return;
  const files = loops.flatMap((l, i) => filesOf(t, g.x100, l, i + 1, loops.length));
  const done = await writeFiles(files, null);
  if (!done) return;
  log("info", `Slicer: ${done} of ${files.length} files at ${formatBpm(g.x100)} BPM → ${where(t)}`);
  notice.value = { kind: "info", text: `${done} file${done === 1 ? "" : "s"} written to ${where(t)} on the card${done < files.length ? " (stopped)" : ""}. Drag them from the card onto pads.` };
}

/**
 * The loop's number in file names: its place among the chosen loops (as the list shows it), or
 * among all loops when it is not chosen; and how many that counts.
 */
function loopNumber(bar: number): { n: number; count: number } {
  const chosen = slChosen.value.findIndex((l) => l.bar === bar);
  return chosen >= 0 ? { n: chosen + 1, count: slChosen.value.length } : { n: slLoops.value.findIndex((l) => l.bar === bar) + 1, count: slLoops.value.length };
}

/**
 * One loop (in every stem) to the card: into the folder already made for this track in this
 * session (missing subfolders made again; a new folder when it is gone), else a new
 * IMPORT/<track>/. When a name is taken there, every stem's file gets the same `_2`, `_3`…
 */
export async function writeOne(bar: number): Promise<void> {
  const t = slTrack.value, g = slGrid.value, loop = slLoops.value.find((l) => l.bar === bar);
  if (!t || !g || !loop || slCardBlock.value || slStemBlock.value) return;
  let folder: string | null = null, taken: string[] = [];
  try {
    if (folderOf?.track === t.id) {
      const root = `${CARD}/IMPORT/${folderOf.name}`;
      const there = await withDevice(async (d) => {
        if (!(await d.stat(root))) return null;
        const names: string[] = [];
        for (const stem of writtenStems(t)) {
          const path = root + subOf(t, stem);
          if (!(await d.stat(path))) await d.mkdirCard(path);
          names.push(...(await d.listDir(path)).map((e) => e.name.toLowerCase()));
        }
        return names;
      });
      if (there) { folder = folderOf.name; taken = there; }
    }
  } catch (e) {
    return void (notice.value = { kind: "error", text: `Write to card: ${(e as Error).message}` });
  }
  const { n, count } = loopNumber(bar);
  const plain = filesOf(t, g.x100, loop, n, count);
  const named = (k: number) => plain.map((f) => ({ ...f, name: k === 1 ? f.name : f.name.replace(/\.wav$/, `_${k}.wav`) }));
  let k = 1;
  while (named(k).some((f) => taken.includes(f.name.toLowerCase()))) k++;
  const files = named(k);
  if (!(await writeFiles(files, folder))) return;
  log("info", `Slicer: bars ${loop.bar}–${loop.bar + loop.bars - 1} → ${where(t)}: ${files.map((f) => f.name).join(", ")}`);
  notice.value = { kind: "info", text: `${files.length > 1 ? `${files.length} files` : files[0]!.name} written to ${where(t)} on the card` };
}

export function cancelWrite(): void {
  cancel = true;
}

// Listening stops when the slicer leaves the screen (after `source` above exists: the effect runs at once).
effect(() => { if (mainView.value !== "slicer") stopPlay(); });
