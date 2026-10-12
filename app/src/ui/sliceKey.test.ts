import { expect, it, vi } from "vitest";
import type { EssentiaKeyAnalysis } from "../sp404/essentiaKey";
import type { GridRequest } from "./gridWorker";

it("takes the key from the pitched stem, drops stale answers, and tells an error from no key", async () => {
  class MockWorker {
    static instance: MockWorker;
    requests: GridRequest[] = [];
    onmessage: ((e: MessageEvent) => void) | null = null;
    onerror: ((e: ErrorEvent) => void) | null = null;
    constructor() { MockWorker.instance = this; }
    postMessage(r: GridRequest) { this.requests.push(r); }
    terminate() {}
    last() { return this.requests.at(-1)!; }
    answer(id: number, result: EssentiaKeyAnalysis) { this.onmessage?.({ data: { id, result } } as MessageEvent); }
    fail(id: number, error: string) { this.onmessage?.({ data: { id, error } } as MessageEvent); }
  }
  vi.stubGlobal("Worker", MockWorker);
  const kept = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => kept.set(k, v), removeItem: (k: string) => kept.delete(k) });
  vi.stubGlobal("location", { search: "", hash: "", pathname: "/nexus-404/" }); // the store reads ?demo when loaded
  const api = await import("./slice");
  const stem = (name: string, label: string, fill: number) => ({ name, label, tag: label, channels: 2 as const, frames: 48000 * 5, samples: new Int16Array(48000 * 10).fill(fill), peaks: [] });
  const track = { id: 901, name: "Song.wav", frames: 48000 * 5, stems: [stem("Song (Vocals).wav", "vocals", 1), stem("Song (Instrumental).wav", "inst", 2)] };
  const key = (tonic: number, minor = true): EssentiaKeyAnalysis => ({ key: { tonic, minor, strength: 0.8, source: "essentia-edma" }, backend: "test", coldStart: false, initMs: 0, analysisMs: 1 });
  const settle = async () => { for (let i = 0; i < 3; i++) await Promise.resolve(); };
  try {
    api.slTrack.value = track;
    const first = api.findKey(), w = MockWorker.instance;
    const r1 = w.last();
    // The instrumental, not the voice; at the audio's sample rate.
    expect(r1).toMatchObject({ kind: "key", channels: 2, sampleRate: 48000 });
    expect("samples" in r1 && r1.samples).toBe(track.stems[1]!.samples);
    expect(api.slKeyStem.value).toBe(1);
    expect(api.slKey.value).toBeUndefined();

    // A newer request wins; the older answer, arriving later, is dropped.
    const second = api.findKey(), r2 = w.last();
    w.answer(r2.id, key(5)); await second;
    w.answer(r1.id, key(0)); await first;
    expect(api.slKey.value).toMatchObject({ tonic: 5, minor: true });
    expect(api.slKey.value).not.toHaveProperty("mode");

    // A failure is an error, not "no key"; retrying clears it.
    const failing = api.findKey(); w.fail(w.last().id, "WASM unavailable"); await failing;
    expect(api.slKey.value).toBeNull();
    expect(api.slKeyError.value).toBe("WASM unavailable");
    const retry = api.findKey();
    expect(api.slKeyError.value).toBeNull();
    w.answer(w.last().id, key(7, false)); await retry;
    expect(api.slKey.value).toMatchObject({ tonic: 7, minor: false });

    // No clear key: null without an error.
    const none = api.findKey(); w.answer(w.last().id, { ...key(0), key: null }); await none;
    expect(api.slKey.value).toBeNull();
    expect(api.slKeyError.value).toBeNull();

    // The track changes while its key is being found: the old answer and the old failure are dropped.
    const old = api.findKey(), oldId = w.last().id;
    api.slTrack.value = { ...track, id: 902 };
    api.slKey.value = undefined;
    w.answer(oldId, key(9)); await old;
    expect(api.slKey.value).toBeUndefined();
    const oldFail = api.findKey(), failId = w.last().id;
    api.slTrack.value = { ...track, id: 903 };
    api.slKey.value = undefined;
    w.fail(failId, "late failure"); await oldFail; await settle();
    expect(api.slKeyError.value).toBeNull();

    // Drums only: nothing is analysed, no key, no error.
    const before = w.requests.length;
    api.slTrack.value = { ...track, id: 904, stems: [stem("Song_drums.wav", "drums", 3), stem("Song_drums2.wav", "drums_2", 4)] };
    await api.findKey();
    expect(w.requests.length).toBe(before);
    expect(api.slKeyStem.value).toBe(-1);
    expect(api.slKey.value).toBeNull();
    expect(api.slKeyError.value).toBeNull();
  } finally {
    api.slTrack.value = null;
    vi.unstubAllGlobals();
  }
});
