// Key detection on the host (our own; the SP keeps no key: its pad parameter 89 is accepted but not
// stored, firmware 5.52):
//   1. mono mix, decimated to 12 kHz;
//   2. per 0.34 s frame (8192-point FFT, 1.5 Hz bins), the tonal peaks between A1 and A6 — local
//      maxima well above the spectrum around them, each at its exact frequency (parabolic
//      interpolation) — kept only when held into a neighbouring frame: drums and noise drop out;
//   3. the tuning: the track's mean offset from equal temperament at A = 440, so a track a little
//      sharp or flat still lands on its notes;
//   4. a pitch-class profile (chroma): every peak to its note, weighted by loudness and by how close
//      it is to the note; frames weighed alike;
//   5. matched (correlation) against the 24 major and minor key profiles of Temperley
//      (Kostka–Payne); the best one, and the next best, which is often its relative or a fifth away.

import { fft } from "./bpm";

const RATE = 48000;
const DECIMATE = 4;
const SR = RATE / DECIMATE;
const FFT = 8192;
const HOP = 4096;
const F_LO = 55; // A1
const F_HI = 1760; // A6
/** A peak counts when it stands this many times above the spectrum's mean around it. */
const PEAK_OVER = 3;
/** The spectrum's mean around a bin is taken over this many bins either side (≈ 30 Hz). */
const AROUND = 20;
/** Below this correlation with the best key there is no key to speak of. */
const MIN_SCORE = 0.5;
/** Fewer held tonal peaks than this per frame: no tones to go by (drums, noise, speech). */
const MIN_TONES = 1;

// Temperley (2007), from the Kostka–Payne corpus; index 0 = the tonic.
const MAJOR = [0.748, 0.06, 0.488, 0.082, 0.67, 0.46, 0.096, 0.715, 0.104, 0.366, 0.057, 0.4];
const MINOR = [0.712, 0.084, 0.474, 0.618, 0.049, 0.46, 0.105, 0.747, 0.404, 0.067, 0.133, 0.33];

export interface Key {
  /** Pitch class of the tonic, C = 0 … B = 11. */
  tonic: number;
  minor: boolean;
  /** Correlation with this key's profile, −1..1. */
  score: number;
}

export interface KeyResult extends Key {
  /** The next best key, and its score. */
  alt: Key;
  /** Tuning offset from A = 440 in cents (−50..50). */
  cents: number;
}

const NAMES = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
const MINOR_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "G#", "A", "Bb", "B"];

/** "Am", "F#m", "C", "Bb". */
export const keyName = (k: Pick<Key, "tonic" | "minor">): string => (k.minor ? `${MINOR_NAMES[k.tonic]}m` : NAMES[k.tonic]!);

/** The key on the Camelot wheel DJs use: "8A" = A minor, "8B" = C major; neighbours mix well. */
export function camelot(k: Pick<Key, "tonic" | "minor">): string {
  const major = k.minor ? (k.tonic + 3) % 12 : k.tonic; // a minor key sits with its relative major
  return `${((major * 7 + 7) % 12) + 1}${k.minor ? "A" : "B"}`;
}

/**
 * The key of interleaved 16-bit 48 kHz PCM (frames [from, to) when given), or null when there
 * are no tones to go by.
 */
export function detectKey(samples: Int16Array, channels: number, from = 0, to = Math.floor(samples.length / channels)): KeyResult | null {
  const chroma = chromaOf(samples, channels, from, to);
  if (!chroma) return null;
  const all: Key[] = [];
  for (let tonic = 0; tonic < 12; tonic++)
    for (const minor of [false, true]) all.push({ tonic, minor, score: correlate(chroma.v, minor ? MINOR : MAJOR, tonic) });
  all.sort((a, b) => b.score - a.score);
  const best = all[0]!;
  if (best.score < MIN_SCORE) return null;
  return { ...best, alt: all[1]!, cents: chroma.cents };
}

/** Pearson correlation of `chroma` with `profile` turned to `tonic`. */
function correlate(chroma: number[], profile: number[], tonic: number): number {
  let ma = 0, mb = 0;
  for (let i = 0; i < 12; i++) { ma += chroma[i]!; mb += profile[i]!; }
  ma /= 12; mb /= 12;
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < 12; i++) {
    const a = chroma[(i + tonic) % 12]! - ma, b = profile[i]! - mb;
    ab += a * b; aa += a * a; bb += b * b;
  }
  return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0;
}

interface Peak { frame: number; midi: number; weight: number }

