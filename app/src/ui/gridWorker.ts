// The beat grid of a whole track, off the page's thread: a 4-minute track takes over a second.

import { detectGrid } from "../sp404/grid";

export interface GridRequest { id: number; samples: Int16Array; channels: number; minBpm: number }

self.onmessage = (e: MessageEvent<GridRequest>) => {
  const { id, samples, channels, minBpm } = e.data;
  (self as unknown as Worker).postMessage({ id, grid: detectGrid(samples, channels, minBpm) });
};
