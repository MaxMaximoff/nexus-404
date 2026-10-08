// Demo mode (`?demo`): made-up data put straight into the store, so the interface can be laid out
// without the SP. There is no device behind it: actions that talk to the SP do nothing.

import { BANKS, parsePadBlock, parsePattern, type DeviceStatus, type Pattern, type ProjectSettings } from "../sp404";

const RATE = 48000;

interface PadSpec {
  name: string;
  /** Length, s. */
  len: number;
  /** Sound shape for the waveform: a hit, a loop of hits, or a sustained tone. */
  shape: "hit" | "loop" | "tone";
  stereo?: boolean;
  bpm?: number;
  loop?: boolean;
  gate?: boolean;
  sync?: boolean;
  level?: number;
  muteGroup?: number;
  padLink?: number;
  vinyl?: boolean;
  pitch?: number;
  oneShot?: boolean;
  playMode?: number;
  vari?: number;
  stretch?: number;
  attack?: number;
  release?: number;
}

const PADS: Record<string, PadSpec> = {
  A1: { name: "Kick Dusty", len: 0.5, shape: "hit" },
  A2: { name: "Kick Sub 808", len: 1.4, shape: "hit", muteGroup: 1 },
  A3: { name: "Snare Crack", len: 0.3, shape: "hit" },
  A4: { name: "Rim Wood", len: 0.12, shape: "hit", level: 104 },
  A5: { name: "Clap Stack", len: 0.35, shape: "hit", stereo: true },
  A6: { name: "Hat Closed", len: 0.09, shape: "hit", muteGroup: 2, level: 96 },
  A7: { name: "Hat Open", len: 0.5, shape: "hit", muteGroup: 2, level: 96 },
  A8: { name: "Shaker", len: 0.18, shape: "hit", level: 88 },
  A9: { name: "Tom Low", len: 0.5, shape: "hit" },
  A10: { name: "Tom High", len: 0.4, shape: "hit", pitch: 2 },
  A12: { name: "Crash Wash", len: 2.2, shape: "hit", stereo: true, gate: false },
  A13: { name: "Crash Reverse", len: 2.2, shape: "hit", stereo: true, playMode: 1, gate: false },
  B1: { name: "Drum Loop 92", len: 5.217, shape: "loop", stereo: true, bpm: 92, loop: true, sync: true },
  B2: { name: "Drum Loop 1bar", len: 2.609, shape: "loop", stereo: true, bpm: 92, loop: true, sync: true, vari: 1 },
  B3: { name: "Bass Line Am", len: 5.217, shape: "loop", bpm: 92, loop: true, sync: true },
  B4: { name: "Keys Loop Am", len: 10.435, shape: "tone", stereo: true, bpm: 92, loop: true, sync: true, vari: 2 },
  B5: { name: "Pad Chords Lofi", len: 10.435, shape: "tone", stereo: true, bpm: 92, loop: true, sync: true, vinyl: true },
  B7: { name: "Break 174", len: 2.759, shape: "loop", stereo: true, bpm: 174, loop: true, sync: true, stretch: 5287 },
  C1: { name: "Stab Am7", len: 0.7, shape: "tone", stereo: true, muteGroup: 3, padLink: 1 },
  C2: { name: "Stab Dm9", len: 0.7, shape: "tone", stereo: true, muteGroup: 3 },
  C3: { name: "Stab Gmaj7", len: 0.7, shape: "tone", stereo: true, muteGroup: 3, oneShot: true },
  C4: { name: "Stab Cmaj9", len: 0.7, shape: "tone", stereo: true, muteGroup: 3 },
  C9: { name: "Stab Sub Layer", len: 0.6, shape: "tone", padLink: 1 },
  D1: { name: "Vox Ah A3", len: 1.2, shape: "tone" },
  D2: { name: "Vox Phrase", len: 2.6, shape: "tone", stereo: true, bpm: 90, sync: true, pitch: -2 },
  F1: { name: "Field Rain", len: 6, shape: "tone", stereo: true, loop: true, gate: false, level: 80 },
  J1: { name: "Ambience Long", len: 14, shape: "tone", stereo: true, loop: true, attack: 60, release: 90 },
};

const padIndex = (name: string) => BANKS.indexOf(name[0]) * 16 + +name.slice(1) - 1;

/** Deterministic noise, so the demo looks the same on every load. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2147483648 - 1;
  };
}

/** PCM that looks like the named shape on the waveform (interleaved, 48 kHz / 16 bit). */
function samples(s: PadSpec, seed: number): Int16Array {
  const ch = s.stereo ? 2 : 1, n = Math.round(s.len * RATE), out = new Int16Array(n * ch), r = rng(seed);
  const beat = (60 / (s.bpm ?? 92)) * RATE / 2; // 1/8 notes
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    let env: number;
    if (s.shape === "hit") env = Math.exp(-t * (6 / s.len));
    else if (s.shape === "loop") { const k = i % beat; env = Math.exp(-k / RATE * 14) * (Math.floor(i / beat) % 2 ? 0.55 : 1); }
    else env = Math.min(1, t / 0.05) * Math.min(1, (s.len - t) / 0.3) * (0.7 + 0.3 * Math.sin(t * 2.1 + seed));
    for (let c = 0; c < ch; c++) out[i * ch + c] = Math.round(27000 * env * (0.6 * r() + 0.4 * Math.sin(2 * Math.PI * 110 * t + c)));
  }
  return out;
}

