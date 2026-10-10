import { describe, expect, it } from "vitest";
import { barFrames, detectGrid, evenCuts, extractLoop, mixLoop, loopFileName, loopsFromCuts, loopsOf, trackName, uniqueName, wholeBars, type BeatGrid } from "./grid";
import { bpmFromFileName } from "./audio";

const RATE = 48000;

/** Deterministic noise, so a failing case can be rerun. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
}

type Kind = "kick" | "snare" | "hat";

/** Stereo 16-bit PCM of drum hits (seconds), over a little background noise. */
function render(hits: { at: number; kind: Kind }[], seconds: number, seed = 1): Int16Array {
  const n = Math.round(seconds * RATE), mono = new Float64Array(n), rand = rng(seed);
  for (let i = 0; i < n; i++) mono[i] = rand() * 0.01;
  for (const h of hits) {
    const start = Math.round(h.at * RATE);
    const len = { kick: 0.25, snare: 0.15, hat: 0.04 }[h.kind] * RATE;
    for (let i = 0; i < len && start + i < n; i++) {
      const t = i / RATE;
      mono[start + i]! += h.kind === "kick" ? Math.sin(2 * Math.PI * (50 + 80 * Math.exp(-t * 30)) * t) * Math.exp(-t * 12) * 0.8
        : h.kind === "snare" ? rand() * Math.exp(-t * 25) * 0.5
        : rand() * Math.exp(-t * 120) * 0.25;
    }
  }
  const out = new Int16Array(n * 2);
  for (let i = 0; i < n; i++) out[2 * i] = out[2 * i + 1] = Math.max(-32768, Math.min(32767, Math.round(mono[i]! * 32767)));
  return out;
}

/**
 * A track: `offset` s of silence, then bars of 4/4 from `bar1` (s) on, `pattern` per beat of the
 * bar (index 0 = beat 1); `pickup` beats of the pattern's end before bar 1.
 */
function track(bpm: number, seconds: number, bar1: number, pattern: Kind[][], pickup = 0): Int16Array {
  const beat = 60 / bpm, hits: { at: number; kind: Kind }[] = [];
  for (let b = -pickup; bar1 + b * beat < seconds; b++) {
    const t = bar1 + b * beat;
    for (const kind of pattern[((b % 4) + 4) % 4]!) hits.push({ at: t, kind });
    hits.push({ at: t + beat / 2, kind: "hat" });
  }
  return render(hits, seconds);
}

const BACKBEAT: Kind[][] = [["kick", "hat"], ["snare", "hat"], ["kick", "hat"], ["snare", "hat"]];
const ONE_ONLY: Kind[][] = [["kick", "hat"], ["snare", "hat"], ["hat"], ["snare", "hat"]];

