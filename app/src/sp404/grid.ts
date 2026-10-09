// Beat grid of a long sample (a whole track), for cutting it into loops of whole bars. Everything
// is worked out here; the SP only gets the finished loops (as WAV files in a folder of IMPORT/ on
// the card, from where they go onto pads).
//   1. tempo from the first two minutes, as detectBpm;
//   2. refined over the whole track in 0.01 BPM steps, the SP's own resolution, so a loop cut at
//      the grid's tempo is as long as its BPM says: the onset envelope is folded over one beat at
//      each candidate tempo; the right one stacks the attacks into the highest peak, and the
//      peak's place is the beat phase (moved half a beat when the kick is there, not on it);
//   3. the first beat of a bar: of the beat phases where the kick lands as hard as anywhere (all of
//      them with four on the floor), the one where the bass and chords change, when one clearly
//      does; else the first one from the start of the music on. Often a guess; bar 1 can be set by hand.

import { bpmOfEnvelope, ENV_FPS, fft, onsetEnvelopes } from "./bpm";

const RATE = 48000;
/** Up to this many beats a sample whose length is a whole number of beats keeps that tempo. */
const LOOP_BEATS = 64;
/** In such a loop, a beat found this close to one of the loop's own beats is put on it. */
const LOOP_SNAP_S = 0.03;
/**
 * A bar may stick out of the sample by this much at either end and still count as whole (the
 * missing bit is silence): the tempo is kept to 0.01 BPM, so a bar's length can miss the
 * sample's by a few frames, and a pre-roll moves the first cut before the start.
 */
const EDGE_SLACK = Math.round(0.01 * RATE);
/** Refinement span around the first estimate, as a share of the tempo. */
const SPAN = 0.004;
/** Fold bins per envelope frame: phase resolution ¼ hop ≈ 1.3 ms. */
const FOLD_RES = 4;
/**
 * An attack shows in the envelope this much before it sounds: the FFT window it enters starts
 * earlier. Measured on synthetic drums (grid.test), within about ±1.5 ms.
 */
const ONSET_LEAD_S = 0.0303;
/** A beat phase counts as a bar's first beat when its kick is at least this share of the strongest. */
const DOWNBEAT_SHARE = 0.85;
/** The low band at half a beat from the found phase must outdo it by this much to move the beats there. */
const OFFBEAT_LEAD = 1.2;
/**
 * Among phases with an equal kick, the one where the sound changes most must lead the next by this
 * much (on synthetic drums: ×1.22 by chance with nothing changing, ×1.45 with a bass changing every 4 bars).
 */
const NOVELTY_LEAD = 1.3;
/** The music starts at the first beat at least this loud (RMS), as a share of the median beat. */
const START_SHARE = 0.25;

export interface BeatGrid {
  /** Tempo × 100. */
  x100: number;
  beatsPerBar: number;
  /** Frame of a bar line: the first downbeat from the start of the music on. Bars run both ways from it. */
  origin: number;
  /** Pulse strength from detectBpm, 0–1. */
  clarity: number;
}

/** Frames in one bar (fractional). */
export const barFrames = (g: Pick<BeatGrid, "x100" | "beatsPerBar">): number => (g.beatsPerBar * 60 * RATE * 100) / g.x100;

/**
 * The beat grid of interleaved 16-bit 48 kHz PCM; `minBpm` is the bottom of one of BPM_RANGES.
 * Null when there is no clear pulse.
 */
