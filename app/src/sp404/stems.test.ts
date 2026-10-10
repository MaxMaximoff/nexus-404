import { describe, expect, it } from "vitest";
import { gridStem, stemBase, stemKind, stemKinds } from "./stems";
import { loopFileName } from "./grid";
import { bpmFromFileName } from "./audio";

describe("stems", () => {
  it("tells the kind of a stem by its name (UVR, Demucs)", () => {
    expect(stemKind("1_Kein Wiedersehen_(Vocals).wav")?.label).toBe("vocals");
    expect(stemKind("1_Kein Wiedersehen_(Instrumental).wav")?.label).toBe("inst");
    expect(stemKind("1_Song_(No Vocals).wav")?.label).toBe("inst");
    expect(stemKind("drums.wav")?.label).toBe("drums");
    expect(stemKind("song_bass.flac")?.label).toBe("bass");
    expect(stemKind("other.wav")?.label).toBe("other");
    expect(stemKind("Vocal Trance Anthem (Drums).wav")?.label).toBe("drums"); // the tag beats the title
    expect(stemKind("Kein Wiedersehen.mp3")).toBeNull();
  });

  it("finds the track's own name", () => {
    expect(stemBase("1_Kein Wiedersehen_(Vocals).wav")).toBe("Kein Wiedersehen");
    expect(stemBase("1_Kein Wiedersehen_(Instrumental).wav")).toBe("Kein Wiedersehen");
    expect(stemBase("Track (Remix) (Vocals).wav")).toBe("Track (Remix)");
    expect(stemBase("song_vocals.wav")).toBe("song");
    expect(stemBase("vocals.wav")).toBe("");
  });

  it("gives every stem its own label and picks the grid source", () => {
    const k = stemKinds(["a_(Vocals).wav", "a_(Instrumental).wav"]);
    expect(k.map((x) => x.label)).toEqual(["vocals", "inst"]);
    expect(gridStem(k)).toBe(1);
    expect(gridStem(stemKinds(["vocals.wav", "bass.wav", "drums.wav", "other.wav"]))).toBe(2);
    const u = stemKinds(["x.wav", "y.wav", "z (Vocals).wav", "w (Vocals).wav"]);
    expect(u.map((x) => `${x.label}/${x.tag}`)).toEqual(["track1/t1", "track2/t2", "vocals/vox", "vocals_2/vox2"]);
    expect(gridStem(u)).toBe(-1);
  });

  it("puts the stem's tag into loop names that still fit a pad and carry the tempo", () => {
    const name = loopFileName("Kein Wiedersehen.wav", 7, 29, 13999, "vox");
    expect(name).toBe("Kein_07_vox_139.99bpm.wav");
    expect(name.length - 4).toBeLessThanOrEqual(23);
    expect(bpmFromFileName(name)).toBe(13999);
  });
});
