// How fast the SP actually plays a pad (checked on the unit, report §0): with BPM Sync the speed is
// the playing tempo over the pad's BPM, kept within 50–150 % by doubling or halving the pad's
// BPM; without it the speed is Time Stretch. With Vinyl the pitch follows the speed.

import type { PadBlock } from "./control";

export const SYNC_MIN_RATIO = 0.5;
export const SYNC_MAX_RATIO = 1.5;

export interface PadSpeed {
  /** Playback speed, 1 = as recorded. */
  ratio: number;
  source: "sync" | "stretch";
  /** BPM Sync only: the pad's BPM was taken × 2^fold to stay within 50–150 % (1 = doubled, −1 = halved). */
  fold: number;
  /** The pad's BPM × 100 the SP synced from, after folding. */
  syncedBpmX100: number;
  /** Pitch change in semitones: from the speed with Vinyl, from Pitch Coarse/Fine without. */
  pitchSt: number;
}

type SpeedInputs = Pick<PadBlock, "bpmSync" | "bpmX100" | "timeStretchX100" | "vinyl" | "pitchCoarse" | "pitchFine">;

/** `tempoX100`: the tempo playing now (project or bank, by Tempo Select). */
export function padSpeed(p: SpeedInputs, tempoX100: number): PadSpeed {
  let ratio = p.timeStretchX100 / 10000, fold = 0;
  const sync = p.bpmSync && p.bpmX100 > 0;
  if (sync) {
    ratio = tempoX100 / p.bpmX100;
    while (ratio > SYNC_MAX_RATIO) { ratio /= 2; fold++; }
    while (ratio < SYNC_MIN_RATIO) { ratio *= 2; fold--; }
  }
  return {
    ratio,
    source: sync ? "sync" : "stretch",
    fold,
    syncedBpmX100: Math.round(p.bpmX100 * 2 ** fold),
    pitchSt: p.vinyl ? 12 * Math.log2(ratio) : p.pitchCoarse + p.pitchFine / 100,
  };
}

/**
 * "Set BPM by St/End" as the official app computes it (SparkyMK2 spec, "Computed on the host"):
 * the BPM that makes Start–End a whole number of beats, nearest to the pad's BPM (9600 when 0).
 * Normally 4, 8, 12, … beats; when 4 beats is already at or above it, powers of two from 1/64 to
 * 4 beats, rejecting an upper choice above 300 BPM. A tie goes to fewer beats. BPM × 100, truncated.
 */
export function bpmFromLength(frames: number, currentX100: number): { x100: number; beats: number } | null {
  if (!(frames > 0)) return null;
  const target = currentX100 || 9600;
  const at = (beats: number) => ({ beats, x100: Math.floor((beats * 288_000_000) / frames) }); // 48 kHz × 60 s × 100
  const cands = [at(4)];
  let short = false;
  if (cands[0].x100 >= target) {
    short = true;
    cands.length = 0;
    for (let b = 1 / 64; b <= 4; b *= 2) cands.push(at(b));
  } else {
    while (cands[cands.length - 1].x100 < target) cands.push(at(cands[cands.length - 1].beats + 4));
  }
  const i = cands.findIndex((c) => c.x100 >= target);
  if (i < 0) return cands[cands.length - 1];
  if (i === 0) return short && cands[0].x100 > 30000 ? null : cands[0];
  const lo = cands[i - 1], hi = cands[i];
  if (short && hi.x100 > 30000) return lo;
  return hi.x100 - target < target - lo.x100 ? hi : lo;
}
