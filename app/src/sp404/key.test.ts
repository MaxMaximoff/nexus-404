import { describe, expect, it } from "vitest";
import { camelot, detectKey, keyName } from "./key";

const RATE = 48000;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
}

/**
 * A track of chords: each chord (semitones from C, the first one the root) for `bars` bars at
 * 120 BPM, as tones with five harmonics plus the root an octave below as a bass; a kick on
 * every beat and a noise snare on 2 and 4 over it. `cents` detunes everything.
 */
function chords(prog: { notes: number[]; bars: number }[], repeats: number, cents = 0, seed = 1): Int16Array {
  const bar = 2, total = prog.reduce((s, c) => s + c.bars, 0) * bar * repeats, n = Math.round(total * RATE);
  const out = new Float64Array(n), rand = rng(seed), tune = 2 ** (cents / 1200);
  const hz = (semi: number, octave: number) => 440 * tune * 2 ** ((semi - 9) / 12 + (octave - 4));
  let t0 = 0;
  for (let r = 0; r < repeats; r++)
    for (const c of prog) {
      const a = Math.round(t0 * RATE), len = Math.round(c.bars * bar * RATE);
      const voices = [...c.notes.map((s) => ({ f: hz(s, 3), amp: 0.08 })), { f: hz(c.notes[0]!, 2), amp: 0.12 }];
      for (const v of voices)
        for (let h = 1; h <= 5; h++) {
          const w = (2 * Math.PI * v.f * h) / RATE, amp = v.amp / h;
          for (let i = 0; i < len; i++) out[a + i]! += Math.sin(w * i) * amp;
        }
      t0 += c.bars * bar;
    }
  for (let b = 0; b * 0.5 < total; b++) {
    const a = Math.round(b * 0.5 * RATE);
    for (let i = 0; i < 12000 && a + i < n; i++) {
      const t = i / RATE;
      out[a + i]! += Math.sin(2 * Math.PI * (50 + 80 * Math.exp(-t * 30)) * t) * Math.exp(-t * 12) * 0.5 + (b % 2 ? rand() * Math.exp(-t * 25) * 0.25 : 0);
    }
  }
  const pcm = new Int16Array(n * 2);
  for (let i = 0; i < n; i++) pcm[2 * i] = pcm[2 * i + 1] = Math.max(-32768, Math.min(32767, Math.round(out[i]! * 32767)));
  return pcm;
}

const up = (notes: number[], k: number) => notes.map((x) => x + k);
const MAJ = (root: number) => [root, root + 4, root + 7];
const MIN = (root: number) => [root, root + 3, root + 7];

describe("key detection", () => {
  it("finds a major key in every transposition (I–IV–V–I)", () => {
    for (let k = 0; k < 12; k++) {
      const pcm = chords([{ notes: up(MAJ(0), k), bars: 2 }, { notes: up(MAJ(5), k), bars: 1 }, { notes: up(MAJ(7), k), bars: 1 }], 3);
      const r = detectKey(pcm, 2)!;
      expect(keyName(r)).toBe(keyName({ tonic: k, minor: false }));
    }
  });

  it("finds a minor key in every transposition (i–iv–V–i)", () => {
    for (let k = 0; k < 12; k++) {
      const pcm = chords([{ notes: up(MIN(9), k), bars: 2 }, { notes: up(MIN(14), k), bars: 1 }, { notes: up(MAJ(16), k), bars: 1 }], 3);
      const r = detectKey(pcm, 2)!;
      expect(keyName(r)).toBe(keyName({ tonic: (9 + k) % 12, minor: true }));
    }
  });

  it("tells A minor from C major when the minor chord is home (i–VI–VII–i)", () => {
    const r = detectKey(chords([{ notes: MIN(9), bars: 2 }, { notes: MAJ(5), bars: 1 }, { notes: MAJ(7), bars: 1 }], 4), 2)!;
    expect(keyName(r)).toBe("Am");
  });

  it("follows a track tuned off A = 440", () => {
    const r = detectKey(chords([{ notes: MIN(9), bars: 2 }, { notes: MIN(14), bars: 1 }, { notes: MAJ(16), bars: 1 }], 3, 35), 2)!;
    expect(keyName(r)).toBe("Am");
    expect(Math.abs(r.cents - 35)).toBeLessThanOrEqual(5);
  });

  it("finds no key in drums and noise", () => {
    const n = 20 * RATE, pcm = new Int16Array(n * 2), rand = rng(9);
    for (let i = 0; i < n; i++) pcm[2 * i] = pcm[2 * i + 1] = Math.round(rand() * 6000 * (i % 24000 < 4000 ? 1 : 0.2));
    expect(detectKey(pcm, 2)).toBeNull();
  });

  it("names keys and places them on the Camelot wheel", () => {
    expect([keyName({ tonic: 9, minor: true }), camelot({ tonic: 9, minor: true })]).toEqual(["Am", "8A"]);
    expect([keyName({ tonic: 0, minor: false }), camelot({ tonic: 0, minor: false })]).toEqual(["C", "8B"]);
    expect([keyName({ tonic: 8, minor: true }), camelot({ tonic: 8, minor: true })]).toEqual(["G#m", "1A"]);
    expect([keyName({ tonic: 11, minor: false }), camelot({ tonic: 11, minor: false })]).toEqual(["B", "1B"]);
    expect([keyName({ tonic: 6, minor: false }), camelot({ tonic: 6, minor: false })]).toEqual(["F#", "2B"]);
    expect([keyName({ tonic: 1, minor: true }), camelot({ tonic: 1, minor: true })]).toEqual(["C#m", "12A"]);
  });
});