/** The chroma (12 values, summing to 1) and the tuning offset; null when no tonal peak is found. */
function chromaOf(samples: Int16Array, channels: number, from: number, to: number): { v: number[]; cents: number } | null {
  // Mono, decimated by averaging (a crude low-pass; 6 kHz is far above the notes looked at).
  const a = Math.max(0, from), b = Math.min(Math.floor(samples.length / channels), to);
  const m = new Float64Array(Math.max(0, Math.floor((b - a) / DECIMATE)));
  const scale = 1 / (32768 * channels * DECIMATE);
  for (let i = 0; i < m.length; i++) {
    let s = 0;
    const base = (a + i * DECIMATE) * channels;
    for (let j = 0; j < DECIMATE * channels; j++) s += samples[base + j]!;
    m[i] = s * scale;
  }
  const win = new Float64Array(FFT).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT));
  const re = new Float64Array(FFT), im = new Float64Array(FFT), mag = new Float64Array(FFT / 2);
  const lo = Math.floor((F_LO * FFT) / SR), hi = Math.ceil((F_HI * FFT) / SR);
  const peaks: Peak[] = [];
  let frames = 0;
  for (let off = 0; off + FFT <= m.length; off += HOP, frames++) {
    for (let i = 0; i < FFT; i++) { re[i] = m[off + i]! * win[i]!; im[i] = 0; }
    fft(re, im);
    for (let k = Math.max(1, lo - AROUND); k <= Math.min(FFT / 2 - 1, hi + AROUND + 1); k++) mag[k] = Math.hypot(re[k]!, im[k]!);
    // Running mean over ±AROUND bins.
    let sum = 0;
    const l0 = Math.max(1, lo - AROUND);
    for (let k = l0; k < l0 + 2 * AROUND + 1; k++) sum += mag[k]!;
    for (let k = lo; k <= hi; k++) {
      const mean = sum / (2 * AROUND + 1);
      if (mag[k]! > mag[k - 1]! && mag[k]! >= mag[k + 1]! && mag[k]! > mean * PEAK_OVER) {
        // Parabolic interpolation on the log magnitude: the peak's frequency between bins.
        const y0 = Math.log(mag[k - 1]! + 1e-12), y1 = Math.log(mag[k]! + 1e-12), y2 = Math.log(mag[k + 1]! + 1e-12);
        const d = (y0 - 2 * y1 + y2) !== 0 ? (0.5 * (y0 - y2)) / (y0 - 2 * y1 + y2) : 0;
        const f = ((k + Math.max(-0.5, Math.min(0.5, d))) * SR) / FFT;
        peaks.push({ frame: frames, midi: 69 + 12 * Math.log2(f / 440), weight: Math.sqrt(mag[k]!) });
      }
      sum += (mag[k + AROUND + 1] ?? 0) - (mag[k - AROUND] ?? 0);
    }
  }
  // A tone holds its pitch from one frame to the next; noise and drum hits throw peaks anywhere.
  // Only peaks with a peak within a quarter tone in a neighbouring frame are kept.
  const byFrame: number[][] = Array.from({ length: frames }, () => []);
  for (const p of peaks) byFrame[p.frame]!.push(p.midi);
  const held = (p: Peak) => [p.frame - 1, p.frame + 1].some((f) => byFrame[f]?.some((m) => Math.abs(m - p.midi) < 0.25));
  const stable = peaks.filter(held);
  if (stable.length < frames * MIN_TONES) return null;
  peaks.length = 0;
  peaks.push(...stable);

  // Tuning: the weighted circular mean of every peak's offset from its nearest semitone.
  let c = 0, s = 0;
  for (const p of peaks) { const ph = 2 * Math.PI * (p.midi - Math.round(p.midi)); c += p.weight * Math.cos(ph); s += p.weight * Math.sin(ph); }
  const shift = Math.atan2(s, c) / (2 * Math.PI); // in semitones, −0.5..0.5

  // Each frame's chroma, normalized so every frame weighs alike, then summed.
  const total = new Array<number>(12).fill(0);
  const frame = new Array<number>(12).fill(0);
  let at = -1;
  const flush = () => {
    const f = frame.reduce((x, y) => x + y, 0);
    if (f > 0) for (let i = 0; i < 12; i++) total[i] += frame[i]! / f;
    frame.fill(0);
  };
  for (const p of peaks) {
    if (p.frame !== at) { flush(); at = p.frame; }
    const midi = p.midi - shift, n = Math.round(midi), dev = Math.abs(midi - n); // 0..0.5
    frame[((n % 12) + 12) % 12] += p.weight * Math.cos(Math.PI * dev) ** 2;
  }
  flush();
  const sumAll = total.reduce((x, y) => x + y, 0);
  if (!(sumAll > 0)) return null;
  return { v: total.map((x) => x / sumAll), cents: Math.round(shift * 100) };
}
