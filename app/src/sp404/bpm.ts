// Tempo detection on the host, like the official app's Analyze BPM (the SP's own BPM SET AUTO
// cannot be started over USB). Our own algorithm, not the app's:
//   1. mono mix, decimated to 12 kHz;
//   2. onset envelope: spectral flux of log magnitudes (512-point FFT, hop 5.3 ms), minus its
//      local mean, smoothed;
//   3. autocorrelation of the envelope;
//   4. every tempo of the chosen one-octave range is scored by the autocorrelation at 1..K beat
//      lags (a comb), so the octave question is settled by the range, as on the SP;
//   5. a loop's length snaps the tempo to a whole number of beats when that fits as well.

const RATE = 48000;
const DECIMATE = 4;
const FFT = 512;
const HOP = 64;
const FPS = RATE / DECIMATE / HOP; // 187.5 envelope frames per second
/** At most this much audio is analysed; plenty for a tempo, and keeps it near a second. */
const MAX_SECONDS = 120;
/** Beat lags in the comb: the longer ones pin the tempo down finer on long samples. */
const MAX_COMB = 32;
/** Below this clarity there is no beat to speak of (plain noise scores about 0.06, beats 0.45+). */
const MIN_CLARITY = 0.15;

/** The ranges of the SP's BPM SET AUTO; a tempo is folded by octaves into [min, 2 × min). */
export const BPM_RANGES = [[100, 199], [80, 159], [70, 139], [50, 99]] as const;

export interface BpmResult {
  /** Detected tempo × 100, folded into the range. */
  x100: number;
  /** Whole beats over the length when the tempo was snapped to it (a loop), else null. */
  beats: number | null;
  /** Pulse strength: the best comb score as a share of the envelope's variance, 0–1; low = no clear beat. */
  clarity: number;
}

/**
 * Detect the tempo of interleaved 16-bit 48 kHz PCM. `minBpm` is the bottom of one of
 * BPM_RANGES. Returns null when the sample is too short or has no clear pulse.
 */
export function detectBpm(samples: Int16Array, channels: number, minBpm: number): BpmResult | null {
  const frames = Math.floor(samples.length / channels);
  return bpmOfEnvelope(onsetEnvelopes(samples, channels, Math.min(frames, MAX_SECONDS * RATE)).full, frames, minBpm);
}

/** detectBpm on an envelope already computed (its first MAX_SECONDS are used); `frames` is the whole length. */
export function bpmOfEnvelope(full: Float64Array, frames: number, minBpm: number): BpmResult | null {
  const env = full.subarray(0, Math.min(full.length, Math.ceil(MAX_SECONDS * FPS)));
  const n = env.length;
  const maxLag = (60 * FPS) / minBpm; // one beat at the slowest tempo of the range
  if (n * 0.6 < maxLag) return null;
  const k = Math.max(1, Math.min(MAX_COMB, Math.floor((n * 0.6) / maxLag)));
  const ac = autocorrelation(env, Math.ceil(k * maxLag) + 2);
  if (!(ac[0]! > 0)) return null;

  const score = (bpm: number) => {
    const lag = (60 * FPS) / bpm;
    let s = 0;
    for (let i = 1; i <= k; i++) s += at(ac, i * lag);
    return s / k;
  };
  // 0.01 BPM steps over the octave: ten thousand cheap lookups.
  let best = minBpm, bestScore = -Infinity;
  for (let x = minBpm * 100; x < minBpm * 200; x++) {
    const s = score(x / 100);
    if (s > bestScore) { bestScore = s; best = x / 100; }
  }
  if (!(bestScore > 0)) return null;
  const clarity = Math.min(1, bestScore / ac[0]!);
  if (clarity < MIN_CLARITY) return null;

  // A loop: its length in beats is (nearly) whole. Snap only within the detector's own precision,
  // about ¾ of an envelope hop over the longest lag of the comb (0.08 % at best), so a sample
  // that merely happens to be close keeps its tempo. A 4 s loop sees only 3 beats: ≈ 0.3 %.
  const tolerance = Math.max(0.0008, 0.75 / ((k * 60 * FPS) / best));
  const seconds = frames / RATE;
  const beats = Math.round((seconds * best) / 60);
  if (beats >= 2) {
    const snapped = (beats * 60) / seconds;
    if (Math.abs(snapped - best) <= best * tolerance && snapped >= minBpm && snapped < minBpm * 2)
      return { x100: Math.round(snapped * 100), beats, clarity };
  }
  return { x100: Math.round(best * 10) * 10, beats: null, clarity };
}

