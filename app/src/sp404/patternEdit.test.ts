import { describe, expect, it } from "vitest";
import { PPQ, parsePattern, patternToMidi, type Pattern } from "./pattern";
import {
  addNote, clearBar, clearPad, copyBar, copyNotes, doublePattern, duplicateOffset, fillPad, findNote, gateFor, moveNote, moveNotes, noteAt, pasteNotes, removeNote,
  removeNotes, resizeNote, rollNote, semitonesOf, setBars, setSemitones, setVelocities, setVelocity, shiftPad, STEP,
} from "./patternEdit";

const empty = (bars = 2): Pattern => ({ notes: [], controls: [], length: bars * 4 * PPQ, bars, beatsPerBar: 4, unknown: 0 });
const add = (p: Pattern, pad: number, tick: number, gate?: number) => addNote(p, pad, tick, gate).pattern;
const ticks = (p: Pattern, pad = 0) => p.notes.filter((n) => n.pad === pad).map((n) => n.tick).sort((a, b) => a - b);

describe("adding and removing notes", () => {
  it("adds a note like TR-REC does", () => {
    const { pattern, note } = addNote(empty(), 3, 240);
    expect(note).toMatchObject({ tick: 240, pad: 3, velocity: 90, offVelocity: 64, gate: 119, pitch: 0x8d });
    expect(pattern.notes).toHaveLength(1);
    expect(semitonesOf(note!)).toBe(0);
  });

  it("refuses a note outside the pattern or on another note of the pad", () => {
    const p = add(empty(1), 0, 0);
    expect(addNote(p, 0, 1920).note).toBeNull(); // the pattern is 1920 ticks
    expect(addNote(p, 0, -5).note).toBeNull();
    expect(addNote(p, 0, 60).note).toBeNull(); // inside the first note
    expect(addNote(p, 1, 60).note).not.toBeNull(); // another pad is free
    expect(addNote(p, 0, STEP).note).not.toBeNull(); // the next step is free
  });

  it("cuts a new note short before the next one", () => {
    const p = add(empty(), 0, 100, 10);
    expect(addNote(p, 0, 0, 119).note?.gate).toBe(99);
    expect(addNote(empty(1), 0, 1900, 119).note?.gate).toBe(20); // up to the end of the pattern
  });

  it("gives notes distinct, growing seq", () => {
    let p = empty();
    for (const t of [0, 120, 240]) p = add(p, 0, t);
    expect(p.notes.map((n) => n.seq)).toEqual([0, 1, 2]);
    p = removeNote(p, 1);
    expect(addNote(p, 0, 120).note?.seq).toBe(3);
  });

  it("removes a note or a whole pad, and leaves the object alone when nothing changed", () => {
    let p = add(add(add(empty(), 0, 0), 0, 120), 1, 0);
    expect(removeNote(p, 99)).toBe(p);
    expect(clearPad(p, 7)).toBe(p);
    expect(ticks(removeNote(p, 0))).toEqual([120]);
    expect(clearPad(p, 0).notes.map((n) => n.pad)).toEqual([1]);
  });
});

describe("moving and resizing", () => {
  it("moves a note in time and between pads, and refuses a collision", () => {
    const p = add(add(add(empty(), 0, 0), 0, 240), 1, 120);
    expect(ticks(moveNote(p, 0, { tick: 120 }))).toEqual([120, 240]);
    expect(moveNote(p, 0, { tick: 240 })).toBe(p); // lands on the other note
    expect(moveNote(p, 0, { pad: 1 }).notes.find((n) => n.seq === 0)).toMatchObject({ pad: 1, tick: 0 });
    expect(moveNote(p, 0, { pad: 1, tick: 120 })).toBe(p); // pad 1 already has a note there
    expect(moveNote(p, 0, { tick: 0 })).toBe(p); // nothing changes
  });

  it("keeps a moved note inside the pattern", () => {
    const p = add(empty(1), 0, 0);
    const q = moveNote(p, 0, { tick: 5000 });
    expect(q.notes[0].tick).toBe(1919);
    expect(q.notes[0].gate).toBe(1);
    expect(moveNote(p, 0, { tick: -50 })).toBe(p);
  });

  it("resizes between one tick and the next note", () => {
    const p = add(add(empty(), 0, 0), 0, 480);
    expect(findNote(resizeNote(p, 0, 240), 0)?.gate).toBe(240);
    expect(findNote(resizeNote(p, 0, 9999), 0)?.gate).toBe(479); // stops before the note at 480
    expect(findNote(resizeNote(p, 0, -3), 0)?.gate).toBe(1);
    expect(findNote(resizeNote(p, 1, 9999), 1)?.gate).toBe(p.length - 480);
    expect(resizeNote(p, 0, 119)).toBe(p);
  });
});