export function detectGrid(samples: Int16Array, channels: number, minBpm: number, beatsPerBar = 4): BeatGrid | null {
  const frames = Math.floor(samples.length / channels);
  const env = onsetEnvelopes(samples, channels, frames);
  const coarse = bpmOfEnvelope(env.full, frames, minBpm);
  if (!coarse) return null;

  let best = { x100: coarse.x100, phase: 0, peak: -Infinity };
  // A short loop (a whole number of beats long) already has its exact tempo, and too few beats for
  // the fold to do better.
  const loop = coarse.beats !== null && coarse.beats <= LOOP_BEATS;
  const lo = loop ? coarse.x100 : Math.max(minBpm * 100, Math.round(coarse.x100 * (1 - SPAN)));
  const hi = loop ? coarse.x100 : Math.min(minBpm * 200 - 1, Math.round(coarse.x100 * (1 + SPAN)));
  for (let x = lo; x <= hi; x++) {
    const f = fold(env.full, beatHops(x));
    if (f.peak > best.peak) best = { x100: x, ...f };
  }

  const period = beatHops(best.x100);
  // Bright off-beats (open hats) can outdo the kick over all bands: the beat is where the low band
  // hits harder, the found phase or half a beat from it, then the nearest peak over all bands.
  const low = foldMeans(env.low, period);
  if (peakNear(low, period, best.phase + period / 2, 1 / 16).peak > peakNear(low, period, best.phase, 1 / 16).peak * OFFBEAT_LEAD)
    best.phase = peakNear(foldMeans(env.full, period), period, (best.phase + period / 2) % period, 1 / 8).phase;
  // The first beat may sound right at the start, before its attack can show in the envelope.
  let phase = best.phase;
  while ((phase - period) / ENV_FPS + ONSET_LEAD_S >= -0.01) phase -= period; // within 10 ms of the start: at the start
  const count = Math.floor((env.full.length - 1 - phase) / period) + 1;
  if (count < beatsPerBar) return null;
  const beatAt = (k: number) => phase + k * period;
  const frameOf = (k: number) => (beatAt(k) / ENV_FPS + ONSET_LEAD_S) * RATE;
  // The music starts at the first beat from which a whole bar keeps sounding (by loudness: a lone
  // hit ringing out before the beat comes in does not count, and a beat right at the start, which
  // has no attack in the envelope, does).
  const loud = beatLoudness(samples, channels, Array.from({ length: count + 1 }, (_, k) => frameOf(k)));
  const enough = [...loud].sort((a, b) => a - b)[Math.floor(count / 2)]! * START_SHARE;
  const sounds = (k: number) => loud.slice(k, k + beatsPerBar).every((v) => v >= enough);
  let first = loud.findIndex((_, k) => sounds(k));
  if (first < 0) first = Math.max(0, loud.findIndex((v) => v >= enough));

  const kick = new Float64Array(beatsPerBar), seen = new Float64Array(beatsPerBar);
  for (let k = 0; k < count; k++) if (beatAt(k) >= 3) { kick[k % beatsPerBar] += near(env.low, beatAt(k)); seen[k % beatsPerBar]++; } // a beat at the start shows no kick
  for (let j = 0; j < beatsPerBar; j++) kick[j] /= seen[j] || 1;
  const strongest = Math.max(...kick);
  let cands = [...kick.keys()].filter((j) => kick[j]! >= strongest * DOWNBEAT_SHARE);
  // A kick on every beat (four on the floor) leaves several phases: the bass and the chords change
  // on a bar line, so the phase where a bar sounds most unlike the bar before wins, if clearly.
  if (cands.length > 1) {
    const nov = beatNovelty(samples, channels, Array.from({ length: count + 1 }, (_, k) => frameOf(k)), beatsPerBar);
    // Per bar, how far each phase's change stands above the bar's mean: a floor of drum noise
    // that is the same everywhere drops out, the bar lines where something new starts remain.
    const excess = new Float64Array(beatsPerBar);
    for (let k0 = beatsPerBar; k0 + 2 * beatsPerBar <= count; k0 += beatsPerBar) {
      let mean = 0;
      for (let j = 0; j < beatsPerBar; j++) mean += nov[k0 + j]! / beatsPerBar;
      for (let j = 0; j < beatsPerBar; j++) excess[j] += Math.max(0, nov[k0 + j]! - mean);
    }
    const score = cands.map((j) => ({ j, s: excess[j]! })).sort((a, b) => b.s - a.s);
    if (score[0]!.s >= score[1]!.s * NOVELTY_LEAD) cands = [score[0]!.j];
  }
  let down = first;
  while (!cands.includes(down % beatsPerBar)) down++;

  let origin = Math.max(0, Math.round(frameOf(down)));
  // A loop is cut on its beats: a beat found near one of them (the attack's place in the envelope
  // is an estimate) goes exactly there, so the bars fit the sample end to end.
  if (loop) {
    const beat = (60 * RATE * 100) / best.x100, k = Math.round(origin / beat);
    if (Math.abs(origin - k * beat) <= LOOP_SNAP_S * RATE) origin = Math.round(k * beat);
  }
  return { x100: best.x100, beatsPerBar, origin, clarity: coarse.clarity };
}

