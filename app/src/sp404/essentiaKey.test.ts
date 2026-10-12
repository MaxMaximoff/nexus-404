import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { analyzeEssentiaKey, essentiaLabel, monoForEssentia } from "./essentiaKey";
import { keyName } from "./key";

// Essentia's Node build looks for its folder in __dirname, which ES modules lack.
(globalThis as { __dirname?: string }).__dirname ??= fileURLToPath(new URL("../../node_modules/essentia.js/dist/", import.meta.url));

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
}

/**
 * Stereo 16-bit PCM of chords (semitones from C, the first one the root), each for `bars` bars at
 * 120 BPM, as tones with five harmonics plus the root an octave below; a kick on every beat and a
 * noise snare on 2 and 4 over it.
 */
function chords(prog: { notes: number[]; bars: number }[], repeats: number, rate = 48000): Int16Array {
  const bar = 2, total = prog.reduce((s, c) => s + c.bars, 0) * bar * repeats, n = Math.round(total * rate);
  const out = new Float64Array(n), rand = rng(1);
  const hz = (semi: number, octave: number) => 440 * 2 ** ((semi - 9) / 12 + (octave - 4));
  let t0 = 0;
  for (let r = 0; r < repeats; r++)
    for (const c of prog) {
      const a = Math.round(t0 * rate), len = Math.round(c.bars * bar * rate);
      for (const v of [...c.notes.map((s) => ({ f: hz(s, 3), amp: 0.08 })), { f: hz(c.notes[0]!, 2), amp: 0.12 }])
        for (let h = 1; h <= 5; h++) {
          const w = (2 * Math.PI * v.f * h) / rate, amp = v.amp / h;
          for (let i = 0; i < len; i++) out[a + i]! += Math.sin(w * i) * amp;
        }
      t0 += c.bars * bar;
    }
  for (let b = 0; b * 0.5 < total; b++) {
    const a = Math.round(b * 0.5 * rate);
    for (let i = 0; i < rate / 4 && a + i < n; i++) {
      const t = i / rate;
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
/** I–IV–V–I in C, i–iv–V–i in A minor. */
const major = (k: number) => chords([{ notes: up(MAJ(0), k), bars: 2 }, { notes: up(MAJ(5), k), bars: 1 }, { notes: up(MAJ(7), k), bars: 1 }], 2);
const minor = (k: number, rate = 48000) => chords([{ notes: up(MIN(9), k), bars: 2 }, { notes: up(MIN(14), k), bars: 1 }, { notes: up(MAJ(16), k), bars: 1 }], 2, rate);

describe("Essentia adapter", () => {
  it("mixes interleaved 16-bit PCM to mono float", () => {
    expect(Array.from(monoForEssentia(new Int16Array([32767, -32767, -32768, -32768]), 2))).toEqual([0, -1]);
    expect(Array.from(monoForEssentia(new Int16Array([16384]), 1))).toEqual([0.5]);
    expect(() => monoForEssentia(new Int16Array(3), 2)).toThrow();
    expect(() => monoForEssentia(new Int16Array(2), 0)).toThrow();
  });

  it("maps Essentia's labels to tonic and major/minor, nothing more", () => {
    expect(essentiaLabel({ key: "F#", scale: "minor", strength: 0.8 })).toEqual({ tonic: 6, minor: true, strength: 0.8, source: "essentia-edma" });
    expect(essentiaLabel({ key: "Bb", scale: "major", strength: 0.7 })?.tonic).toBe(10);
    expect(essentiaLabel({ key: "Cb", scale: "major", strength: 0.7 })?.tonic).toBe(11);
    // Essentia says "no key" with a strength of −1 (it answers "A minor" for silence).
    expect(essentiaLabel({ key: "A", scale: "minor", strength: -1 })).toBeNull();
    expect(essentiaLabel({ key: "C", scale: "majmin", strength: 0.8 })).toBeNull();
    expect(() => essentiaLabel({ key: "C", scale: "major", strength: NaN })).toThrow();
  });

  it("refuses empty audio and a bad sample rate", async () => {
    await expect(analyzeEssentiaKey(new Int16Array(0), 2, 48000)).rejects.toThrow("Empty audio");
    await expect(analyzeEssentiaKey(new Int16Array(2), 2, 0)).rejects.toThrow("sample rate");
  });
});

// The real Essentia (WASM) on synthetic chords: the wiring (PCM, mono, rate, labels), not a
// judgement of its accuracy on music.
describe("Essentia KeyExtractor", () => {
  it("finds a major and a minor key in every transposition", async () => {
    for (let k = 0; k < 12; k++) {
      expect(keyName((await analyzeEssentiaKey(major(k), 2, 48000)).key!)).toBe(keyName({ tonic: k, minor: false }));
      expect(keyName((await analyzeEssentiaKey(minor(k), 2, 48000)).key!)).toBe(keyName({ tonic: (9 + k) % 12, minor: true }));
    }
  }, 60000);

  it("takes the audio's own sample rate", async () => {
    const pcm = minor(0, 32000);
    expect(keyName((await analyzeEssentiaKey(pcm, 2, 32000)).key!)).toBe("Am");
    expect(keyName((await analyzeEssentiaKey(pcm, 2, 48000)).key!)).not.toBe("Am"); // read as 48 kHz it is a fifth higher
  });

  it("gives no key for silence, and reports the backend", async () => {
    const r = await analyzeEssentiaKey(new Int16Array(48000 * 4), 1, 48000);
    expect(r.key).toBeNull();
    expect(r.backend).toMatch(/\d/);
    expect(r.coldStart).toBe(false);
  });
});
