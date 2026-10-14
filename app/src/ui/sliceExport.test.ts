import { batch } from "@preact/signals";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { CARD, loopPattern, parsePattern, writePattern, type PadBlock, type ProjectSettings } from "../sp404";
import type { SP404Device } from "../sp404/device";
import { stemTrackName } from "../sp404/stems";

let api: typeof import("./slice");
let store: typeof import("./store");
let card: typeof import("./card");
let menu: typeof import("./sliceExport");
let draftApi: typeof import("./patternDraft");
let configureOriginal: typeof import("./store").configureLoopPad;
let patternsOriginal: typeof import("./store").createLoopPatterns;
let sequence = 100;
const fs = new Map<string, Uint8Array | null>();
const normalize = (path: string) => path.replace(/\/+$/, "");
const root = `${CARD}/IMPORT`;
const write = vi.fn(async (path: string, data: Uint8Array) => {
  if (fs.has(normalize(path))) throw new Error(`Would overwrite ${path}`);
  fs.set(normalize(path), data.slice());
});
const device = {
  listDir: vi.fn(async (path: string) => {
    const prefix = `${normalize(path)}/`;
    return [...fs].filter(([key]) => key.startsWith(prefix) && !key.slice(prefix.length).includes("/"))
      .map(([key, data]) => ({ name: key.slice(prefix.length), dir: data === null }));
  }),
  stat: vi.fn(async (path: string) => fs.has(normalize(path)) ? { size: fs.get(normalize(path))?.length ?? 0 } : null),
  mkdirCard: vi.fn(async (path: string) => {
    if (fs.has(normalize(path))) throw new Error(`Directory already exists: ${path}`);
    fs.set(normalize(path), null);
  }),
  writeCardFile: write,
};

beforeAll(async () => {
  vi.stubGlobal("location", { search: "", hash: "", pathname: "/nexus-404/" });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem() {} });
  api = await import("./slice"); store = await import("./store"); card = await import("./card");
  menu = await import("./sliceExport");
  draftApi = await import("./patternDraft");
  vi.spyOn(store, "withDevice").mockImplementation((fn) => fn(device as unknown as SP404Device));
  vi.spyOn(store, "importToPads").mockResolvedValue(1);
  configureOriginal = store.configureLoopPad; patternsOriginal = store.createLoopPatterns;
  vi.spyOn(store, "configureLoopPad").mockResolvedValue(true);
  vi.spyOn(store, "createLoopPatterns").mockImplementation(async (items) => ({ done: items.length, kept: true, cancelled: false }));
  vi.spyOn(card, "openCardDir").mockResolvedValue(undefined);
});

beforeEach(() => {
  vi.clearAllMocks(); fs.clear(); fs.set(root, null);
  const frames = 192000;
  const stem = (label: string, family: import("./slice").Stem["family"], sample: number) => ({
    name: `${label}.wav`, label, tag: label, family, channels: 1 as const, frames,
    samples: new Int16Array(frames).fill(sample), peaks: [],
  });
  batch(() => {
    api.slState.value = "idle"; api.slBusy.value = null; api.slClean.value = "off";
    api.slTrack.value = { id: sequence++, name: "Keyboard.wav", frames, stems: [
      stem("vocals", "vocal", 1000), stem("drums", "drums", 2000), stem("drums_2", "drums", 3000),
      stem("bass", "bass", 4000), stem("fx", "others", 5000),
    ] };
    api.slStemGroup.value = [0, 1, 1, 2, -1]; api.slGroupNames.value = ["vocal", "drums", "bass", "others"];
    api.slMuted.value = new Set(); api.slSolo.value = new Set(); api.slGroupMuted.value = new Set(); api.slGroupSolo.value = new Set();
    api.slGain.value = new Map(); api.slLoopGain.value = new Map(); api.slWritten.value = new Map();
    api.slGrid.value = { x100: 14500, beatsPerBar: 4, origin: 0, clarity: 1 };
    api.slCuts.value = new Set([1, 2, 3]); api.slOff.value = new Set(); api.slFadeMs.value = 0;
    api.slMixStartPad.value = 0; api.slMixFolder.value = "Loops";
    menu.exportTarget.value = "card"; menu.exportRunning.value = false; menu.exportMakePatterns.value = false;
    store.conn.value = "ready"; store.demo.value = false; store.project.value = null;
    store.pads.value = Array(160).fill(null); store.notice.value = null;
    store.patterns.value = new Map(); store.patternFiles.value = new Map();
    store.patternsLoading.value = false; store.patternWriting.value = null; draftApi.drafts.value = new Map();
    card.cardBusy.value = null; api.slState.value = "ready";
  });
});

