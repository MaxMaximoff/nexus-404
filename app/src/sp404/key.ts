// Key detection on the host (our own; the SP keeps no key: its pad parameter 89 is accepted but not
// stored, firmware 5.52):
//   1. mono mix, decimated to 12 kHz;
//   2. per 0.34 s frame (8192-point FFT, 1.5 Hz bins), the tonal peaks between A1 and A6 — local
//      maxima well above the spectrum around them, each at its exact frequency (parabolic
//      interpolation) — kept only when held into a neighbouring frame: drums and noise drop out;
//   3. the tuning: the track's mean offset from equal temperament at A = 440, so a track a little
//      sharp or flat still lands on its notes;
//   4. a pitch-class profile (chroma): every peak to its note, weighted by loudness and by how close
//      it is to the note, overtones of a lower note mostly dropped; frames weighed alike;
//   5. matched (correlation) against the 24 major and minor key profiles of Temperley
//      (Kostka–Payne): the best one gives the tonic;
//   6. the mode on that tonic: of the seven church modes, the harmonic minor and the Phrygian
//      dominant, the one whose
//      notes sound most and whose missing notes least; it also settles major or minor, by its third
//      (a Phrygian F minor may match the F major profile better than the F minor one).

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
/**
 * Harmonics that mislead the mode, as intervals in semitones above their fundamental: 5 and 10
 * (major third), 7 (minor seventh), 9 (second). Not 3 and 6 (the fifth): a chord's fifth an
 * octave and a fifth above its bass is common and belongs to the tonic triad anyway.
 */
const OVERTONES = [5, 7, 9, 10].map((n) => 12 * Math.log2(n));
/**
 * How near a harmonic's exact place a peak must be (semitones); how much stronger the lower peak
 * must be (a real harmonic is weaker than its fundamental, a played note on that place usually
 * is not); and what is left of an overtone.
 */
const OVERTONE_TOL = 0.3;
const OVERTONE_SOURCE = 1.5;
const OVERTONE_KEEP = 0.15;
/** The bass register: notes below this MIDI number (D3, 147 Hz). */
const BASS_BELOW = 50;
/** Weights of the tonic's evidence against the fit of the notes: its triad in the profile, and the bass on it. */
const TRIAD_WEIGHT = 1;
const BASS_WEIGHT = 1;
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

export type Mode = "ionian" | "dorian" | "phrygian" | "lydian" | "mixolydian" | "aeolian" | "harmonic" | "phrygianDominant" | "locrian";

/** The notes of each mode, in semitones from the tonic. */
export const MODES: Record<Mode, number[]> = {
  ionian: [0, 2, 4, 5, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  harmonic: [0, 2, 3, 5, 7, 8, 11],
  // The fifth mode of the harmonic minor: Phrygian with a major third (dark electronic, Eastern, flamenco).
  phrygianDominant: [0, 1, 4, 5, 7, 8, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10],
};

/** How a mode is called in the app: plain major and minor by those names. */
export const MODE_NAMES: Record<Mode, string> = {
  ionian: "major", dorian: "Dorian", phrygian: "Phrygian", lydian: "Lydian", mixolydian: "Mixolydian",
  aeolian: "minor", harmonic: "harmonic minor", phrygianDominant: "Phrygian dominant", locrian: "Locrian",
};

export interface KeyResult extends Key {
  /** The next best home note (another tonic, with its mode), and how far behind it is in the joint search. */
  alt: Key & { mode: Mode };
  altLead: number;
  /** Tuning offset from A = 440 in cents (−50..50). */
  cents: number;
  /** The mode on the tonic, the next best one, and how far ahead the first is (0..1; small = a guess). */
  mode: Mode;
  modeAlt: Mode;
  modeLead: number;
  /** The pitch-class profile, C = 0 … B = 11, summing to 1. */
  chroma: number[];
}

const NAMES = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
const MINOR_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "G#", "A", "Bb", "B"];

/** "Am", "F#m", "C", "Bb". */
export const keyName = (k: Pick<Key, "tonic" | "minor">): string => (k.minor ? `${MINOR_NAMES[k.tonic]}m` : NAMES[k.tonic]!);

