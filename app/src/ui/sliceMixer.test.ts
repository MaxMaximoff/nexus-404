import { batch } from "@preact/signals";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { stemLanes } from "./sliceLanes";

let api: typeof import("./slice");
const kept = new Map<string, string>();
let played: Float32Array[] = [];
const frames = 192000;

beforeAll(async () => {
  vi.stubGlobal("location", { search: "", hash: "", pathname: "/nexus-404/" });
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => kept.get(key) ?? null,
    setItem: (key: string, value: string) => kept.set(key, value),
  });
  vi.stubGlobal("AudioContext", class {
    currentTime = 0;
    destination = {};
    resume() { return Promise.resolve(); }
    createBuffer(channels: number, length: number) {
      played = Array.from({ length: channels }, () => new Float32Array(length));
      return { getChannelData: (channel: number) => played[channel] };
    }
    createBufferSource() { return { connect() {}, start() {}, stop() {} }; }
  });
  api = await import("./slice");
});

beforeEach(() => {
  api.stopPlay();
  const stem = (label: string, family: import("./slice").Stem["family"], sample: number) => ({
    name: `${label}.wav`, label, tag: label, family, channels: 1 as const, frames,
    samples: new Int16Array(frames).fill(sample), peaks: [],
  });
  batch(() => {
    api.slState.value = "idle";
    api.slBusy.value = null;
    api.slMuted.value = new Set(); api.slSolo.value = new Set();
    api.slGroupMuted.value = new Set(); api.slGroupSolo.value = new Set();
    api.slGain.value = new Map(); api.slLoopGain.value = new Map();
    api.slClean.value = "off";
    api.slTrack.value = { id: 27, name: "Song.wav", frames, stems: [
      stem("vocals", "vocal", 1000), stem("drums", "drums", 2000),
      stem("snare", "drums", 3000), stem("bass", "bass", 4000), stem("fx", "others", 5000),
    ] };
    api.slStemGroup.value = [0, 1, 1, 2, -1];
    api.slGrid.value = { x100: 12000, beatsPerBar: 4, origin: 0, clarity: 1 };
    api.slCuts.value = new Set([1, 2, 3]); api.slOff.value = new Set();
    api.slFadeMs.value = 0; api.slMetronome.value = false;
    api.slState.value = "ready";
  });
});

afterAll(() => {
  api.stopPlay(); api.slTrack.value = null; api.slGrid.value = null;
  vi.unstubAllGlobals();
});

const labels = () => api.writtenStems(api.slTrack.value!).map((s) => s.label);

it("mutes a group without losing each child's mute, for both playback and export", () => {
  api.toggleMute(2);
  api.toggleGroupMute(1);
  expect(labels()).toEqual(["vocals", "bass", "fx"]);
  expect(api.groupOutputs(api.slTrack.value!).map((g) => g.col)).toEqual([0, 2]);
  api.play(1);
  expect(played[0]![0]).toBeCloseTo(10000 / 32768);
  api.toggleGroupMute(1);
  expect(labels()).toEqual(["vocals", "drums", "bass", "fx"]);
  // Changing the mixer while playing updates the actual playback buffer too.
  expect(played[0]![0]).toBeCloseTo(12000 / 32768);
  expect([...api.slMuted.value]).toEqual([2]);
});

it("combines group and stem solos, keeps mute dominant, and restores the full mix on release", () => {
  api.toggleGroupSolo(1);
  expect(labels()).toEqual(["drums", "snare"]);
  api.toggleSolo(3);
  expect(labels()).toEqual(["drums", "snare", "bass"]);
  api.toggleMute(2);
  api.toggleGroupMute(1);
  expect(labels()).toEqual(["bass"]);
  api.toggleGroupSolo(1); api.toggleSolo(3); api.toggleGroupMute(1);
  expect(labels()).toEqual(["vocals", "drums", "bass", "fx"]);
});

it("applies a group's controls immediately when a stem is reassigned, including No group", () => {
  api.toggleGroupSolo(1);
  api.setStemGroup(0, 1);
  expect(labels()).toEqual(["vocals", "drums", "snare"]);
  api.setStemGroup(1, -1);
  expect(labels()).toEqual(["vocals", "snare"]);
  api.toggleGroupSolo(1); api.toggleSolo(1);
  expect(labels()).toEqual(["drums"]);
  expect(api.groupOutputs(api.slTrack.value!)).toEqual([]);
  api.toggleMute(1);
  expect(api.slStemBlock.value).toContain("No stem is audible");
  api.setStemGroup(0, 8);
  expect(api.slStemGroup.value[0]).toBe(1);
});

it("preserves the new mixer controls in the saved session and freezes them while writing", () => {
  api.toggleSolo(2); api.toggleGroupMute(0); api.toggleGroupSolo(1);
  const saved = JSON.parse(kept.get("nexus404.slicer")!)[0];
  expect(saved.solo).toHaveLength(1);
  expect(saved.solo[0]).toBe(saved.stems[2]);
  expect(saved.groupMuted).toEqual([0]); expect(saved.groupSolo).toEqual([1]);
  api.slBusy.value = { text: "Writing", progress: 0 };
  api.toggleSolo(2); api.toggleMute(2); api.toggleGroupMute(0); api.toggleGroupSolo(1); api.setStemGroup(2, -1);
  expect([...api.slSolo.value]).toEqual([2]); expect(api.slMuted.value.size).toBe(0);
  expect([...api.slGroupMuted.value]).toEqual([0]); expect([...api.slGroupSolo.value]).toEqual([1]);
  expect(api.slStemGroup.value[2]).toBe(1);
});

it("keeps group headers, waveforms and child tracks aligned when folding nonadjacent stems", () => {
  const rows = stemLanes([1, 0, 1, -1], 4, new Set([1]));
  expect(rows.filter((r) => r.kind === "stem").map((r) => r.stem)).toEqual([1, 3]);
  expect(rows.filter((r) => r.kind === "group").map((r) => r.stems)).toEqual([[1], [0, 2], [], []]);
  expect(rows.map((r) => r.top)).toEqual([18, 58, 122, 162, 202, 242]);
  const unfolded = stemLanes([1, 0, 1, -1], 4, new Set());
  expect(unfolded.filter((r) => r.kind === "stem").map((r) => r.stem)).toEqual([1, 0, 2, 3]);
});
