// Cutting a long track into loops of whole bars. All of it happens here: decoding, the beat grid
// (gridWorker), where the cuts go, listening; the SP gets only the finished loops, written as WAV
// files to a new folder of IMPORT/ on the SD card. From there they go onto pads like any card file
// (drag from the card browser; the BPM is in each file name).

import { computed, effect, signal } from "@preact/signals";
import {
  BPM_MAX_X100, BPM_MIN_X100, BPM_RANGES, CARD, barFrames, computePeaks, decodeAudio, encodeWav, evenCuts, extractLoop, formatBpm, loopFileName,
  loopsFromCuts, padName, trackName, uniqueName, wholeBars, type BeatGrid, type Loop,
} from "../sp404";
import type { GridRequest } from "./gridWorker";
import { cardBusy, openCardDir, showSide, sideTab } from "./card";
import { mainView, showView } from "./Patterns";
import { bpmRange, conn, demo, log, notice, padPcm, pads, withDevice, writeBlockReason } from "./store";

const RATE = 48000;
const MAX_MINUTES = 15;
/** Columns of the precomputed waveform (zoomed views read the samples). */
export const OVERVIEW_COLS = 8192;

export interface Track {
  name: string;
  samples: Int16Array;
  channels: 1 | 2;
  frames: number;
  /** Min/max per column over the whole track, per channel. */
  peaks: Float32Array[];
  /** The pad it came from. */
  pad?: number;
  /** Tempo for a grid set by hand when no beat is found (the pad's BPM). */
  fallbackX100?: number;
}

export const slTrack = signal<Track | null>(null);
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

