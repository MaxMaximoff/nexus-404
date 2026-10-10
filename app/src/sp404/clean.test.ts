import { describe, expect, it } from "vitest";
import { cleanStems } from "./clean";

const RATE = 48000;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
}

/** Mono PCM from a function of time (seconds) → −1..1. */
const pcm = (seconds: number, f: (t: number, i: number) => number) =>
  Int16Array.from({ length: Math.round(seconds * RATE) }, (_, i) => Math.round(Math.max(-1, Math.min(1, f(i / RATE, i))) * 32767));

/** RMS in dB of the part above `hz` (crude: a first difference, twice) over [a, b) seconds. */
function hiDb(x: Int16Array, a: number, b: number): number {
  let s = 0, n = 0;
  for (let i = Math.round(a * RATE) + 2; i < Math.round(b * RATE); i++, n++) { const d = x[i]! - 2 * x[i - 1]! + x[i - 2]!; s += d * d; }
  return 10 * Math.log10(s / n + 1e-9);
}
function rmsDb(x: Int16Array, a: number, b: number): number {
  let s = 0, n = 0;
  for (let i = Math.round(a * RATE); i < Math.round(b * RATE); i++, n++) s += x[i]! ** 2;
  return 10 * Math.log10(s / n + 1e-9);
}

/** A voice: a vowel (220 Hz with harmonics) 0–1 s, an "s" (noise above ~5 kHz) 1–1.25 s, then a vowel again. */
function voice(): Int16Array {
  const r = rng(1);
  let prev = 0;
  return pcm(2, (t) => {
    if (t >= 1 && t < 1.25) { const n = r(); const hp = n - prev; prev = n; return hp * 0.25; } // white noise, differenced: mostly highs
    return [1, 2, 3, 4].reduce((s, h) => s + Math.sin(2 * Math.PI * 220 * h * t) / h, 0) * 0.3;
  });
}

/** Music: a pad (tones) and hats (bright noise bursts) every 0.125 s all along. */
function music(): Int16Array {
  const r = rng(2);
  let prev = 0;
  return pcm(2, (t) => {
    const n = r(), hat = (n - prev) * Math.exp(-((t % 0.125) * 60)) * 0.3;
    prev = n;
    return Math.sin(2 * Math.PI * 110 * t) * 0.2 + hat;
  });
}

describe("stem clean-up", () => {
  it("de-esses the voice: the 's' goes down, the vowel stays", () => {
    const v = voice();
    const [out] = cleanStems([{ samples: v, channels: 1, role: "voice" }], "medium");
    expect(hiDb(v, 1.02, 1.23) - hiDb(out!, 1.02, 1.23)).toBeGreaterThan(3);
    expect(Math.abs(rmsDb(v, 0.3, 0.9) - rmsDb(out!, 0.3, 0.9))).toBeLessThan(0.5);
  });

  it("cuts the low end of the voice (kick and bass leaking in)", () => {
    const v = pcm(1, (t) => Math.sin(2 * Math.PI * 40 * t) * 0.5);
    const [out] = cleanStems([{ samples: v, channels: 1, role: "voice" }], "medium");
    expect(rmsDb(v, 0.3, 0.9) - rmsDb(out!, 0.3, 0.9)).toBeGreaterThan(6);
  });

  it("ducks the music's top only while the voice has an 's'", () => {
    const v = voice(), m = music();
    const [, out] = cleanStems([{ samples: v, channels: 1, role: "voice" }, { samples: m, channels: 1, role: "music" }], "medium");
    const during = hiDb(m, 1.02, 1.23) - hiDb(out!, 1.02, 1.23), elsewhere = hiDb(m, 0.2, 0.9) - hiDb(out!, 0.2, 0.9);
    expect(elsewhere).toBeLessThan(2.5); // hats elsewhere: only the soft shelf (−2 dB at "medium")
    expect(during - elsewhere).toBeGreaterThan(3); // during the "s": ducked on top of it
    expect(Math.abs(rmsDb(m, 1.02, 1.23) - rmsDb(out!, 1.02, 1.23))).toBeLessThan(3); // the pad under it stays
  });

  it("leaves the music alone without a voice stem but for the shelf, and the bass as it is", () => {
    const m = music();
    const [out, bass] = cleanStems([{ samples: m, channels: 1, role: "music" }, { samples: m, channels: 1, role: "none" }], "medium");
    const during = hiDb(m, 1.02, 1.23) - hiDb(out!, 1.02, 1.23), elsewhere = hiDb(m, 0.2, 0.9) - hiDb(out!, 0.2, 0.9);
    expect(during).toBeLessThan(2.5); // the shelf only
    expect(Math.abs(during - elsewhere)).toBeLessThan(0.5); // the same all along
    expect(bass).toBe(m);
  });

  it("does not move the sound in time (the grid must still fit)", () => {
    // A click at 0.5 s in a stereo music stem stays at 0.5 s.
    const n = RATE, x = new Int16Array(n * 2);
    x[2 * 24000] = x[2 * 24000 + 1] = 20000;
    const [out] = cleanStems([{ samples: x, channels: 2, role: "music" }], "strong");
    let at = 0, peak = 0;
    for (let i = 0; i < n; i++) if (Math.abs(out![2 * i]!) > peak) { peak = Math.abs(out![2 * i]!); at = i; }
    expect(Math.abs(at - 24000)).toBeLessThanOrEqual(2);
  });
});
