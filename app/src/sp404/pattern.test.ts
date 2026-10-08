import { describe, expect, it } from "vitest";
import { noteSemitones, padMidiNote, parsePattern, patternMidiName, patternPads, patternPath, patternToMidi, slotOfFileName } from "./pattern";

const file = (...recs: number[][]) => Uint8Array.from(recs.flat());
const END = [0, 0x8c, 0, 0, 0, 0, 0, 0];
const trailer = (bars: number, sig = 0) => [bars, 0, 0, 0, sig, 0x80, bars, 1];

describe("pattern files", () => {
  it("names slots like the SP", () => {
    expect(patternPath(4, 0)).toBe("ROLAND/SP-404MKII/PROJECT_04/PTN/PTN00001.BIN");
    expect(patternPath(12, 159)).toBe("ROLAND/SP-404MKII/PROJECT_12/PTN/PTN00160.BIN");
    expect(slotOfFileName("PTN00097.BIN")).toBe(96);
    expect(slotOfFileName("ptn00160.bin")).toBe(159);
    expect(slotOfFileName("PTN00161.BIN")).toBeNull();
    expect(slotOfFileName("PATTERNCHAIN_00.CHN")).toBeNull();
    expect(patternMidiName(4, 96)).toBe("Proj4_PTN_BANK_G-01.MID");
  });

  it("reads notes, times, banks F–J and the length", () => {
    const p = parsePattern(file(
      [0x00, 0x2f, 0x40, 0, 0x7f, 0x40, 0x28, 0x00], // A1 at 0, flag 0x40 on the first note
      [0xa0, 0x31, 0x01, 0, 0x19, 0x40, 0x31, 0x00], // F3 at 0, velocity 25
      [0xff, 0x80, 0, 0, 0, 0, 0, 0], // filler
      [0x00, 0x80, 0, 0, 0, 0, 0, 0xff], // no-op seen once per file
      [0x01, 0x7e, 0x01, 0x8d, 0x7f, 0x40, 0xd0, 0x07], // J16 at 160 + 255 = 415, pitched, gate 2000
      [0x00, 0x8e, 0x02, 0, 0, 0x07, 0x64, 0], // CC 7 = 100 on channel 3 at 416
      [0x00, 0x8c, 0, 0, 0, 0, 0, 0],
      trailer(4),
    ));
    expect(p.notes.map((n) => [n.tick, n.pad, n.velocity, n.gate, n.pitch])).toEqual([
      [0, 0, 127, 40, 0], [0, 82, 25, 49, 0], [415, 159, 127, 2000, 0x8d],
    ]);
    expect(p.controls).toEqual([{ tick: 416, seq: 5, channel: 2, controller: 7, value: 100 }]);
    expect(p.length).toBe(416);
    expect([p.bars, p.beatsPerBar, p.unknown]).toEqual([4, 4, 0]);
    expect(patternPads(p)).toEqual([0, 82, 159]);
    expect(p.notes.map(noteSemitones)).toEqual([null, null, 0]);
    expect(noteSemitones({ ...p.notes[2], pitch: 0x8e })).toBe(1); // TR-REC step +1 semitone on the SP
  });

  it("reads the time signature and the bars", () => {
    const p = parsePattern(file([0x00, 0x2f, 0, 0, 0x7f, 0x40, 0x10, 0], [0xa0, 0x80, 0, 0, 0, 0, 0, 0], [0xa0, 0x8c, 0, 0, 0, 0, 0, 0], trailer(1, 3)));
    expect([p.length, p.bars, p.beatsPerBar]).toEqual([320, 1, 3]);
    expect(parsePattern(file(END, trailer(2, 9))).beatsPerBar).toBe(4); // 7 and above: 4/4
  });

  it("refuses a file without an end", () => {
    expect(() => parsePattern(file([0x00, 0x2f, 0, 0, 0x7f, 0x40, 0x10, 0], [0, 0x80, 0, 0, 0, 0, 0, 0]))).toThrow();
    expect(() => parsePattern(Uint8Array.from([1, 2, 3]))).toThrow();
  });
});

describe("pattern → MIDI", () => {
  it("maps pads to notes and channels like the SP", () => {
    expect(padMidiNote(12)).toBe(36); // A13
    expect(padMidiNote(0)).toBe(48); // A1
    expect(padMidiNote(16 * 9 + 3)).toBe(51); // J4
  });

  it("writes the file the official app writes", () => {
    // D13 and D14 together at tick 0, gate 5, length 10, bank tempo 120.
    const p = parsePattern(file([0x00, 0x6b, 0, 0, 0x7f, 0x40, 0x05, 0], [0x0a, 0x6c, 0, 0, 0x7f, 0x40, 0x05, 0], END, [0xff, 0, 0, 0, 0x07, 0, 0, 1]));
    const track = [
      0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20, // 500000 µs
      0x00, 0x93, 36, 0x7f, // D13 on
      0x00, 37, 0x7f, // D14 on, running status
      0x00, 0xff, 0x58, 0x04, 4, 2, 1, 0x60, // after the tick-0 notes
      0x05, 0x83, 36, 0x40,
      0x00, 37, 0x40,
      0x05, 0xff, 0x58, 0x04, 4, 2, 1, 0x60, // again at the end
      0x00, 0xff, 0x2f, 0x00,
    ];
    expect([...patternToMidi(p, 12000)]).toEqual([
      ...[0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0x01, 0xe0],
      ...[0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, track.length], ...track,
    ]);
  });

  it("puts the time signature before the first event past tick 0, and aftertouch around pitched notes", () => {
    // Byte 0 is the time to the next record: the filler puts the note at 16, the note the end at 48.
    const p = parsePattern(file([0x10, 0x80, 0, 0, 0, 0, 0, 0], [0x20, 0x2f, 0, 0x8d, 0x50, 0x40, 0x08, 0], END, trailer(1)));
    const t = [...patternToMidi(p, 9000)].slice(22);
    expect(t).toEqual([
      0x00, 0xff, 0x51, 0x03, 0x0a, 0x2c, 0x2a, // 666666 µs = 90 BPM
      0x00, 0xff, 0x58, 0x04, 4, 2, 1, 0x60,
      0x10, 0xa0, 48, 77, // 64 + 13
      0x00, 0x90, 48, 0x50,
      0x08, 0xa0, 48, 77,
      0x00, 0x80, 48, 0x40,
      0x18, 0xff, 0x58, 0x04, 4, 2, 1, 0x60, // length 0x30
      0x00, 0xff, 0x2f, 0x00,
    ]);
  });
});
