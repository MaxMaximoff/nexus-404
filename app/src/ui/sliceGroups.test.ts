import { expect, it, vi } from "vitest";

it("imports groups to pads without invoking the card filesystem", async () => {
  vi.stubGlobal("location", { search: "", hash: "", pathname: "/nexus-404/" });
  const api = await import("./slice");
  const store = await import("./store");
  const card = await import("./card");
  const importToPads = vi.spyOn(store, "importToPads").mockResolvedValue(1);
  const withDevice = vi.spyOn(store, "withDevice").mockRejectedValue(new Error("Card filesystem must not be used"));
  const frames = 192000;
  const stem = (name: string, family: "drums" | "bass", sample: number) => ({ name: `${name}.wav`, label: name, tag: name, family, channels: 1 as const, frames, samples: new Int16Array(frames).fill(sample), peaks: [] });
  try {
    api.slTrack.value = { id: 25, name: "Song.wav", frames, stems: [stem("kick", "drums", 1000), stem("snare", "drums", 2000), stem("bass", "bass", 3000)] };
    api.slStemGroup.value = [1, 1, 2];
    api.slGrid.value = { x100: 12000, beatsPerBar: 4, origin: 0, clarity: 1 };
    api.slCuts.value = new Set([1, 2, 3]); api.slFadeMs.value = 0;
    store.conn.value = "ready";
    // An unrelated card operation does not block importing groups to pads.
    card.cardBusy.value = { text: "Reading card", progress: 0 };
    expect(api.slGroupBlock.value).toBeNull();
    await api.writeGroups();
    expect(importToPads.mock.calls.map(([files]) => files[0]!.pad)).toEqual([1, 2, 5, 6]);
    const first = importToPads.mock.calls[0]![0][0]!;
    expect(first.file.name).toBe("drums_A2.wav");
    expect(first.bpmX100).toBe(12000);
    const pcm = new DataView(await first.file.arrayBuffer());
    expect(pcm.getInt16(44, true)).toBe(3000);
    expect(withDevice).not.toHaveBeenCalled();
    expect(api.slWritten.value.size).toBe(0);
    expect(card.cardBusy.value?.text).toBe("Reading card");
    expect(api.slBusy.value).toBeNull();
  } finally {
    api.slTrack.value = null; api.slGrid.value = null;
    card.cardBusy.value = null; store.conn.value = "idle";
    vi.restoreAllMocks(); vi.unstubAllGlobals();
  }
});