/** A pad block as the SP sends it (327 bytes, layout from the dumps in captures/), parsed. */
function block(pad: number, s?: PadSpec) {
  const raw = new Uint8Array(327), dv = new DataView(raw.buffer);
  raw.set([0x1e, pad & 0xff, pad >> 8]);
  if (s) {
    const f = (n: number, v: number) => dv.setInt32(3 + n * 4, v, true);
    const size = 512 + Math.round(s.len * RATE) * (s.stereo ? 4 : 2), bpm = Math.round((s.bpm ?? Math.min(200, Math.max(40, 240 / s.len))) * 100);
    f(0, size); f(1, 512); f(2, size); f(3, s.level ?? 127); f(4, s.gate === false ? 0 : 1); f(5, s.loop ? 0x7fffffff : 0); f(6, 1);
    f(7, s.muteGroup ?? 0); f(8, s.sync ? 1 : 0); f(9, bpm); f(10, ((s.vari ?? 0) << 1) | (s.oneShot ? 32 : 0)); f(11, 512);
    f(13, s.pitch ?? 0); f(15, s.playMode ?? 0); f(16, s.stretch ?? 10000); f(17, s.vinyl ? 1 : 0); f(18, 64); f(19, s.padLink ?? 0);
    f(20, 1); f(21, 2); f(22, s.attack ?? 0); f(23, 100); f(24, s.release ?? 0); f(27, bpm);
    raw.set(new TextEncoder().encode(s.name), 175);
  }
  return parsePadBlock(raw);
}

/** A pattern from 1/16 steps (SparkyMK2 04-patterns.md): `hits` = [step, pad, velocity]. */
function pattern(bars: number, hits: [number, string, number][]): Pattern {
  const recs: number[][] = [], sorted = [...hits].sort((a, b) => a[0] - b[0]);
  sorted.forEach(([step, pad, vel], i) => {
    let gap = (i + 1 < sorted.length ? sorted[i + 1][0] : bars * 16) * 120 - step * 120;
    const p = padIndex(pad);
    recs.push([Math.min(gap, 255), 0x2f + (p % 80), Math.floor(p / 80), 0, vel, 0x40, 110, 0]);
    for (gap -= Math.min(gap, 255); gap > 0; gap -= Math.min(gap, 255)) recs.push([Math.min(gap, 255), 0x80, 0, 0, 0, 0, 0, 0]);
  });
  recs.push([0, 0x8c, 0, 0, 0, 0, 0, 0], [bars, 0, 0, 0, 0, 0x80, bars, 1]);
  return parsePattern(Uint8Array.from(recs.flat()));
}
const on = (pad: string, steps: number[], vel = 100): [number, string, number][] => steps.map((s) => [s, pad, vel]);
const range = (from: number, by: number, until: number) => Array.from({ length: Math.ceil((until - from) / by) }, (_, i) => from + i * by);

export interface DemoData {
  status: DeviceStatus;
  project: ProjectSettings & { names: string[] };
  pads: ReturnType<typeof parsePadBlock>[];
  patterns: Map<number, Pattern>;
  waves: Map<number, { samples: Int16Array; channels: number }>;
  freeKb: number;
}

export function demoData(): DemoData {
  const pads = Array.from({ length: 160 }, (_, i) => block(i));
  const waves = new Map<number, { samples: Int16Array; channels: number }>();
  for (const [name, s] of Object.entries(PADS)) {
    const i = padIndex(name);
    pads[i] = block(i, s);
    waves.set(i, { samples: samples(s, i + 1), channels: s.stereo ? 2 : 1 });
  }
  const tempos = [9200, 9200, 9000, 9000, 9200, 8800, 9200, 9200, 9200, 7000];
  return {
    status: { project: 0, bank: 0, pad: 0, workingMode: 0, playing: false },
    project: {
      project: 0, projectTempoX100: 9200, useProjectTempo: true, name: "NEXUS DEMO",
      banks: tempos.map((t, b) => ({ letter: BANKS[b], protected: false, tempoX100: t, volume: 127 })),
      names: ["NEXUS DEMO", "Beat Tape", "", "PROJECT_04", "", "", "", "", "HandPan", "", "", "", "", "", "", ""],
    },
    pads,
    patterns: new Map([
      [padIndex("A1"), pattern(2, [...on("A1", [0, 7, 10, 16, 23, 26, 30], 120), ...on("A3", [4, 12, 20, 28], 110), ...on("A6", range(0, 2, 32), 80), ...on("A7", [14, 30], 90)])],
      [padIndex("A2"), pattern(1, [...on("A1", [0, 3, 10], 120), ...on("A5", [4, 12], 105), ...on("A6", range(0, 1, 16), 64)])],
      [padIndex("F1"), pattern(4, [...on("B1", [0, 32]), ...on("B3", [0, 32]), [0, "B5", 70], [16, "C1", 100], [48, "C3", 90]])],
    ]),
    waves,
    freeKb: 12_900_000,
  };
}