afterAll(() => {
  api.slTrack.value = null; api.slGrid.value = null;
  store.conn.value = "idle"; card.cardBusy.value = null;
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

const sample = (path: string) => {
  const data = fs.get(`${root}/${path}`)!;
  return new DataView(data!.buffer, data!.byteOffset, data!.byteLength).getInt16(44, true);
};

it("writes separate stems into their group folders with group, stem, loop and BPM in the name", async () => {
  await api.writeLoops();
  expect(device.mkdirCard.mock.calls.map(([path]) => path)).toEqual([`${root}/vocal`, `${root}/drums`, `${root}/bass`]);
  expect(write).toHaveBeenCalledTimes(8);
  expect(sample("drums/drums_drums_01_145bpm.wav")).toBe(2000);
  expect(sample("drums/drums_drums_2_01_145bpm.wav")).toBe(3000);
  expect(sample("bass/bass_bass_02_145bpm.wav")).toBe(4000);
  expect(write.mock.calls.every(([path]) => !path.includes("Keyboard") && !path.includes("mix"))).toBe(true);
  expect(api.writtenAs(api.slLoops.value[0]!)).toEqual(["vocal/vocals", "drums/drums", "drums/drums_2", "bass/bass"]);
  expect(card.openCardDir).toHaveBeenCalledWith(["IMPORT"]);
});

it("exports only audible grouped stems for one loop, reuses the group directory, and preserves existing files", async () => {
  const existing = new Uint8Array([7, 8, 9]);
  fs.set(`${root}/Drums`, null);
  fs.set(`${root}/Drums/drums_drums_02_145bpm.wav`, existing);
  api.toggleGroupSolo(1); api.toggleMute(2); api.setStemGain(1, -20);
  await api.writeOne(2);
  expect(write.mock.calls.map(([path]) => path)).toEqual([`${root}/Drums/drums_drums_02_145bpm_2.wav`]);
  expect(sample("Drums/drums_drums_02_145bpm_2.wav")).toBe(200);
  expect(fs.get(`${root}/Drums/drums_drums_02_145bpm.wav`)).toBe(existing);
  expect(device.mkdirCard).not.toHaveBeenCalled();
  expect(card.openCardDir).toHaveBeenCalledWith(["IMPORT", "Drums"]);
});

it("writes one complete mix per loop to the card with solo, mute and both levels of volume, including No group", async () => {
  api.toggleGroupSolo(1); api.toggleSolo(4); api.toggleMute(2);
  api.setStemGain(1, -20); api.setLoopGain(1, 4, -20);
  await api.writeMixLoops();
  expect(write).toHaveBeenCalledTimes(2);
  expect(sample("Loops/Loops_01_145bpm.wav")).toBe(700);
  expect(sample("Loops/Loops_02_145bpm.wav")).toBe(5200);
  expect(device.mkdirCard.mock.calls.map(([path]) => path)).toEqual([`${root}/Loops`]);
  expect(api.writtenAs(api.slLoops.value[0]!)).toEqual(["mix"]);
  expect(card.openCardDir).toHaveBeenCalledWith(["IMPORT", "Loops"]);
});

it("imports mixed loops to previewed free pads, skipping occupied pads and protected banks", async () => {
  api.slStemGroup.value = [-1, -1, -1, -1, -1];
  api.toggleSolo(4); api.setStemGain(4, -20); api.setLoopGain(1, 4, -20);
  api.slMixStartPad.value = 14;
  const occupied = { size: 100, name: "Keep me" } as PadBlock;
  store.pads.value = store.pads.value.map((p, i) => i === 14 ? occupied : p);
  store.project.value = { banks: Array.from({ length: 10 }, (_, i) => ({ protected: i === 1 })) } as ProjectSettings & { names: string[] };
  expect(api.slMixPads.value).toEqual([15, 32]); expect(api.slMixPadBlock.value).toBeNull();
  await api.writeMixPads();
  const calls = vi.mocked(store.importToPads).mock.calls;
  expect(calls.map(([files]) => files[0]!.pad)).toEqual([15, 32]);
  expect(calls.map(([files]) => files[0]!.bpmX100)).toEqual([14500, 14500]);
  const samples = await Promise.all(calls.map(async ([files]) => new DataView(await files[0]!.file.arrayBuffer()).getInt16(44, true)));
  expect(samples).toEqual([50, 500]);
  expect(store.pads.value[14]).toBe(occupied);
  expect(store.withDevice).not.toHaveBeenCalled();
});

it("blocks insufficient pad capacity and empty mixes without starting a write", async () => {
  api.slMixStartPad.value = 159;
  expect(api.slMixPadBlock.value).toContain("Not enough free pads");
  await api.writeMixPads(); expect(store.importToPads).not.toHaveBeenCalled();
  api.slMuted.value = new Set([0, 1, 2, 3, 4]);
  await api.writeMixLoops(); expect(write).not.toHaveBeenCalled();
});

it("keeps stem and loop volume in the mix when only one stem remains", async () => {
  const track = api.slTrack.value!;
  api.slTrack.value = { ...track, stems: [track.stems[0]!] };
  api.setStemGain(0, -20); api.setLoopGain(1, 0, -20);
  await api.writeMixLoops();
  expect(sample("Loops/Loops_01_145bpm.wav")).toBe(10);
  expect(sample("Loops/Loops_02_145bpm.wav")).toBe(100);
});

it("stops after the current card file and keeps the progress controls available", async () => {
  write.mockImplementationOnce(async (path, data) => { fs.set(normalize(path), data.slice()); api.cancelWrite(); });
  await api.writeLoops();
  expect(write).toHaveBeenCalledTimes(1);
  expect(store.notice.value?.text).toContain("stopped");
  expect(api.slBusy.value).toBeNull(); expect(card.cardBusy.value).toBeNull();
});

it("uses a real common track name instead of an arbitrary instrument's name", () => {
  expect(stemTrackName(["vocals.wav", "Keyboard.wav", "drums.wav"])).toBe("Stems.wav");
  expect(stemTrackName(["Song (Vocals).wav", "Song (Drums).wav"])).toBe("Song.wav");
  expect(stemTrackName(["Song (Vocals).wav", "OtherSong (Drums).wav"])).toBe("Stems.wav");
  expect(stemTrackName(["Keyboard.wav"])).toBe("Keyboard.wav");
});

it.each(["card", "pads", "both"] as const)("exports only checked loops to %s, preserving their original numbers", async (target) => {
  menu.exportTarget.value = target;
  api.slOff.value = new Set([1]);
  api.toggleGroupSolo(1); api.toggleSolo(4); api.toggleMute(2);
  api.setStemGain(1, -20); api.setLoopGain(1, 4, -20);
  expect(menu.exportCount.value).toBe(1); expect(menu.exportBlock.value).toBeNull();
  await menu.runExport();
  if (target !== "pads") {
    expect(write).toHaveBeenCalledTimes(1);
    expect(fs.has(`${root}/Loops/Loops_01_145bpm.wav`)).toBe(false);
    expect(sample("Loops/Loops_02_145bpm.wav")).toBe(5200);
  } else expect(write).not.toHaveBeenCalled();
  if (target !== "card") {
    const calls = vi.mocked(store.importToPads).mock.calls;
    expect(calls.map(([files]) => files[0]!.pad)).toEqual([0]);
    const samples = await Promise.all(calls.map(async ([files]) => new DataView(await files[0]!.file.arrayBuffer()).getInt16(44, true)));
    expect(samples).toEqual([5200]);
    expect(calls.map(([files]) => files[0]!.file.name)).toEqual(["Loops_02_1bars_145bpm.wav"]);
    expect(store.configureLoopPad).toHaveBeenCalledWith(0);
  } else expect(store.importToPads).not.toHaveBeenCalled();
  expect(menu.exportRunning.value).toBe(false); expect(api.slBusy.value).toBeNull();
});

it("blocks an empty selection and recalculates capacity and size when a loop is checked again", async () => {
  menu.exportTarget.value = "both"; menu.exportStartPad.value = 159;
  api.setAllOff(true);
  expect(menu.exportBlock.value).toContain("No loops selected");
  expect(menu.exportCount.value).toBe(0); expect(menu.exportBytes.value).toBe(0);
  await menu.runExport();
  expect(write).not.toHaveBeenCalled(); expect(store.importToPads).not.toHaveBeenCalled();
  api.toggleOff(2);
  expect(menu.exportCount.value).toBe(1); expect(menu.exportBytes.value).toBeGreaterThan(0);
  expect(menu.exportPadCells.value).toEqual([{ pad: 159, loop: 0 }]);
  expect(menu.exportBlock.value).toBeNull();
  await menu.runExport();
  expect(write).toHaveBeenCalledTimes(1);
  expect(vi.mocked(store.importToPads).mock.calls[0]![0][0]!.pad).toBe(159);
});

it("checks pad capacity before writing anything in Both", async () => {
  menu.exportTarget.value = "both"; menu.exportStartPad.value = 159;
  expect(menu.exportBlock.value).toContain("Not enough free pads");
  await menu.runExport();
  expect(write).not.toHaveBeenCalled(); expect(store.importToPads).not.toHaveBeenCalled();
});

it("does not assign pads after a failed card write in Both", async () => {
  menu.exportTarget.value = "both";
  write.mockRejectedValueOnce(new Error("Card write failed"));
  await menu.runExport();
  expect(store.importToPads).not.toHaveBeenCalled();
  expect(store.notice.value).toMatchObject({ kind: "error" });
  expect(api.slBusy.value).toBeNull(); expect(menu.exportRunning.value).toBe(false);
});

it("does not start pad assignment after Stop during a card write in Both", async () => {
  menu.exportTarget.value = "both";
  write.mockImplementationOnce(async (path, data) => { fs.set(normalize(path), data.slice()); api.cancelWrite(); });
  await menu.runExport();
  expect(write).toHaveBeenCalledTimes(1); expect(store.importToPads).not.toHaveBeenCalled();
  expect(store.notice.value?.text).toContain("stopped");
  expect(api.slBusy.value).toBeNull(); expect(menu.exportRunning.value).toBe(false);
});

it("retains the current-loop export backend without changing the all-loops plan", async () => {
  menu.exportTarget.value = "pads";
  await menu.exportCurrentLoop(2);
  const calls = vi.mocked(store.importToPads).mock.calls;
  expect(calls).toHaveLength(1); expect(calls[0]![0][0]!.file.name).toBe("Loops_02_1bars_145bpm.wav");
  expect(menu.exportCount.value).toBe(2);
});

function reference(slot = 0) {
  const p = loopPattern(slot, 1, 3), bytes = writePattern(p);
  store.patterns.value = new Map([[slot, p]]);
  store.patternFiles.value = new Map([[slot, { bytes, exact: true }]]);
}

it("pairs samples and patterns in the previewed cells, skipping patterns and drafts", async () => {
  menu.exportTarget.value = "both"; menu.exportMakePatterns.value = true; menu.exportStartPad.value = 16;
  reference(16); draftApi.startDraft(17, loopPattern(17, 1, 4));
  api.slCuts.value = new Set([1, 9, 25]); // 8 and 16 bars
  expect(menu.exportPadCells.value).toEqual([{ pad: 18, loop: 0 }, { pad: 19, loop: 1 }]);
  expect(menu.exportBlock.value).toBeNull();
  await menu.runExport();
  const calls = vi.mocked(store.importToPads).mock.calls;
  expect(calls.map(([files]) => [files[0]!.pad, files[0]!.file.name])).toEqual([
    [18, "Loops_01_8bars_145bpm.wav"], [19, "Loops_02_16bars_145bpm.wav"],
  ]);
  expect(store.configureLoopPad).toHaveBeenNthCalledWith(1, 18);
  expect(store.configureLoopPad).toHaveBeenNthCalledWith(2, 19);
  const items = vi.mocked(store.createLoopPatterns).mock.calls[0]![0];
  expect(items.map(({ slot, bytes }) => {
    const p = parsePattern(bytes); return [slot, p.bars, p.length, p.beatsPerBar, p.notes.map((n) => [n.pad, n.tick, n.velocity])];
  })).toEqual([[18, 8, 8 * 1920, 4, [[18, 0, 127]]], [19, 16, 16 * 1920, 4, [[19, 0, 127]]]]);
  expect(store.patterns.value!.get(16)).toMatchObject({ bars: 1 });
  expect(draftApi.drafts.value.has(17)).toBe(true);
  expect(write.mock.calls.every(([path]) => !path.includes("bars"))).toBe(true);
});

it("checks reference, pattern capacity and 64-bar limit before either destination is written", async () => {
  menu.exportTarget.value = "both"; menu.exportMakePatterns.value = true;
  expect(menu.exportBlock.value).toContain("reference pattern");
  store.patterns.value = null;
  expect(menu.exportBlock.value).toContain("Read the project's patterns");
  reference(); api.slCuts.value = new Set([1, 66]);
  expect(menu.exportBlock.value).toContain("64 bars");
  await menu.runExport();
  expect(write).not.toHaveBeenCalled(); expect(store.importToPads).not.toHaveBeenCalled();
  api.slCuts.value = new Set([1, 2, 3]); menu.exportStartPad.value = 159; reference(159);
  expect(menu.exportBlock.value).toContain("Not enough free pads");
  await menu.runExport();
  expect(store.createLoopPatterns).not.toHaveBeenCalled();
  menu.exportTarget.value = "card";
  expect(menu.exportBlock.value).toBeNull(); // remembered pattern option never affects card-only export
});

it("does not create patterns after a failed pad configuration or stopped sample import", async () => {
  menu.exportTarget.value = "pads"; menu.exportMakePatterns.value = true; reference();
  vi.mocked(store.configureLoopPad).mockResolvedValueOnce(false);
  await menu.runExport();
  expect(store.createLoopPatterns).not.toHaveBeenCalled();
  expect(store.notice.value).toMatchObject({ kind: "error" });
  vi.mocked(store.importToPads).mockImplementationOnce(async () => { api.cancelWrite(); return 1; });
  await menu.runExport();
  expect(store.createLoopPatterns).not.toHaveBeenCalled();
  expect(api.slBusy.value).toBeNull(); expect(menu.exportRunning.value).toBe(false);
});

it("applies playback settings and creates matching patterns in demo using the real store helpers", async () => {
  store.demo.value = true; menu.exportTarget.value = "pads"; menu.exportMakePatterns.value = true; menu.exportStartPad.value = 16;
  vi.mocked(store.configureLoopPad).mockImplementationOnce(configureOriginal).mockImplementationOnce(configureOriginal);
  vi.mocked(store.createLoopPatterns).mockImplementationOnce(patternsOriginal);
  await menu.runExport();
  for (const pad of [16, 17]) {
    expect(store.pads.value[pad]).toMatchObject({ gate: false, bpmSync: true, vinyl: false, vari: 2 });
    const p = store.patterns.value!.get(pad)!;
    expect(p).toMatchObject({ bars: 1, length: 1920, notes: [{ pad, tick: 0, velocity: 127 }] });
    expect(parsePattern(store.patternFiles.value.get(pad)!.bytes)).toEqual(p);
  }
  expect(store.importToPads).not.toHaveBeenCalled();
});