/** One beat in envelope frames at tempo × 100. */
const beatHops = (x100: number) => (60 * ENV_FPS * 100) / x100;

/** The envelope folded over `period` frames: its mean per fold bin (FOLD_RES bins per frame). */
function foldMeans(env: Float64Array, period: number): Float64Array {
  const bins = Math.ceil(period * FOLD_RES);
  const sum = new Float64Array(bins), weight = new Float64Array(bins);
  for (let i = 0; i < env.length; i++) {
    const pos = ((i % period) / period) * bins, a = Math.floor(pos), f = pos - a, b = (a + 1) % bins;
    sum[a] += env[i]! * (1 - f); weight[a] += 1 - f;
    sum[b] += env[i]! * f; weight[b] += f;
  }
  return sum.map((v, i) => (weight[i]! > 0 ? v / weight[i]! : 0));
}

/** The highest fold bin within `reach` (a share of the period) of `phase`: where it is (frames from 0) and its value. */
function peakNear(means: Float64Array, period: number, phase: number, reach: number): { phase: number; peak: number } {
  const bins = means.length, c = Math.round((phase / period) * bins), r = Math.floor(reach * bins);
  let at = c, peak = -Infinity;
  for (let d = -r; d <= r; d++) {
    const i = (((c + d) % bins) + bins) % bins;
    if (means[i]! > peak) { peak = means[i]!; at = i; }
  }
  return { phase: (at / bins) * period, peak };
}

/** The envelope folded over `period` frames: the highest mean and where it is. */
const fold = (env: Float64Array, period: number) => peakNear(foldMeans(env, period), period, period / 2, 0.5);

const NOV_DECIMATE = 4;
const NOV_FFT = 1024; // 85 ms at 12 kHz, 11.7 Hz per bin
const NOV_BINS = 128; // up to 1.5 kHz: bass and chords
/**
 * How much the sound changes at each beat: the log spectrum (below 1.5 kHz) averaged over the
 * `span` beats from it against the `span` beats before, summed absolute difference. With `span` a
 * bar, the drums are the same on both sides wherever the line is, so what counts is the bass and
 * the chords. `edges` are the frames where beats start (one more than the beats); beats without a
 * whole span on both sides score 0.
 */
function beatNovelty(samples: Int16Array, channels: number, edges: number[], span: number): Float64Array {
  const frames = Math.floor(samples.length / channels);
  const m = new Float64Array(Math.floor(frames / NOV_DECIMATE));
  const scale = 1 / (32768 * channels * NOV_DECIMATE);
  for (let i = 0; i < m.length; i++) {
    let s = 0;
    const base = i * NOV_DECIMATE * channels;
    for (let j = 0; j < NOV_DECIMATE * channels; j++) s += samples[base + j]!;
    m[i] = s * scale;
  }
  const win = new Float64Array(NOV_FFT).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / NOV_FFT));
  const re = new Float64Array(NOV_FFT), im = new Float64Array(NOV_FFT);
  const beats = edges.length - 1;
  // Each beat's mean spectrum; null when the beat is too short for one FFT or outside the audio.
  const spec = Array.from({ length: beats }, (_, k) => {
    const a = Math.max(0, Math.round(edges[k]! / NOV_DECIMATE)), b = Math.min(m.length, Math.round(edges[k + 1]! / NOV_DECIMATE));
    const out = new Float64Array(NOV_BINS);
    let n = 0;
    for (let off = a; off + NOV_FFT <= b; off += NOV_FFT / 2, n++) {
      for (let i = 0; i < NOV_FFT; i++) { re[i] = m[off + i]! * win[i]!; im[i] = 0; }
      fft(re, im);
      for (let j = 1; j <= NOV_BINS; j++) out[j - 1] += Math.log1p(100 * Math.hypot(re[j]!, im[j]!));
    }
    return n ? out.map((v) => v / n) : null;
  });
  const out = new Float64Array(beats);
  for (let k = span; k + span <= beats; k++) {
    const side = (from: number) => {
      const sum = new Float64Array(NOV_BINS);
      for (let i = from; i < from + span; i++) { const s = spec[i]; if (!s) return null; for (let j = 0; j < NOV_BINS; j++) sum[j] += s[j]!; }
      return sum;
    };
    const after = side(k), before = side(k - span);
    if (!after || !before) continue;
    let d = 0;
    for (let j = 0; j < NOV_BINS; j++) d += Math.abs(after[j]! - before[j]!) / span;
    out[k] = d;
  }
  return out;
}