/** Decode a file and find its grid. */
export async function openTrack(file: File): Promise<void> {
  if (slBusy.value) return;
  stopPlay();
  const id = ++job;
  slState.value = "decoding";
  slGrid.value = slDetected.value = null;
  slTrack.value = null;
  try {
    const a = await decodeAudio(file);
    if (id !== job) return;
    setTrack({ name: file.name, samples: a.samples, channels: a.channels, frames: a.frames }, a.note);
    await analyze();
  } catch (e) {
    if (id !== job) return;
    slState.value = "idle";
    notice.value = { kind: "error", text: `${file.name}: ${(e as Error).message}` };
  }
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
    setTrack({ name: `${b.name || padName(pad)}.wav`, samples: pcm.samples, channels: pcm.channels === 1 ? 1 : 2, frames: pcm.frames, pad, fallbackX100: bpm }, `pad ${padName(pad)}`);
    await analyze();
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

function setTrack(t: Omit<Track, "peaks">, note: string): void {
  if (t.frames > MAX_MINUTES * 60 * RATE) throw new Error(`longer than ${MAX_MINUTES} minutes`);
  if (t.frames < 4 * RATE) throw new Error("shorter than 4 seconds: nothing to cut");
  slTrack.value = { ...t, peaks: computePeaks(t.samples, t.channels, OVERVIEW_COLS) };
  log("info", `Slicer: ${t.name}, ${note}, ${(t.frames / RATE / 60).toFixed(2)} min`);
}

/** Find the grid again (after the tempo range has changed). */
export async function analyze(): Promise<void> {
  const t = slTrack.value;
  if (!t) return;
  const id = ++job;
  slState.value = "analyzing";
  const minBpm = BPM_RANGES[bpmRange.value]![0];
  let grid: BeatGrid | null;
  try {
    worker ??= new Worker(new URL("./gridWorker.ts", import.meta.url), { type: "module" });
    grid = await new Promise<BeatGrid | null>((resolve, reject) => {
      worker!.onmessage = (e: MessageEvent<{ id: number; grid: BeatGrid | null }>) => { if (e.data.id === id) resolve(e.data.grid); };
      worker!.onerror = (e) => reject(new Error(e.message || "analysis failed"));
      worker!.postMessage({ id, samples: t.samples, channels: t.channels, minBpm } satisfies GridRequest);
    });
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
  if (grid) log("info", `Slicer: ${formatBpm(grid.x100)} BPM, bar 1 at ${(grid.origin / RATE).toFixed(3)} s, clarity ${grid.clarity.toFixed(2)}`);
  else notice.value = { kind: "info", text: "No clear beat found: set the tempo and bar 1 by hand" };
  slEvery.value = DEFAULT_EVERY;
  // No clear beat: a grid from the start (at the pad's BPM, or 120), to be set by hand.
  setGrid(grid ?? { x100: t.fallbackX100 ?? 12000, beatsPerBar: 4, origin: 0, clarity: 0 }, true);
  // A short sample (a pad's loop): fewer bars per loop until it gives at least two.
  for (const n of [2, 1]) if (slLoops.value.length < 2) cutEvery(n);
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

/** Play the loop starting at `bar` round and round; with `seam`, it and the next one once, to hear the joint. */
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
  const buf = ctx.createBuffer(t.channels, frames, RATE);
  const fade = Math.round((slFadeMs.value * RATE) / 1000);
  for (const [loop, at] of [[a, 0], ...(b ? [[b, a.frames]] : [])] as [Loop, number][]) {
    const pcm = extractLoop(t.samples, t.channels, loop, fade);
    for (let c = 0; c < t.channels; c++) {
      const ch = buf.getChannelData(c);
      for (let f = 0; f < loop.frames; f++) ch[at + f] = pcm[f * t.channels + c]! / 32768;
    }
  }
  if (slMetronome.value) addClicks(buf, g, a.start);
  const s = ctx.createBufferSource();
  s.buffer = buf;
  s.loop = !seam;
  s.connect(ctx.destination);
  s.onended = () => { if (source === s) { source = null; slPlay.value = null; } };
  source = s;
  const t0 = ctx.currentTime + 0.03;
  s.start(t0);
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

/** Why the loops cannot be written now, or null. */
export const slWriteBlock = computed<string | null>(() =>
  conn.value !== "ready" ? "SP is not connected" : demo.value ? "Demo: no SD card to write to"
    : writeBlockReason.value ?? (cardBusy.value && !slBusy.value ? "Card is busy — wait for the operation to finish" : null)
    ?? (!slChosen.value.length ? "No loops chosen" : null));

/** The chosen loops as WAV files in a new folder IMPORT/<track>/ on the card; then the card browser shows it. */
export async function writeLoops(): Promise<void> {
  const t = slTrack.value, g = slGrid.value, loops = slChosen.value;
  if (!t || !g || slWriteBlock.value || slBusy.value) return;
  stopPlay();
  cancel = false;
  const fade = Math.round((slFadeMs.value * RATE) / 1000);
  const busy = (text: string, progress: number) => { slBusy.value = { text, progress }; cardBusy.value = { text, progress }; };
  let folder = "", done = 0;
  try {
    busy("Creating folder…", 0);
    folder = await withDevice(async (d) => {
      const name = uniqueName(trackName(t.name), (await d.listDir(`${CARD}/IMPORT`)).map((e) => e.name));
      await d.mkdirCard(`${CARD}/IMPORT/${name}`);
      return name;
    });
    for (const [i, l] of loops.entries()) {
      if (cancel) break;
      const name = loopFileName(t.name, i + 1, loops.length, g.x100);
      const text = `Writing ${i + 1} of ${loops.length}: ${name}`;
      busy(text, i / loops.length);
      const data = new Uint8Array(encodeWav(extractLoop(t.samples, t.channels, l, fade), t.channels));
      await withDevice((d) => d.writeCardFile(`${CARD}/IMPORT/${folder}/${name}`, data, (a, b) => busy(text, (i + a / b) / loops.length)));
      done++;
    }
    log("info", `Slicer: ${done} of ${loops.length} loops at ${formatBpm(g.x100)} BPM → IMPORT/${folder}/`);
    notice.value = { kind: "info", text: `${done} loop${done === 1 ? "" : "s"} written to IMPORT/${folder}/ on the card${done < loops.length ? " (stopped)" : ""}. Drag them from the card onto pads.` };
  } catch (e) {
    notice.value = { kind: "error", text: `Write loops to card: ${(e as Error).message}` };
  } finally {
    slBusy.value = null;
    cardBusy.value = null;
  }
  if (folder) {
    showSide("card");
    await openCardDir(["IMPORT", folder]);
  }
}

export function cancelWrite(): void {
  cancel = true;
}

// Listening stops when the slicer leaves the screen (after `source` above exists: the effect runs at once).
effect(() => { if (mainView.value !== "slicer") stopPlay(); });