describe("velocity and pitch", () => {
  it("clamps velocity to 1–127", () => {
    const p = add(empty(), 0, 0);
    expect(setVelocity(p, 0, 200).notes[0].velocity).toBe(127);
    expect(setVelocity(p, 0, 0).notes[0].velocity).toBe(1);
    expect(setVelocity(p, 0, 90)).toBe(p);
  });

  it("writes semitones the way TR-REC does (+1 gave 0x8E on the SP)", () => {
    const p = add(empty(), 0, 0);
    expect(setSemitones(p, 0, 1).notes[0].pitch).toBe(0x8e);
    expect(setSemitones(p, 0, -2).notes[0].pitch).toBe(0x8b);
    expect(setSemitones(p, 0, 99).notes[0].pitch).toBe(0x80 | 25);
    expect(setSemitones(p, 0, 0)).toBe(p);
    const live = { ...p, notes: [{ ...p.notes[0], pitch: 0 }] };
    expect(semitonesOf(live.notes[0])).toBeNull();
    expect(setSemitones(live, 0, 0).notes[0].pitch).toBe(0x8d);
  });
});

describe("rolls", () => {
  it("splits a note like a TR-REC sub-step: 2 → 60 apart, 3 → 40, 4 → 30", () => {
    for (const [parts, gap] of [[2, 60], [3, 40], [4, 30]] as const) {
      const p = add(empty(), 0, 120);
      const { pattern, seqs } = rollNote(p, 0, parts);
      expect(seqs).toHaveLength(parts);
      expect(ticks(pattern)).toEqual(Array.from({ length: parts }, (_, i) => 120 + i * gap));
      expect(pattern.notes.every((n) => n.gate === gap - 1 && n.velocity === 90)).toBe(true);
      expect(pattern.notes.find((n) => n.seq === 0)).toBeUndefined();
    }
  });

  it("refuses a roll that would hit the next note or leave the pattern", () => {
    const p = add(add(empty(), 0, 0, 30), 0, 60);
    expect(p.notes).toHaveLength(2);
    expect(rollNote(p, 0, 2).pattern).toBe(p); // the second part would sit on the note at 60
    const last = add(empty(1), 0, 1900, 10);
    expect(rollNote(last, 0, 4).pattern).toBe(last);
    expect(rollNote(p, 0, 1).pattern).toBe(p);
  });
});

describe("length and bars", () => {
  it("shortens the pattern, dropping and cutting notes", () => {
    let p = empty(2);
    p = add(add(add(p, 0, 0), 0, 1800, 400), 0, 2000);
    const q = setBars(p, 1);
    expect([q.bars, q.length]).toEqual([1, 1920]);
    expect(ticks(q)).toEqual([0, 1800]);
    expect(q.notes[1].gate).toBe(120); // cut at the new end
  });

  it("lengthens it without touching the notes, and respects the time signature", () => {
    const p = add(empty(1), 0, 0);
    const q = setBars(p, 4);
    expect([q.bars, q.length, q.notes]).toEqual([4, 7680, p.notes]);
    expect(setBars({ ...empty(1), beatsPerBar: 3 }, 2).length).toBe(2 * 3 * PPQ);
    expect(setBars(p, 0).bars).toBe(1);
    expect(setBars(p, 99).bars).toBe(16);
    expect(setBars(p, 1)).toBe(p);
  });

  it("copies a bar over another", () => {
    let p = empty(2);
    p = add(add(add(p, 0, 0), 0, 480), 0, 2400); // 2400 is in bar 2
    const q = copyBar(p, 0, 1);
    expect(ticks(q)).toEqual([0, 480, 1920, 2400]);
    expect(copyBar(p, 0, 0)).toBe(p);
    expect(copyBar(p, 0, 5)).toBe(p);
    expect(ticks(copyBar(q, 1, 0))).toEqual([0, 480, 1920, 2400]);
  });
});

describe("the edited pattern", () => {
  it("answers noteAt for any tick the note covers", () => {
    const p = add(empty(), 2, 240);
    expect(noteAt(p, 2, 240)?.seq).toBe(0);
    expect(noteAt(p, 2, 359)?.seq).toBe(0);
    expect(noteAt(p, 2, 360)).toBeUndefined();
    expect(noteAt(p, 3, 240)).toBeUndefined();
    expect(gateFor(60)).toBe(59);
  });

  it("exports to MIDI with the new notes in place", () => {
    const p = add(add(empty(1), 0, 0), 0, 960);
    const midi = patternToMidi(p, 12000);
    // note-on of pad 1 (A1 = note 48, channel 1) at tick 0 and at 960
    const hex = [...midi].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(hex.startsWith("4d546864")).toBe(true);
    expect((hex.match(/90305a/g) ?? []).length).toBe(2); // 0x90 note 0x30 = 48, velocity 90
  });

  it("round-trips through the parser's note model", () => {
    const base = parsePattern(Uint8Array.from([
      0x00, 0x2f, 0x40, 0, 0x7f, 0x40, 0x28, 0x00,
      0x78, 0x8c, 0, 0, 0, 0, 0, 0,
      1, 0, 0, 0, 0, 0x80, 1, 1,
    ]));
    const q = add(base, 0, 60);
    expect(q.notes.map((n) => n.seq)).toEqual([0, 1]); // the first number past every record seen
  });
});