describe("beat grid", () => {
  it("finds the tempo and the first bar line of a track that starts on beat 1", () => {
    const g = detectGrid(track(96, 200, 3.37, BACKBEAT), 2, 70)!;
    expect(g.x100).toBe(9600);
    expect(Math.abs(g.origin - 3.37 * RATE)).toBeLessThan(0.004 * RATE);
  });

  it("pins a fractional tempo to 0.01 BPM over a whole track", () => {
    const g = detectGrid(track(93.47, 240, 1.1, BACKBEAT), 2, 70)!;
    expect(Math.abs(g.x100 - 9347)).toBeLessThanOrEqual(1);
    expect(Math.abs(g.origin - 1.1 * RATE)).toBeLessThan(0.004 * RATE);
  });

  it("skips a pickup: bar 1 is where the kick of beat 1 lands", () => {
    const g = detectGrid(track(120, 120, 2, ONE_ONLY, 1), 2, 100)!;
    expect(g.x100).toBe(12000);
    expect(Math.abs(g.origin - 2 * RATE)).toBeLessThan(0.004 * RATE);
  });

  it("finds bar 1 when only beat 1 has a kick and the music starts mid-bar", () => {
    const g = detectGrid(track(100, 120, 4, ONE_ONLY, 2), 2, 100)!;
    // Hats on every beat and off-beat leave the beat's place a little less sharp here: ±5 ms.
    expect(Math.abs(g.origin - 4 * RATE)).toBeLessThan(0.005 * RATE);
  });

  it("four on the floor after a pickup: bar 1 is where the bass changes", () => {
    const bpm = 124, bar1 = 2.37, seconds = 150, beat = 60 / bpm, four: Kind[][] = [["kick"], ["kick", "snare"], ["kick"], ["kick", "snare"]];
    const pcm = track(bpm, seconds, bar1, four, 1);
    // A bass note per 4 bars, starting at bar 1.
    for (let i = Math.round(bar1 * RATE); i < seconds * RATE; i++) {
      const f = [55, 65.4, 49, 73.4][Math.floor((i / RATE - bar1) / (16 * beat)) % 4]!;
      const v = Math.round(Math.sin((2 * Math.PI * f * i) / RATE) * 0.12 * 32767);
      pcm[2 * i] = pcm[2 * i + 1] = Math.max(-32768, Math.min(32767, pcm[2 * i]! + v));
    }
    const g = detectGrid(pcm, 2, 100)!;
    expect(g.x100).toBe(12400);
    expect(Math.abs(g.origin - bar1 * RATE)).toBeLessThan(0.004 * RATE);
  });

  it("keeps the exact tempo of a short loop and cuts it into all its bars", () => {
    // 2 bars at 92 BPM: 5.217 s; the loop's length pins the tempo better than the fold can.
    const pcm = track(92, (8 * 60) / 92, 0, BACKBEAT), g = detectGrid(pcm, 2, 80)!;
    expect(g.x100).toBe(9200);
    expect(g.origin).toBe(0);
    expect(loopsOf(g, pcm.length / 2, 1).length).toBe(2);
  });

  it("finds all 4 bars of a 4-bar loop at 138 BPM", () => {
    const pcm = track(138, (16 * 60) / 138, 0, [["kick", "hat"], ["hat"], ["snare", "hat"], ["hat"]]), g = detectGrid(pcm, 2, 80)!;
    expect(g.x100).toBe(13800);
    expect(g.origin).toBe(0);
    expect(loopsOf(g, pcm.length / 2, 1).length).toBe(4);
  });

  it("starts bar 1 where the beat starts, not at a lone intro hit a beat into the bar before", () => {
    const bpm = 140, bar1 = 2.5, seconds = 90, beat = 60 / bpm, four: Kind[][] = [["kick"], ["kick", "snare"], ["kick"], ["kick", "snare"]];
    const pcm = track(bpm, seconds, bar1, four);
    // One loud hit on beat 2 of the bar before bar 1, ringing out; then a bass note per 4 bars.
    const hit = render([{ at: bar1 - 3 * beat, kind: "kick" }, { at: bar1 - 3 * beat, kind: "snare" }], seconds, 5);
    for (let i = 0; i < seconds * RATE; i++) {
      const t = i / RATE, f = t >= bar1 ? [55, 65.4, 49, 73.4][Math.floor((t - bar1) / (16 * beat)) % 4]! : 0;
      const v = hit[2 * i]! + (f ? Math.round(Math.sin(2 * Math.PI * f * t) * 0.12 * 32767) : 0);
      pcm[2 * i] = pcm[2 * i + 1] = Math.max(-32768, Math.min(32767, pcm[2 * i]! + v));
    }
    const g = detectGrid(pcm, 2, 100)!;
    expect(g.x100).toBe(14000);
    expect(Math.abs(g.origin - bar1 * RATE)).toBeLessThan(0.004 * RATE);
  });

  it("four on the floor that starts on bar 1: bar 1 at the start of the music, whatever the tempo", () => {
    // Bar lines must not come from where the counting of beats happens to start (it once landed
    // one or two beats late: the change from silence to music was counted on the wrong beat).
    const four: Kind[][] = [["kick"], ["kick", "snare"], ["kick"], ["kick", "snare"]];
    for (const [bpm, seconds] of [[126, 120], [131, 60], [118, 90]] as const) {
      const beat = 60 / bpm, bar1 = 1.5, pcm = track(bpm, seconds, bar1, four);
      for (let i = Math.round(bar1 * RATE); i < seconds * RATE; i++) {
        const f = [55, 65.4, 49, 73.4][Math.floor((i / RATE - bar1) / (16 * beat)) % 4]!;
        const v = Math.round(Math.sin((2 * Math.PI * f * i) / RATE) * 0.12 * 32767);
        pcm[2 * i] = pcm[2 * i + 1] = Math.max(-32768, Math.min(32767, pcm[2 * i]! + v));
      }
      const g = detectGrid(pcm, 2, 100)!;
      expect(g.x100).toBe(bpm * 100);
      expect(Math.abs(g.origin - bar1 * RATE)).toBeLessThan(0.004 * RATE);
    }
  });

  it("returns null for noise", () => {
    expect(detectGrid(render([], 30), 2, 70)).toBeNull();
  });
});

