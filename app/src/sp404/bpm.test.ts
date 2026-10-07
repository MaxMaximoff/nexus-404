import { describe, expect, it } from "vitest";
import { detectBpm } from "./bpm";

const RATE = 48000;

/** Deterministic noise, so a failing case can be rerun. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
}

type Hit = { at: number; kind: "kick" | "snare" | "hat" | "click" };

/** Stereo 16-bit PCM of drum hits (seconds), over a little background noise. */
function render(hits: Hit[], seconds: number, seed = 1): Int16Array {
  const n = Math.round(seconds * RATE), mono = new Float64Array(n), rand = rng(seed);
  for (let i = 0; i < n; i++) mono[i] = rand() * 0.01;
  for (const h of hits) {
    const start = Math.round(h.at * RATE);
    const len = { kick: 0.25, snare: 0.15, hat: 0.04, click: 0.02 }[h.kind] * RATE;
    for (let i = 0; i < len && start + i < n; i++) {
      const t = i / RATE;
      mono[start + i]! += h.kind === "kick" ? Math.sin(2 * Math.PI * (50 + 80 * Math.exp(-t * 30)) * t) * Math.exp(-t * 12) * 0.8
        : h.kind === "snare" ? rand() * Math.exp(-t * 25) * 0.5
        : h.kind === "hat" ? rand() * Math.exp(-t * 120) * 0.25
        : rand() * Math.exp(-t * 300) * 0.7;
    }
  }
  const out = new Int16Array(n * 2);
  for (let i = 0; i < n; i++) out[2 * i] = out[2 * i + 1] = Math.max(-32768, Math.min(32767, Math.round(mono[i]! * 32767)));
  return out;
}

/** Kick on 1 and 3, snare on 2 and 4, hats on eighths; `offset` leaves silence before the first beat. */
function beat(bpm: number, seconds: number, offset = 0): Int16Array {
  const hits: Hit[] = [], beat = 60 / bpm;
  for (let b = 0; offset + b * beat < seconds; b++) {
    const t = offset + b * beat;
    hits.push({ at: t, kind: b % 2 ? "snare" : "kick" }, { at: t, kind: "hat" }, { at: t + beat / 2, kind: "hat" });
  }
  return render(hits, seconds);
}

const clicks = (bpm: number, seconds: number) =>
  render(Array.from({ length: Math.ceil((seconds * bpm) / 60) }, (_, b) => ({ at: (b * 60) / bpm, kind: "click" as const })), seconds);

describe("detectBpm", () => {
  it("finds a click track's tempo, folded into the range", () => {
    const r = detectBpm(clicks(93.2, 20.3), 2, 80)!;
    expect(r.x100).toBe(9320);
    const up = detectBpm(clicks(93.2, 20.3), 2, 100)!; // 100–199: twice the tempo
    expect(up).toMatchObject({ x100: 18640, beats: null }); // 63.06 beats long: close to whole, but not a loop
  });
  it("finds a drum pattern's tempo and settles the octave by the range", () => {
    for (const [bpm, min, want] of [[120, 80, 120], [174, 80, 87], [70, 100, 140], [96.5, 50, 96.5]] as const) {
      const r = detectBpm(beat(bpm, 17.1, 0.21), 2, min)!;
      expect(Math.abs(r.x100 - want * 100), `${bpm} BPM in ${min}–`).toBeLessThanOrEqual(20);
      expect(r.beats).toBeNull();
    }
  });
  it("snaps a loop to a whole number of beats", () => {
    expect(detectBpm(beat(128.37, (16 * 60) / 128.37), 2, 80)).toMatchObject({ x100: 12837, beats: 16 });
    expect(detectBpm(beat(87, (32 * 60) / 87), 2, 80)).toMatchObject({ x100: 8700, beats: 32 });
    expect(detectBpm(clicks(120, 4), 2, 80)).toMatchObject({ x100: 12000, beats: 8 }); // short: only 3 beats in the comb
  });
  it("pins the tempo down on a long sample", () => {
    expect(detectBpm(beat(101.3, 120, 0.3), 2, 80)!.x100).toBe(10130);
  });
  it("gives up on silence, noise and samples too short for a beat", () => {
    expect(detectBpm(new Int16Array(RATE * 10 * 2), 2, 80)).toBeNull();
    expect(detectBpm(render([], 10), 2, 80)).toBeNull();
    expect(detectBpm(clicks(120, 0.5), 2, 80)).toBeNull();
  });
});
