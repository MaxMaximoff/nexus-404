import { expect, it, vi } from "vitest";
import { analyzeEssentiaKey, type EssentiaKeyAnalysis } from "../sp404/essentiaKey";

vi.mock("../sp404/essentiaKey", () => ({ analyzeEssentiaKey: vi.fn() }));

it("answers a key request with Essentia's result or its error, under the request's id", async () => {
  const postMessage = vi.fn(), worker = { postMessage, onmessage: null as ((e: MessageEvent) => void) | null };
  vi.stubGlobal("self", worker);
  try {
    await import("./gridWorker");
    const samples = new Int16Array([1, 2]);
    const result: EssentiaKeyAnalysis = { key: { tonic: 5, minor: true, strength: 0.8, source: "essentia-edma" }, backend: "test", coldStart: false, initMs: 0, analysisMs: 1 };
    vi.mocked(analyzeEssentiaKey).mockResolvedValueOnce(result);
    worker.onmessage!({ data: { id: 1, kind: "key", samples, channels: 2, sampleRate: 48000 } } as MessageEvent);
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith({ id: 1, result }));
    expect(analyzeEssentiaKey).toHaveBeenCalledWith(samples, 2, 48000);

    vi.mocked(analyzeEssentiaKey).mockRejectedValueOnce(new Error("WASM unavailable"));
    worker.onmessage!({ data: { id: 2, kind: "key", samples, channels: 2, sampleRate: 48000 } } as MessageEvent);
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith({ id: 2, error: "WASM unavailable" }));
  } finally {
    vi.unstubAllGlobals();
  }
});