/** RMS of each beat between neighbouring `edges` (frames; a sparse look is enough). */
function beatLoudness(samples: Int16Array, channels: number, edges: number[]): number[] {
  const frames = Math.floor(samples.length / channels);
  return edges.slice(1).map((end, k) => {
    const a = Math.max(0, Math.round(edges[k]!)), b = Math.min(frames, Math.round(end));
    let sum = 0, n = 0;
    for (let f = a; f < b; f += 4, n++) sum += samples[f * channels]! ** 2;
    return n ? Math.sqrt(sum / n) : 0;
  });
}

/** The highest envelope value within one frame of `x`. */
function near(env: Float64Array, x: number): number {
  const i = Math.round(Math.max(0, x));
  let m = 0;
  for (let j = Math.max(0, i - 1); j <= Math.min(env.length - 1, i + 1); j++) m = Math.max(m, env[j]!);
  return m;
}

// Bars are numbered from the grid's origin: bar 1 starts there, earlier bars are 0, −1, … A cut is
// the bar line where a bar starts; a loop is what lies between two neighbouring cuts, so loops of
// different lengths come from where the cuts are.

/**
 * Frame where `bar` starts, moved earlier by `preRoll` frames (for hits that come just before the
 * beat). Every bar line is placed from the origin on its own, so rounding never adds up.
 */
export const barEdge = (grid: BeatGrid, bar: number, preRoll = 0): number => Math.round(grid.origin + (bar - 1) * barFrames(grid)) - preRoll;

/** The first and last bars wholly inside `totalFrames`, give or take EDGE_SLACK (last < first when none is). */
export function wholeBars(grid: BeatGrid, totalFrames: number, preRoll = 0): { first: number; last: number } {
  const len = barFrames(grid);
  let first = Math.ceil(1 - (grid.origin - preRoll) / len);
  while (barEdge(grid, first, preRoll) < -EDGE_SLACK) first++;
  while (barEdge(grid, first - 1, preRoll) >= -EDGE_SLACK) first--;
  let last = Math.floor((totalFrames + preRoll - grid.origin) / len);
  while (barEdge(grid, last + 1, preRoll) > totalFrames + EDGE_SLACK) last--;
  while (barEdge(grid, last + 2, preRoll) <= totalFrames + EDGE_SLACK) last++;
  return { first, last };
}

/** Cuts every `bars` bars counted from bar 1, over the whole bars of the track. */
export function evenCuts(grid: BeatGrid, totalFrames: number, bars: number, preRoll = 0): number[] {
  const { first, last } = wholeBars(grid, totalFrames, preRoll);
  const out: number[] = [];
  for (let c = 1 + Math.ceil((first - 1) / bars) * bars; c <= last + 1; c += bars) out.push(c);
  return out;
}

export interface Loop {
  /** First frame (48 kHz) and length in frames. */
  start: number;
  frames: number;
  /** Its first bar, and how many bars it lasts. */
  bar: number;
  bars: number;
}