describe("rows and bars", () => {
  it("fills a row, replacing what was there", () => {
    let p = add(add(empty(1), 0, 60, 10), 1, 0);
    p = fillPad(p, 0, 480);
    expect(ticks(p)).toEqual([0, 480, 960, 1440]);
    expect(p.notes.filter((n) => n.pad === 0).every((n) => n.gate === 119)).toBe(true);
    expect(ticks(fillPad(p, 0, 480, 240))).toEqual([240, 720, 1200, 1680]); // off-beats
    expect(ticks(p, 1)).toEqual([0]); // other rows untouched
    expect(fillPad(empty(1), 0, 60).notes.every((n) => n.gate === 59)).toBe(true); // never longer than the gap
  });

  it("shifts a row round the pattern", () => {
    const p = add(add(empty(1), 0, 0), 0, 1800);
    expect(ticks(shiftPad(p, 0, 120))).toEqual([0, 120]); // 1800 + 120 wraps to 0
    expect(ticks(shiftPad(p, 0, -120))).toEqual([1680, 1800]);
    expect(shiftPad(p, 0, 0)).toBe(p);
    expect(shiftPad(p, 5, 120)).toBe(p);
  });

  it("clears a bar and doubles a pattern", () => {
    let p = add(add(add(empty(2), 0, 0), 0, 960), 0, 2000);
    expect(ticks(clearBar(p, 0))).toEqual([2000]);
    expect(clearBar(p, 3)).toBe(p);
    p = add(add(empty(1), 0, 0), 2, 960);
    const q = doublePattern(p);
    expect([q.bars, q.length]).toEqual([2, 3840]);
    expect([ticks(q), ticks(q, 2)]).toEqual([[0, 1920], [960, 2880]]);
    expect(doublePattern(setBars(p, 16))).toEqual(setBars(p, 16));
  });
});

describe("several notes at once", () => {
  const four = () => add(add(add(add(empty(1), 0, 0), 0, 480), 1, 0), 2, 240);

  it("moves notes together, also to other rows, all or nothing", () => {
    const p = four();
    const q = moveNotes(p, [0, 2], 120);
    expect([ticks(q), ticks(q, 1)]).toEqual([[120, 480], [120]]);
    expect(moveNotes(p, [0, 1], -1)).toBe(p); // the note at 0 would leave the pattern
    expect(moveNotes(p, [1], -240)).not.toBe(p);
    expect(moveNotes(p, [0], 480)).toBe(p); // lands on the note at 480
    const down = moveNotes(p, [0, 1], 0, (pad) => pad + 3);
    expect([ticks(down, 3)]).toEqual([[0, 480]]);
    expect(moveNotes(p, [0], 0, () => null)).toBe(p);
    expect(moveNotes(p, [0], 0)).toBe(p);
  });

  it("removes notes and sets their velocity", () => {
    const p = four();
    expect(removeNotes(p, [0, 3]).notes.map((n) => n.seq)).toEqual([1, 2]);
    expect(removeNotes(p, [99])).toBe(p);
    expect(setVelocities(p, [0, 1], 127).notes.slice(0, 2).map((n) => n.velocity)).toEqual([127, 127]);
    expect(setVelocities(p, [0], (v) => v + 100).notes[0].velocity).toBe(127);
    expect(setVelocities(p, [0], 90)).toBe(p);
  });

  it("copies and pastes, skipping what does not fit", () => {
    const p = setSemitones(four(), 2, 3);
    const clip = copyNotes(p, [1, 2, 3]); // 480 on pad 0, 0 on pad 1 (+3 semitones), 240 on pad 2
    expect(clip.map((c) => [c.dt, c.pad])).toEqual([[0, 1], [240, 2], [480, 0]]);
    const r = pasteNotes(p, clip, 960);
    expect([r.seqs.length, r.skipped]).toEqual([3, 0]);
    expect(ticks(r.pattern, 1)).toEqual([0, 960]);
    expect(r.pattern.notes.find((n) => n.seq === r.seqs[0])?.pitch).toBe(0x80 | 16);
    const late = pasteNotes(p, clip, 1700); // 1700 + 240 and 1700 + 480 are past the end (1920)
    expect([late.seqs.length, late.skipped]).toEqual([1, 2]);
  });

  it("duplicates past the span, in whole beats", () => {
    const p = four();
    expect(duplicateOffset(p, [0, 3])).toBe(480); // 0 and 240
    expect(duplicateOffset(p, [0, 1])).toBe(960); // 0 and 480
    expect(duplicateOffset(p, [])).toBe(0);
  });
});
