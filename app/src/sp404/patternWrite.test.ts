import { describe, expect, it } from "vitest";
import { parsePattern, rebuildDiff, writePattern, type Pattern } from "./pattern";
import { addNote, moveNote, removeNote, setBars, setVelocity } from "./patternEdit";

const file = (...recs: number[][]) => Uint8Array.from(recs.flat());
const trailer = (bars: number, sig = 0) => [bars, 0, 0, 0, sig, 0x80, bars, 1];
/** Notes as the parser sees them, without their record numbers. */
const notes = (p: Pattern) => p.notes.map((n) => [n.tick, n.pad, n.velocity, n.offVelocity, n.gate, n.pitch]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
const deltas = (bytes: Uint8Array) => Array.from({ length: bytes.length / 8 }, (_, i) => bytes[i * 8]);

/**
 * A 1-bar file laid out like the SP's: a live note with the 0x40 flag, a TR-REC note, a gap over
 * 255 ticks with a filler, the once-per-file `…FF` record, an erased event (type 0x80 with note
 * data), a control change, and an end record that is not on the last event.
 */
const SP_LIKE = file(
  [0x78, 0x2f, 0x40, 0x00, 0x64, 0x40, 0x3b, 0x00], // A1 at 0, live, flag 0x40, gate 59; byte 0 = 120 ticks to the next record
  [0x00, 0x31, 0x00, 0x8d, 0x5a, 0x40, 0x77, 0x00], // A3 at 120, TR-REC
  [0x00, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff], // the …FF record at 120
  [0xff, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00], // filler: 120 → 375
  [0x2d, 0x80, 0x00, 0x8d, 0x7f, 0x40, 0x77, 0x00], // erased event at 375, delta 45
  [0x00, 0x8e, 0x02, 0x00, 0x00, 0x07, 0x64, 0x00], // CC 7 = 100 at 420
  [0xf0, 0x30, 0x01, 0x8d, 0x5a, 0x40, 0x77, 0x00], // F2 at 420, delta 240
  [0xff, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00], // filler: 660 → 915
  [0xff, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00], // 915 → 1170
  [0xff, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00], // 1170 → 1425
  [0xff, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00], // 1425 → 1680
  [0xf0, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00], // 1680 → 1920
  [0x00, 0x8c, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00], // end at 1920
  trailer(1),
);

describe("writing a pattern file", () => {
  it("writes an unedited pattern back byte for byte", () => {
    const p = parsePattern(SP_LIKE);
    expect(notes(p)).toEqual([[0, 0, 100, 64, 59, 0], [120, 2, 90, 64, 119, 0x8d], [420, 81, 90, 64, 119, 0x8d]]);
    expect(writePattern(p, SP_LIKE)).toEqual(SP_LIKE);
  });

  it("keeps an unknown tail after the trailer", () => {
    const withTail = Uint8Array.from([...SP_LIKE, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(writePattern(parsePattern(withTail), withTail)).toEqual(withTail);
  });

  it("removes a note and keeps every other record", () => {
    const p = parsePattern(SP_LIKE), q = removeNote(p, 1); // A3
    const out = writePattern(q, SP_LIKE), back = parsePattern(out);
    expect(notes(back)).toEqual(notes(q));
    expect(out.length).toBe(SP_LIKE.length - 8);
    expect(back.controls).toEqual([{ ...p.controls[0], seq: 4 }]);
    expect(back.length).toBe(1920);
  });

  it("changes a note in place and keeps its flag bits", () => {
    const p = parsePattern(SP_LIKE), q = setVelocity(p, 0, 127);
    const out = writePattern(q, SP_LIKE);
    expect([...out.subarray(0, 8)]).toEqual([0x78, 0x2f, 0x40, 0x00, 0x7f, 0x40, 0x3b, 0x00]);
    expect([...out.subarray(8)]).toEqual([...SP_LIKE.subarray(8)]);
  });

  it("adds notes, with fillers for gaps over 255 ticks", () => {
    let p = parsePattern(SP_LIKE);
    p = addNote(p, 5, 1800).pattern; // A6 near the end
    p = addNote(p, 2, 0).pattern; // A3 at 0: fits before its note at 120
    expect(p.notes).toHaveLength(5);
    const out = writePattern(p, SP_LIKE), back = parsePattern(out);
    expect(notes(back)).toEqual(notes(p));
    expect(deltas(out).every((d) => d <= 255)).toBe(true);
    expect(back.length).toBe(1920);
    expect(out.length % 8).toBe(0);
    expect([...out.subarray(out.length - 8)]).toEqual(trailer(1));
  });

  it("moves a note to another tick and to banks F–J", () => {
    const p = parsePattern(SP_LIKE);
    const q = moveNote(moveNote(p, 0, { tick: 960 }), 6, { pad: 4 }); // A1 → 960; F2 → A5 at 420
    const out = writePattern(q, SP_LIKE), back = parsePattern(out);
    expect(notes(back)).toEqual(notes(q));
    const f = moveNote(p, 0, { pad: 159 }); // A1 → J16
    expect(notes(parsePattern(writePattern(f, SP_LIKE)))).toEqual(notes(f));
  });

  it("shortens and lengthens, updating the bars in the trailer", () => {
    const two = file([0x00, 0x2f, 0, 0x8d, 90, 64, 119, 0], [0xff, 0x80, 0, 0, 0, 0, 0, 0], ...Array.from({ length: 14 }, () => [0xff, 0x80, 0, 0, 0, 0, 0, 0]), [0x0f, 0x80, 0, 0, 0, 0, 0, 0], [0, 0x8c, 0, 0, 0, 0, 0, 0], trailer(2));
    const p = parsePattern(two);
    expect([p.length, p.bars]).toEqual([3840, 2]);
    expect(writePattern(p, two)).toEqual(two);
    const one = parsePattern(writePattern(setBars(p, 1), two));
    expect([one.length, one.bars]).toEqual([1920, 1]);
    const four = writePattern(setBars(p, 4), two), back = parsePattern(four);
    expect([back.length, back.bars, notes(back)]).toEqual([7680, 4, notes(p)]);
    expect([...four.subarray(four.length - 8)]).toEqual(trailer(4));
    expect(deltas(four).every((d) => d <= 255)).toBe(true);
  });

  it("starts with fillers when the first event is late", () => {
    const p = removeNote(removeNote(parsePattern(SP_LIKE), 0), 1);
    const q = removeNote(p, 6);
    const empty = { ...q, controls: [] };
    const late = addNote(empty, 0, 600).pattern;
    const out = writePattern(late, null), back = parsePattern(out);
    expect(notes(back)).toEqual(notes(late));
    expect(back.length).toBe(1920);
  });

  it("writes a pattern from scratch and says where it differs from the SP's layout", () => {
    const d = rebuildDiff(SP_LIKE);
    expect(d.same).toBe(false); // the scratch layout has no …FF record, no erased event and no flag
    expect(d.record).toBe(0);
    const plain = file([0x00, 0x2f, 0, 0x8d, 90, 64, 119, 0], [0xff, 0x80, 0, 0, 0, 0, 0, 0], [0xff, 0x80, 0, 0, 0, 0, 0, 0], [0xff, 0x80, 0, 0, 0, 0, 0, 0], [0xff, 0x80, 0, 0, 0, 0, 0, 0], [0xff, 0x80, 0, 0, 0, 0, 0, 0], [0xff, 0x80, 0, 0, 0, 0, 0, 0], [0xff, 0x80, 0, 0, 0, 0, 0, 0], [0x87, 0x80, 0, 0, 0, 0, 0, 0], [0, 0x8c, 0, 0, 0, 0, 0, 0], trailer(1));
    expect(parsePattern(plain).length).toBe(1920);
    expect(rebuildDiff(plain)).toMatchObject({ same: false }); // our layout puts the remainder first, the SP-like one last: the check shows it
  });

  it("numbers new notes past every record of the file", () => {
    const p = parsePattern(SP_LIKE);
    expect(p.records).toBe(12);
    expect(addNote(p, 9, 960).note?.seq).toBe(12);
  });
});