/** The loops between neighbouring cuts (bar numbers, any order). */
export function loopsFromCuts(grid: BeatGrid, cuts: Iterable<number>, preRoll = 0): Loop[] {
  const c = [...new Set(cuts)].sort((a, b) => a - b);
  return c.slice(1).map((end, i) => {
    const bar = c[i]!, start = barEdge(grid, bar, preRoll);
    return { start, frames: barEdge(grid, end, preRoll) - start, bar, bars: end - bar };
  });
}

/**
 * The track cut into loops of `bars` bars along the grid, only whole loops. Each lasts within a
 * frame of `bars` bars at the grid's tempo.
 */
export function loopsOf(grid: BeatGrid, totalFrames: number, bars: number, preRoll = 0): Loop[] {
  return loopsFromCuts(grid, evenCuts(grid, totalFrames, bars, preRoll), preRoll);
}

/** A loop's PCM (silence where it sticks out of the sample), with linear fades of `fade` frames at both ends against clicks (0 = a plain cut). */
export function extractLoop(samples: Int16Array, channels: number, loop: Pick<Loop, "start" | "frames">, fade = 0): Int16Array {
  // Whatever lies before the sample's start or after its end (EDGE_SLACK) is silence.
  const out = new Int16Array(loop.frames * channels);
  const from = Math.max(0, loop.start), to = Math.min(samples.length / channels, loop.start + loop.frames);
  if (to > from) out.set(samples.subarray(from * channels, to * channels), (from - loop.start) * channels);
  const n = Math.min(fade, Math.floor(loop.frames / 2));
  for (let i = 0; i < n; i++) {
    const g = i / n;
    for (let c = 0; c < channels; c++) {
      out[i * channels + c] = Math.round(out[i * channels + c]! * g);
      out[(loop.frames - 1 - i) * channels + c] = Math.round(out[(loop.frames - 1 - i) * channels + c]! * g);
    }
  }
  return out;
}

/** Longest pad name the SP keeps (the block has 24 bytes, zero-terminated). */
const PAD_NAME_MAX = 23;
const FOLDER_MAX = 32;

/** A track's file name as a short ASCII name fit for the card and the SP: no tempo, no extension. */
export function trackName(fileName: string, max = FOLDER_MAX): string {
  const s = fileName
    .replace(/\.[^.]+$/, "")
    .replace(/\d{2,3}(?:[.,]\d{1,2})?\s*[-_ ]?\s*bpm/gi, " ")
    .normalize("NFKD").replace(/[^\x20-\x7e]/g, "")
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/[\s_]+/g, "_")
    .replace(/^[-_.]+|[-_. ]+$/g, "");
  let cut = s.slice(0, max);
  const word = cut.lastIndexOf("_"); // cut at a word boundary when that keeps most of it
  if (s.length > max && word >= max / 2) cut = cut.slice(0, word);
  return cut.replace(/[-_.]+$/, "") || "track";
}

/** "93.47", "93.5", "90": the tempo as a file name carries it (bpmFromFileName reads it back). */
const bpmText = (x100: number) => (x100 / 100).toFixed(2).replace(/\.?0+$/, "");

/**
 * File name of loop `n` (1-based) of `count`: `track_07_93.47bpm.wav`. Short enough that the pad
 * keeps the whole name, tempo included, when it is imported.
 */
export function loopFileName(track: string, n: number, count: number, x100: number): string {
  const num = String(n).padStart(Math.max(2, String(count).length), "0");
  const tail = `_${num}_${bpmText(x100)}bpm`;
  return `${trackName(track, PAD_NAME_MAX - tail.length)}${tail}.wav`;
}

/** `name`, or `name_2`, `name_3`, … — the first one not among `taken` (compared without case). */
export function uniqueName(name: string, taken: Iterable<string>): string {
  const have = new Set([...taken].map((t) => t.toLowerCase()));
  if (!have.has(name.toLowerCase())) return name;
  for (let i = 2; ; i++) if (!have.has(`${name}_${i}`.toLowerCase())) return `${name}_${i}`;
}
