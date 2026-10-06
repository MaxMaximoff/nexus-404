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
