// Track analysis off the page's thread: the beat grid, the key and the clean-up of stems (a
// 4-minute track takes about a second each).

import { cleanStems, type CleanInput, type CleanLevel } from "../sp404/clean";
import { detectGrid } from "../sp404/grid";
import { detectKey } from "../sp404/key";

export type GridRequest =
  | { id: number; kind: "grid"; samples: Int16Array; channels: number; minBpm: number }
  | { id: number; kind: "key"; samples: Int16Array; channels: number }
  | { id: number; kind: "clean"; stems: CleanInput[]; level: CleanLevel };

self.onmessage = (e: MessageEvent<GridRequest>) => {
  const r = e.data;
  const result = r.kind === "grid" ? detectGrid(r.samples, r.channels, r.minBpm)
    : r.kind === "key" ? detectKey(r.samples, r.channels)
    : cleanStems(r.stems, r.level);
  (self as unknown as Worker).postMessage({ id: r.id, result });
};
