import { describe, expect, it } from "vitest";
import { banksText, cellPad, defaultGroups, groupSampleName, groupSlugs, padLayout } from "./groups";
import { padName } from "./control";
import { stemKind, stemKinds } from "./stems";

describe("stem groups on pads", () => {
  it("groups nine stems into vocal, drums, bass, others by their names", () => {
    const names = ["Song (Lead Vocals).wav", "Song (Backing Vocals).wav", "Song (Kick).wav", "Song (Snare).wav", "Song (Hi-Hat).wav",
      "Song (Bass).wav", "Song (Piano).wav", "Song (Guitar).wav", "Song (Other).wav"];
    const kinds = stemKinds(names);
    expect(kinds.map((k) => k.label)).toEqual(["vocals", "backvox", "kick", "snare", "hihat", "bass", "piano", "guitar", "other"]);
    expect(defaultGroups(kinds.map((k) => k.family))).toEqual([0, 0, 1, 1, 1, 2, 3, 3, 3]);
  });

  it("tells a backing voice from a backing track, and two words from one", () => {
    expect(stemKind("song_backing_vocals.wav")?.label).toBe("backvox");
    expect(stemKind("song_backing.wav")?.label).toBe("inst");
    expect(stemKind("song_no_vocals.wav")?.label).toBe("inst");
    expect(stemKind("drum_bass.wav")?.label).toBe("bass"); // the last word, not "drum" of the pair
    expect(stemKind("x.wav")).toBeNull();
    expect(stemKinds(["x.wav"])[0]!.family).toBe("others");
  });

  it("lays a group out as a column and a loop as a row, the fifth loop in the next bank", () => {
    expect([0, 1, 2, 3].map((l) => padName(cellPad(0, l, 0)))).toEqual(["A1", "A5", "A9", "A13"]);
    expect([0, 1, 2, 3].map((l) => padName(cellPad(0, l, 1)))).toEqual(["A2", "A6", "A10", "A14"]);
    expect(padName(cellPad(0, 4, 0))).toBe("B1");
    expect(padName(cellPad(2, 5, 3))).toBe("D8");
    const cells = padLayout([0, 1, 1, 3], 5, 0)!;
    // Row by row, only the columns in use, each once.
    expect(cells.slice(0, 6).map((c) => `${padName(c.pad)}:${c.group}:${c.loop}`)).toEqual(["A1:0:0", "A2:1:0", "A4:3:0", "A5:0:1", "A6:1:1", "A8:3:1"]);
    expect(cells).toHaveLength(15);
    expect(padName(cells.at(-1)!.pad)).toBe("B4");
    expect(banksText(0, 5)).toBe("A–B");
    expect(banksText(3, 4)).toBe("D");
  });

  it("refuses a layout that runs past bank J", () => {
    expect(padLayout([0], 40, 0)).toHaveLength(40);
    expect(padLayout([0], 41, 0)).toBeNull();
    expect(padLayout([0], 4, 9)).toHaveLength(4);
    expect(padLayout([0], 5, 9)).toBeNull();
  });

  it("names samples after the group and the pad, short enough for the pad", () => {
    const slugs = groupSlugs(["vocal", "Drums & Perc", "", "drums & perc!", "Very long group name for pads"]);
    expect(slugs).toEqual(["vocal", "Drums_Perc", "group3", "drums_perc4", "Very_long_group_nam"]);
    expect(groupSampleName("drums", 0)).toBe("drums_A1");
    expect(groupSampleName(slugs[4]!, 156)).toBe("Very_long_group_nam_J13");
    expect(groupSampleName(slugs[4]!, 156).length).toBeLessThanOrEqual(23);
    expect(groupSlugs(["Вокал"])).toEqual(["group1"]); // no Latin letters: the column's name
  });

});