describe("loops", () => {
  const grid: BeatGrid = { x100: 9347, beatsPerBar: 4, origin: 100_000, clarity: 1 };

  it("cuts whole loops along the grid without adding up rounding", () => {
    const total = 240 * RATE, len = barFrames(grid) * 4;
    const loops = loopsOf(grid, total, 4);
    for (const l of loops) expect(Math.abs(l.frames - len)).toBeLessThanOrEqual(1);
    const last = loops.at(-1)!;
    expect(Math.abs(last.start - (grid.origin + ((last.bar - 1) / 4) * len))).toBeLessThanOrEqual(0.5);
    expect(last.start + last.frames).toBeLessThanOrEqual(total);
    expect(last.start + last.frames + len).toBeGreaterThan(total);
    for (let i = 1; i < loops.length; i++) expect(loops[i]!.start).toBe(loops[i - 1]!.start + loops[i - 1]!.frames);
  });

  it("keeps whole loops before bar 1 and moves cuts by the pre-roll", () => {
    const g = { ...grid, origin: Math.round(barFrames(grid) * 4 * 1.5) };
    const loops = loopsOf(g, 60 * RATE, 4);
    expect(loops[0]!.bar).toBe(-3);
    expect(loops[1]!.bar).toBe(1);
    expect(loops[1]!.start).toBe(g.origin);
    const early = loopsOf(g, 60 * RATE, 4, 240);
    expect(early[1]!.start).toBe(g.origin - 240);
  });

  it("makes loops of different lengths from cuts on bar lines", () => {
    const g: BeatGrid = { x100: 12000, beatsPerBar: 4, origin: 48_000, clarity: 1 }; // a bar is 96 000 frames
    expect(wholeBars(g, 48_000 + 10 * 96_000 + 5)).toEqual({ first: 1, last: 10 });
    expect(wholeBars(g, 48_000 + 10 * 96_000 - 1000)).toEqual({ first: 1, last: 9 });
    expect(wholeBars({ ...g, origin: 96_000 * 2 + 3 }, 96_000 * 5)).toEqual({ first: -1, last: 3 }); // bar 3 sticks out by 3 frames
    expect(evenCuts(g, 48_000 + 10 * 96_000, 4)).toEqual([1, 5, 9]);
    const loops = loopsFromCuts(g, [9, 1, 3, 7, 3]);
    expect(loops.map((l) => [l.bar, l.bars, l.start, l.frames])).toEqual([
      [1, 2, 48_000, 192_000], [3, 4, 240_000, 384_000], [7, 2, 624_000, 192_000],
    ]);
    expect(loopsFromCuts(g, [5])).toEqual([]);
  });

  it("is exact at a whole tempo: 4 bars at 90 BPM are 512 000 frames", () => {
    const loops = loopsOf({ x100: 9000, beatsPerBar: 4, origin: 7, clarity: 1 }, 60 * RATE, 4);
    expect(loops.every((l) => l.frames === 512_000)).toBe(true);
  });

  it("counts a bar that sticks out of the sample by a few frames, and fills it with silence", () => {
    const g: BeatGrid = { x100: 12000, beatsPerBar: 4, origin: 0, clarity: 1 }; // a bar is 96 000 frames
    expect(wholeBars(g, 4 * 96_000 - 20)).toEqual({ first: 1, last: 4 });
    expect(wholeBars(g, 4 * 96_000 - 2000)).toEqual({ first: 1, last: 3 });
    expect(wholeBars(g, 4 * 96_000, 100)).toEqual({ first: 1, last: 4 }); // pre-roll before the start
    const pcm = new Int16Array(20).fill(7); // 10 stereo frames
    expect([...extractLoop(pcm, 2, { start: -2, frames: 14 })]).toEqual([0, 0, 0, 0, ...Array(20).fill(7), 0, 0, 0, 0]);
  });

  it("mixes stems into one loop: a mono stem into both channels, the sum clipped", () => {
    const voice = { samples: new Int16Array([100, 200, 300, 400]), channels: 1 }; // 4 mono frames
    const inst = { samples: new Int16Array([10, -10, 20, -20, 32700, -32700, 40, -40]), channels: 2 }; // 4 stereo frames
    expect([...mixLoop([voice, inst], { start: 1, frames: 3 }, 2)]).toEqual([220, 180, 32767, -32400, 440, 360]);
  });

  it("mixes stems at their own volumes", () => {
    const a = { samples: new Int16Array([1000, 1000]), channels: 1, gain: 0.5 }, b = { samples: new Int16Array([200, 200]), channels: 1, gain: 2 };
    expect([...mixLoop([a, b], { start: 0, frames: 2 }, 1)]).toEqual([900, 900]);
  });

  it("extracts a loop with fades at both ends", () => {
    const pcm = new Int16Array(200).fill(1000); // 100 stereo frames
    const out = extractLoop(pcm, 2, { start: 10, frames: 50 }, 10);
    expect(out.length).toBe(100);
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(0);
    expect(out[50]).toBe(1000);
    expect(out[98]).toBe(0);
    expect(extractLoop(pcm, 2, { start: 10, frames: 50 })[0]).toBe(1000);
  });
});

describe("names", () => {
  it("makes a short ASCII track name without the tempo", () => {
    expect(trackName("My Track (Extended Mix) 124bpm.mp3")).toBe("My_Track_(Extended_Mix)");
    expect(trackName("Песня.wav")).toBe("track");
    expect(trackName("Café: del Mar?.flac")).toBe("Cafe_del_Mar");
  });

  it("names loop files that fit a pad name and carry their tempo", () => {
    const name = loopFileName("My Track (Extended Mix).mp3", 7, 30, 9347);
    expect(name).toBe("My_Track_07_93.47bpm.wav");
    expect(name.length - 4).toBeLessThanOrEqual(23);
    expect(bpmFromFileName(name)).toBe(9347);
    expect(loopFileName("a 128 bpm", 3, 120, 12800)).toBe("a_003_128bpm.wav");
    expect(bpmFromFileName(loopFileName("x", 12, 12, 9050))).toBe(9050);
  });

  it("finds a free folder name", () => {
    expect(uniqueName("Track", ["other"])).toBe("Track");
    expect(uniqueName("Track", ["track", "TRACK_2"])).toBe("Track_3");
  });
});
