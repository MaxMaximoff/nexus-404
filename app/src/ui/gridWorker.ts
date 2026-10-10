// Track analysis off the page's thread: the beat grid and the key (a 4-minute track takes over a
// second each).

import { detectGrid } from "../sp404/grid";
import { detectKey } from "../sp404/key";

export type GridRequest =
  | { id: number; kind: "grid"; samples: Int16Array; channels: number; minBpm: number }
  | { id: number; kind: "key"; samples: Int16Array; channels: number };

self.onmessage = (e: MessageEvent<GridRequest>) => {
  const r = e.data;
  const result = r.kind === "grid" ? detectGrid(r.samples, r.channels, r.minBpm) : detectKey(r.samples, r.channels);
  (self as unknown as Worker).postMessage({ id: r.id, result });
};