/** Linear interpolation into `a` at a fractional index. */
function at(a: Float64Array, x: number): number {
  const i = Math.floor(x), f = x - i;
  if (i + 1 >= a.length) return 0;
  return a[i]! * (1 - f) + a[i + 1]! * f;
}

/** Envelope frames per second; frame h covers the audio from h / ENV_FPS seconds on. */
export const ENV_FPS = FPS;
/** FFT bins 1..LOW_BINS (≈ 23–140 Hz): the kick drum, for finding the first beat of a bar. */
const LOW_BINS = 6;

export interface OnsetEnvelopes {
  /** Onset strength over all bands. */
  full: Float64Array;
  /** The same over the lowest bands only. */
  low: Float64Array;
}

/**
 * Onset strength per hop: half-wave rectified spectral flux of log magnitudes, detrended, smoothed;
 * over all bands and over the lowest ones. `frames` limits how much of the sample is analysed.
 */
export function onsetEnvelopes(samples: Int16Array, channels: number, frames = Math.floor(samples.length / channels)): OnsetEnvelopes {
  // Mono, decimated by averaging (a crude low-pass, enough for onsets).
  const m = new Float64Array(Math.floor(frames / DECIMATE));
  const scale = 1 / (32768 * channels * DECIMATE);
  for (let i = 0; i < m.length; i++) {
    let s = 0;
    const base = i * DECIMATE * channels;
    for (let j = 0; j < DECIMATE * channels; j++) s += samples[base + j]!;
    m[i] = s * scale;
  }
  const count = Math.max(0, Math.floor((m.length - FFT) / HOP) + 1);
  const flux = new Float64Array(count), lowFlux = new Float64Array(count);
  const win = new Float64Array(FFT).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT));
  const re = new Float64Array(FFT), im = new Float64Array(FFT);
  const bins = FFT / 2;
  let prev = new Float64Array(bins), cur = new Float64Array(bins);
  for (let f = 0; f < count; f++) {
    const off = f * HOP;
    for (let i = 0; i < FFT; i++) { re[i] = m[off + i]! * win[i]!; im[i] = 0; }
    fft(re, im);
    let s = 0, low = 0;
    for (let b = 1; b < bins; b++) {
      const v = Math.log1p(100 * Math.hypot(re[b]!, im[b]!));
      cur[b] = v;
      if (f > 0 && v > prev[b]!) { s += v - prev[b]!; if (b <= LOW_BINS) low += v - prev[b]!; }
    }
    flux[f] = s;
    lowFlux[f] = low;
    [prev, cur] = [cur, prev];
  }
  return { full: shape(flux), low: shape(lowFlux) };
}

function shape(flux: Float64Array): Float64Array {
  const count = flux.length;
  // Minus the local mean (≈ 0.25 s), rectified: keeps the attacks, drops loudness swells.
  const half = Math.round(FPS * 0.125);
  const prefix = new Float64Array(count + 1);
  for (let i = 0; i < count; i++) prefix[i + 1] = prefix[i]! + flux[i]!;
  const detr = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const a = Math.max(0, i - half), b = Math.min(count, i + half + 1);
    detr[i] = Math.max(0, flux[i]! - (prefix[b]! - prefix[a]!) / (b - a));
  }
  // Gaussian smoothing (σ = 1.5 hops) widens the peaks, so lags between hops still score.
  const r = 4, g = Array.from({ length: 2 * r + 1 }, (_, i) => Math.exp(-((i - r) ** 2) / (2 * 1.5 ** 2)));
  const out = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    let s = 0, w = 0;
    for (let j = -r; j <= r; j++) if (i + j >= 0 && i + j < count) { s += detr[i + j]! * g[j + r]!; w += g[j + r]!; }
    out[i] = s / w;
  }
  return out;
}

/** Unbiased autocorrelation of the mean-removed signal for lags 0..maxLag. */
function autocorrelation(x: Float64Array, maxLag: number): Float64Array {
  const n = x.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += x[i]!;
  mean /= n;
  const y = x.map((v) => v - mean);
  const ac = new Float64Array(Math.min(maxLag, n - 1) + 1);
  for (let lag = 0; lag < ac.length; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += y[i]! * y[i + lag]!;
    ac[lag] = s / (n - lag);
  }
  return ac;
}

/** In-place iterative radix-2 FFT (length a power of two). */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j]!, re[i]!]; [im[i], im[j]] = [im[j]!, im[i]!]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const a = i + j, b = a + len / 2;
        const tr = re[b]! * cr - im[b]! * ci, ti = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - tr; im[b] = im[a]! - ti;
        re[a] = re[a]! + tr; im[a] = im[a]! + ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}