/** A note's name as the key spells it (sharps in sharp minor keys). */
export const noteName = (pc: number, minor = false): string => (minor ? MINOR_NAMES : NAMES)[((pc % 12) + 12) % 12]!;

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
  if (all[0]!.score < MIN_SCORE) return null;
  // Tonic and mode together: the notes in the mode against those out of it, plus how much the
  // tonic's triad sounds and the bass sits on the tonic. The modes of one scale fit its notes
  // alike; the triad and the bass tell which note is home.
  const ranked = rankKeys(chroma.v, chroma.bass);
  const best = ranked[0]!, minor = MODES[best.mode].includes(3);
  const key = all.find((k) => k.tonic === best.tonic && k.minor === minor)!;
  const other = ranked.find((r) => r.tonic !== best.tonic)!;
  const alt = { tonic: other.tonic, minor: MODES[other.mode].includes(3), mode: other.mode, score: correlate(chroma.v, MODES[other.mode].includes(3) ? MINOR : MAJOR, other.tonic) };
  const sameTonic = ranked.find((r) => r.tonic === best.tonic && r.mode !== best.mode)!;
  return { ...key, alt, altLead: best.score - other.score, cents: chroma.cents, mode: best.mode, modeAlt: sameTonic.mode, modeLead: best.score - sameTonic.score, chroma: chroma.v };
}

/** Every tonic and mode, best first (see detectKey). */
export function rankKeys(chroma: number[], bass: number[] | null): { tonic: number; mode: Mode; score: number }[] {
  const out: { tonic: number; mode: Mode; score: number }[] = [];
  for (let tonic = 0; tonic < 12; tonic++)
    for (const mode of Object.keys(MODES) as Mode[]) {
      const notes = new Set(MODES[mode]), at = (i: number) => chroma[(tonic + i) % 12]!;
      let fit = 0;
      for (let i = 0; i < 12; i++) fit += (notes.has(i) ? 1 : -1) * at(i);
      const third = notes.has(3) ? 3 : 4, fifth = notes.has(7) ? 7 : 6;
      const triad = at(0) + at(third) + at(fifth);
      out.push({ tonic, mode, score: fit + TRIAD_WEIGHT * triad + BASS_WEIGHT * (bass ? bass[tonic]! : 0) });
    }
  return out.sort((a, b) => b.score - a.score);
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

/**
 * The chroma (12 values, summing to 1), the same for the bass register alone (below D3; null when
 * nothing sounds there) and the tuning offset; null when no tonal peak is found.
 */
function chromaOf(samples: Int16Array, channels: number, from: number, to: number): { v: number[]; bass: number[] | null; cents: number } | null {
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

  // Overtones: a rich tone (a saw bass) puts its own major third and minor seventh into the
  // spectrum (harmonics 5, 7…), which would make an F minor look like F7 — Mixolydian. A peak right
  // on such a harmonic of a clearly stronger lower peak is taken for an overtone and mostly
  // dropped. Octaves (2, 4, 8) are the same note and stay.
  const inFrame: Peak[][] = Array.from({ length: frames }, () => []);
  for (const p of peaks) inFrame[p.frame]!.push(p);
  for (const list of inFrame)
    for (const p of list)
      if (list.some((q) => q !== p && q.weight >= p.weight * OVERTONE_SOURCE && OVERTONES.some((h) => Math.abs(p.midi - q.midi - h) < OVERTONE_TOL)))
        p.weight *= OVERTONE_KEEP;

  // Tuning: the weighted circular mean of every peak's offset from its nearest semitone.
  let c = 0, s = 0;
  for (const p of peaks) { const ph = 2 * Math.PI * (p.midi - Math.round(p.midi)); c += p.weight * Math.cos(ph); s += p.weight * Math.sin(ph); }
  const shift = Math.atan2(s, c) / (2 * Math.PI); // in semitones, −0.5..0.5

  // Each frame's chroma, normalized so every frame weighs alike, then summed; the bass register too.
  const total = new Array<number>(12).fill(0), bassTotal = new Array<number>(12).fill(0);
  const frame = new Array<number>(12).fill(0), bassFrame = new Array<number>(12).fill(0);
  let at = -1;
  const flush = () => {
    for (const [f, t] of [[frame, total], [bassFrame, bassTotal]] as const) {
      const sum = f.reduce((x, y) => x + y, 0);
      if (sum > 0) for (let i = 0; i < 12; i++) t[i] += f[i]! / sum;
      f.fill(0);
    }
  };
  for (const p of peaks) {
    if (p.frame !== at) { flush(); at = p.frame; }
    const midi = p.midi - shift, n = Math.round(midi), dev = Math.abs(midi - n); // 0..0.5
    const w = p.weight * Math.cos(Math.PI * dev) ** 2, pc = ((n % 12) + 12) % 12;
    frame[pc] += w;
    if (n < BASS_BELOW) bassFrame[pc] += w;
  }
  flush();
  const norm = (t: number[]) => { const sum = t.reduce((x, y) => x + y, 0); return sum > 0 ? t.map((x) => x / sum) : null; };
  const v = norm(total);
  return v && { v, bass: norm(bassTotal), cents: Math.round(shift * 100) };
}
