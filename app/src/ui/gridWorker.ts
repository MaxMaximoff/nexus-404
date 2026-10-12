// Track analysis off the page's thread: the beat grid, the key (Essentia, loaded on the first key
// asked for) and the clean-up of stems (a 4-minute track takes about a second each).

import { cleanStems, type CleanInput, type CleanLevel } from "../sp404/clean";
import { detectGrid } from "../sp404/grid";

export type GridRequest =
  | { id: number; kind: "grid"; samples: Int16Array; channels: number; minBpm: number }
  | { id: number; kind: "key"; samples: Int16Array; channels: number; sampleRate: number }
  | { id: number; kind: "clean"; stems: CleanInput[]; level: CleanLevel };

/** The answer to request `id`: its result, or why it failed. */
export type GridReply = { id: number; result: unknown } | { id: number; error: string };

const reply = (r: GridReply) => (self as unknown as Worker).postMessage(r);

self.onmessage = (e: MessageEvent<GridRequest>) => {
  const r = e.data;
  if (r.kind === "key") {
    // Essentia's WASM can fail to load or to run: that is an error for this request, not "no key".
    void import("../sp404/essentiaKey")
      .then((api) => api.analyzeEssentiaKey(r.samples, r.channels, r.sampleRate))
      .then((result) => reply({ id: r.id, result }))
      .catch((error: unknown) => reply({ id: r.id, error: error instanceof Error ? error.message : String(error) }));
    return;
  }
  reply({ id: r.id, result: r.kind === "grid" ? detectGrid(r.samples, r.channels, r.minBpm) : cleanStems(r.stems, r.level) });
};
