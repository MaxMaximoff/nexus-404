// Clean-up of separated stems (UVR and the like), all on the host and in step with the original
// (nothing is delayed, so the beat grid still fits):
//   - the voice: a low cut (kick and bass leaking in), a split-band de-esser on the "s" band, a
//     soft high shelf against the "digital" top;
//   - the music (instrumental, drums, other…): the "s" band ducked only while the voice stem has
//     a sibilant — the voice's own leftovers in the music sit right there, and hats elsewhere are
//     left alone; the same soft high shelf;
//   - the bass: nothing.
// Each band is split off as x − highpass(x), so a band left at full gain puts the input back exactly.

const RATE = 48000;

export type CleanLevel = "light" | "medium" | "strong";
export type CleanRole = "voice" | "music" | "none";

interface Settings {
  lowCut: number; // Hz, voice
  deEssRel: number; // dB: the "s" band within this of the voice's whole level counts as sibilant
  deEssRatio: number;
  deEssMax: number; // dB of reduction at most
  duckThr: number; // dBFS of the voice's "s" band where ducking of the music starts
  duckSlope: number; // dB of ducking per dB above it
  duckMax: number; // dB at most
  shelf: number; // dB at 10 kHz and up (negative: down)
}

export const CLEAN_SETTINGS: Record<CleanLevel, Settings> = {
  light: { lowCut: 70, deEssRel: -4, deEssRatio: 2.5, deEssMax: 5, duckThr: -40, duckSlope: 0.4, duckMax: 4, shelf: -1 },
  medium: { lowCut: 90, deEssRel: -6, deEssRatio: 3.5, deEssMax: 8, duckThr: -44, duckSlope: 0.5, duckMax: 7, shelf: -2 },
  strong: { lowCut: 110, deEssRel: -8, deEssRatio: 5, deEssMax: 12, duckThr: -48, duckSlope: 0.6, duckMax: 10, shelf: -3.5 },
};

/** Where the "s" band starts: detection (voice) and the band that is turned down. */
const S_DETECT_HZ = 5000;
const S_BAND_HZ = 4500;
const SHELF_HZ = 10000;
/** Envelope times: the level follows a sibilant within 1.5 ms and lets go over 60 ms. */
const ATTACK_S = 0.0015;
const RELEASE_S = 0.06;
/** Below this the voice's "s" band is silence, not a sibilant. */
const S_FLOOR_DB = -60;

export interface CleanInput { samples: Int16Array; channels: number; role: CleanRole }

/**
 * Clean every stem by its role; the music is ducked by the first voice stem. Returns new PCM per
 * stem (a stem with role "none" comes back as it is).
 */
export function cleanStems(stems: CleanInput[], level: CleanLevel): Int16Array[] {
  const set = CLEAN_SETTINGS[level];
  const voice = stems.find((s) => s.role === "voice");
  const key = voice ? sibilance(voice) : null;
  return stems.map((s) => {
    if (s.role === "none") return s.samples;
    const chans = split(s);
    if (s.role === "voice") {
      const de = sibilance(s);
      for (const ch of chans) {
        highpass2(ch, set.lowCut);
        bandGain(ch, S_BAND_HZ, (i) => deEssGain(de, i, set));
      }
    } else if (key) {
      for (const ch of chans) bandGain(ch, S_BAND_HZ, (i) => duckGain(key, i, set));
    }
    for (const ch of chans) highShelf(ch, SHELF_HZ, set.shelf);
    return join(chans, s.channels);
  });
}

/** The voice's level over time, in dB: the "s" band and the whole signal (mono, per frame). */
interface Sibilance { band: Float32Array; whole: Float32Array }

function sibilance(s: CleanInput): Sibilance {
  const n = Math.floor(s.samples.length / s.channels);
  const mono = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let c = 0; c < s.channels; c++) v += s.samples[i * s.channels + c]!;
    mono[i] = v / (32768 * s.channels);
  }
  const band = Float32Array.from(mono);
  highpass2(band, S_DETECT_HZ);
  return { band: envelopeDb(band), whole: envelopeDb(mono) };
}

