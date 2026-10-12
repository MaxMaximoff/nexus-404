// The track's key by Essentia.js (AGPL-3.0, see THIRD_PARTY.md): its KeyExtractor with the EDMA
// profile and a 36-bin HPCP, as in Stem Deck. Tonic and major/minor only, no mode. Loaded lazily,
// inside the analysis worker only: the page never downloads it until a key is asked for.

/** Essentia's answer. `strength` is how well the chroma matches the key's profile, not a probability of being right. */
export interface EssentiaKey { tonic: number; minor: boolean; strength: number; source: "essentia-edma" }
/** `key` null: Essentia found no clear key (silence, no tones); a failure throws instead. */
export interface EssentiaKeyAnalysis { key: EssentiaKey | null; backend: string; initMs: number; analysisMs: number; coldStart: boolean }

interface Vector { delete(): void }
interface Engine {
  version: string;
  arrayToVector(a: Float32Array): Vector;
  KeyExtractor(audio: Vector, averageDetuningCorrection: boolean, frameSize: number, hopSize: number, hpcpSize: number, maxFrequency: number,
    maximumSpectralPeaks: number, minFrequency: number, pcpThreshold: number, profileType: string, sampleRate: number,
    spectralPeaksThreshold: number, tuningFrequency: number, weightType: string, windowType: string): { key: string; scale: string; strength: number };
}

let loading: Promise<{ engine: Engine; initMs: number }> | undefined;
function engine() {
  loading ??= (async () => {
    const at = performance.now();
    const [core, wasm] = await Promise.all([
      import("essentia.js/dist/essentia.js-core.es.js"),
      import("essentia.js/dist/essentia-wasm.es.js"),
    ]);
    return { engine: new core.default(wasm.EssentiaWASM) as unknown as Engine, initMs: performance.now() - at };
  })().catch((e) => { loading = undefined; throw e; }); // a failed load is tried again next time
  return loading;
}

/** Interleaved 16-bit PCM → mono float −1..1, the channels averaged. */
export function monoForEssentia(samples: Int16Array, channels: number): Float32Array {
  if (!Number.isSafeInteger(channels) || channels < 1 || samples.length % channels) throw new Error("Invalid interleaved PCM");
  const out = new Float32Array(samples.length / channels), scale = 1 / (32768 * channels);
  for (let i = 0, j = 0; i < out.length; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += samples[j++]!;
    out[i] = sum * scale;
  }
  return out;
}

/** Essentia's key and scale as ours; null when it found none (it says so with strength ≤ 0). */
export function essentiaLabel(result: { key: string; scale: string; strength: number }): EssentiaKey | null {
  if (!Number.isFinite(result.strength)) throw new Error("Invalid Essentia strength");
  const match = /^([A-G])([#b]?)$/.exec(result.key);
  if (!match || !["major", "minor"].includes(result.scale) || result.strength <= 0) return null;
  const note: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  return {
    tonic: (note[match[1]!]! + (match[2] === "#" ? 1 : match[2] === "b" ? -1 : 0) + 12) % 12,
    minor: result.scale === "minor", strength: result.strength, source: "essentia-edma",
  };
}

/** The key of interleaved 16-bit PCM at `sampleRate`. */
export async function analyzeEssentiaKey(samples: Int16Array, channels: number, sampleRate: number): Promise<EssentiaKeyAnalysis> {
  if (!samples.length) throw new Error("Empty audio");
  if (!(Number.isFinite(sampleRate) && sampleRate >= 8000 && sampleRate <= 192000)) throw new Error(`Invalid sample rate ${sampleRate}`);
  const mono = monoForEssentia(samples, channels);
  const coldStart = !loading, ready = await engine(), at = performance.now();
  const vector = ready.engine.arrayToVector(mono);
  try {
    // Stem Deck's fixed configuration: EDMA profile, 36-bin HPCP, 4096-sample frames and hops.
    const result = ready.engine.KeyExtractor(vector, true, 4096, 4096, 36, 3500, 60, 25, 0.2, "edma", sampleRate, 0.0001, 440, "cosine", "hann");
    return { key: essentiaLabel(result), backend: ready.engine.version, initMs: ready.initMs, analysisMs: performance.now() - at, coldStart };
  } finally {
    vector.delete();
  }
}