/** Gain (linear) of the voice's own "s" band: reduced while it is close to the whole level. */
function deEssGain(s: Sibilance, i: number, set: Settings): number {
  const b = s.band[i]!;
  if (b < S_FLOOR_DB) return 1;
  const over = b - s.whole[i]! - set.deEssRel;
  return over > 0 ? dbToGain(-Math.min(set.deEssMax, over * (1 - 1 / set.deEssRatio))) : 1;
}

/** Gain (linear) of the music's "s" band while the voice has a sibilant. */
function duckGain(s: Sibilance, i: number, set: Settings): number {
  const b = s.band[i]!;
  // A sibilant: the band loud enough and a large part of the voice (not just the top of a vowel).
  if (b < set.duckThr || b - s.whole[i]! < set.deEssRel - 6) return 1;
  return dbToGain(-Math.min(set.duckMax, (b - set.duckThr) * set.duckSlope));
}

const dbToGain = (db: number) => 10 ** (db / 20);

/** Peak envelope in dB (instant attack within ATTACK_S, release over RELEASE_S). */
function envelopeDb(x: Float32Array): Float32Array {
  const a = Math.exp(-1 / (ATTACK_S * RATE)), r = Math.exp(-1 / (RELEASE_S * RATE));
  const out = new Float32Array(x.length);
  let e = 0;
  for (let i = 0; i < x.length; i++) {
    const v = Math.abs(x[i]!);
    e = v > e ? a * e + (1 - a) * v : r * e + (1 - r) * v;
    out[i] = 20 * Math.log10(e + 1e-9);
  }
  return out;
}

/**
 * The band above `hz` (2nd-order high-pass) at `gain(i)`, the rest as it was: x − hp + hp·g.
 * The gain is smoothed (1 ms) so it does not click.
 */
function bandGain(x: Float32Array, hz: number, gain: (i: number) => number): void {
  const hp = Float32Array.from(x);
  highpass2(hp, hz);
  const k = Math.exp(-1 / (0.001 * RATE));
  let g = 1;
  for (let i = 0; i < x.length; i++) {
    g = k * g + (1 - k) * gain(i);
    x[i] = x[i]! + hp[i]! * (g - 1);
  }
}

/** RBJ biquad, in place. */
function biquad(x: Float32Array, b0: number, b1: number, b2: number, a0: number, a1: number, a2: number): void {
  const n0 = b0 / a0, n1 = b1 / a0, n2 = b2 / a0, d1 = a1 / a0, d2 = a2 / a0;
  let z1 = 0, z2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i]!, y = n0 * v + z1;
    z1 = n1 * v - d1 * y + z2;
    z2 = n2 * v - d2 * y;
    x[i] = y;
  }
}

/** 2nd-order Butterworth high-pass at `hz`, in place. */
function highpass2(x: Float32Array, hz: number): void {
  const w = (2 * Math.PI * hz) / RATE, c = Math.cos(w), al = Math.sin(w) / (2 * Math.SQRT1_2);
  biquad(x, (1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + al, -2 * c, 1 - al);
}

/** High shelf at `hz` by `db` (slope 1), in place; 0 dB leaves it as it is. */
function highShelf(x: Float32Array, hz: number, db: number): void {
  if (!db) return;
  const A = 10 ** (db / 40), w = (2 * Math.PI * hz) / RATE, c = Math.cos(w), s = Math.sin(w);
  const al = (s / 2) * Math.SQRT2, sq = 2 * Math.sqrt(A) * al;
  biquad(x,
    A * (A + 1 + (A - 1) * c + sq), -2 * A * (A - 1 + (A + 1) * c), A * (A + 1 + (A - 1) * c - sq),
    A + 1 - (A - 1) * c + sq, 2 * (A - 1 - (A + 1) * c), A + 1 - (A - 1) * c - sq);
}

function split(s: CleanInput): Float32Array[] {
  const n = Math.floor(s.samples.length / s.channels);
  return Array.from({ length: s.channels }, (_, c) => {
    const ch = new Float32Array(n);
    for (let i = 0; i < n; i++) ch[i] = s.samples[i * s.channels + c]! / 32768;
    return ch;
  });
}

function join(chans: Float32Array[], channels: number): Int16Array {
  const n = chans[0]!.length, out = new Int16Array(n * channels);
  for (let c = 0; c < channels; c++)
    for (let i = 0; i < n; i++) out[i * channels + c] = Math.max(-32768, Math.min(32767, Math.round(chans[c]![i]! * 32768)));
  return out;
}
