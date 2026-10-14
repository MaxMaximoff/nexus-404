// Editing a parsed pattern: pure functions, each returns a new Pattern (or the same object when the
// edit is refused), so the editor can keep a history by holding the earlier objects. A note is
// identified by its `seq` (its record number in the file); new notes get a larger one, which keeps
// events on the same tick in the order they were made.
// The step is a sixteenth note. New notes look like those TR-REC writes: velocity 90, length one
// tick short of the step, pitch byte 0x8D (the sample's own pitch).

import { PPQ, type Pattern, type PatternNote } from "./pattern";

export const STEP = PPQ / 4;
export const DEFAULT_VELOCITY = 90;
export const DEFAULT_OFF_VELOCITY = 64;
/** Byte 3 of a TR-REC note at the sample's own pitch. */
export const PITCH_ORIGINAL = 0x8d;
/** How far the editor transposes a note, either way. */
export const MAX_SEMITONES = 12;
/** SP-404MKII pattern length: 1–64 bars (Roland reference manual). */
export const MAX_BARS = 64;

/** A note's length for a step of `grid` ticks: one tick short, so it ends before the next step starts. */
export const gateFor = (grid: number): number => Math.max(1, Math.round(grid) - 1);

export const barTicks = (p: Pattern): number => p.beatsPerBar * PPQ;

// Past every record of the file the pattern was read from, so a new note never takes the number of one of them.
const nextSeq = (p: Pattern): number => 1 + Math.max(-1, (p.records ?? 0) - 1, ...p.notes.map((n) => n.seq), ...p.controls.map((c) => c.seq));

/** Two notes on one pad collide when their spans (the end tick included) touch. */
const touches = (a: { tick: number; gate: number }, b: { tick: number; gate: number }): boolean =>
  a.tick <= b.tick + b.gate && b.tick <= a.tick + a.gate;

const clampInt = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, Math.round(v)));

export const findNote = (p: Pattern, seq: number): PatternNote | undefined => p.notes.find((n) => n.seq === seq);

/** The note of `pad` that covers `tick`, if any. */
export const noteAt = (p: Pattern, pad: number, tick: number): PatternNote | undefined =>
  p.notes.find((n) => n.pad === pad && tick >= n.tick && tick <= n.tick + n.gate);

const withNotes = (p: Pattern, notes: PatternNote[]): Pattern => ({ ...p, notes });
const replace = (p: Pattern, seq: number, n: PatternNote): Pattern => withNotes(p, p.notes.map((x) => (x.seq === seq ? n : x)));

/** Add a note. Refused (note null) outside the pattern or on top of another note of the pad. */
export function addNote(p: Pattern, pad: number, tick: number, gate = gateFor(STEP), velocity = DEFAULT_VELOCITY): { pattern: Pattern; note: PatternNote | null } {
  tick = Math.round(tick);
  if (tick < 0 || tick >= p.length) return { pattern: p, note: null };
  const next = p.notes.filter((n) => n.pad === pad && n.tick > tick).reduce((m, n) => Math.min(m, n.tick), p.length + 1);
  const g = Math.min(Math.max(1, Math.round(gate)), p.length - tick, next - tick - 1);
  const note: PatternNote = { tick, seq: nextSeq(p), pad, velocity: clampInt(velocity, 1, 127), offVelocity: DEFAULT_OFF_VELOCITY, gate: g, pitch: PITCH_ORIGINAL };
  if (g < 1 || p.notes.some((n) => n.pad === pad && touches(note, n))) return { pattern: p, note: null };
  return { pattern: withNotes(p, [...p.notes, note]), note };
}

export function removeNote(p: Pattern, seq: number): Pattern {
  return findNote(p, seq) ? withNotes(p, p.notes.filter((n) => n.seq !== seq)) : p;
}

/** Remove every note of a pad. */
export function clearPad(p: Pattern, pad: number): Pattern {
  return p.notes.some((n) => n.pad === pad) ? withNotes(p, p.notes.filter((n) => n.pad !== pad)) : p;
}

/** Move a note in time and/or to another pad, keeping its length when it fits. Refused when it would land on another note. */
export function moveNote(p: Pattern, seq: number, to: { tick?: number; pad?: number }): Pattern {
  const n = findNote(p, seq);
  if (!n) return p;
  const tick = clampInt(to.tick ?? n.tick, 0, p.length - 1), pad = to.pad ?? n.pad;
  const m = { ...n, tick, pad, gate: Math.min(n.gate, p.length - tick) };
  if (p.notes.some((o) => o.seq !== seq && o.pad === pad && touches(m, o))) return p;
  return m.tick === n.tick && m.pad === n.pad && m.gate === n.gate ? p : replace(p, seq, m);
}

/** Change a note's length: at least one tick, at most up to the next note of its pad or the pattern's end. */
export function resizeNote(p: Pattern, seq: number, gate: number): Pattern {
  const n = findNote(p, seq);
  if (!n) return p;
  const next = p.notes.filter((o) => o.pad === n.pad && o.tick > n.tick).reduce((m, o) => Math.min(m, o.tick), p.length + 1);
  const g = clampInt(gate, 1, Math.min(p.length - n.tick, next - n.tick - 1));
  return g === n.gate ? p : replace(p, seq, { ...n, gate: g });
}

export function setVelocity(p: Pattern, seq: number, velocity: number): Pattern {
  const n = findNote(p, seq);
  const v = clampInt(velocity, 1, 127);
  return !n || n.velocity === v ? p : replace(p, seq, { ...n, velocity: v });
}

/** Transposition in semitones as TR-REC writes it: byte 3 = 0x80 | (13 + semitones). Null for a note played live. */
export const semitonesOf = (n: PatternNote): number | null => (n.pitch & 0x80 ? (n.pitch & 0x7f) - 13 : null);

export function setSemitones(p: Pattern, seq: number, semitones: number): Pattern {
  const n = findNote(p, seq);
  if (!n) return p;
  const pitch = 0x80 | (13 + clampInt(semitones, -MAX_SEMITONES, MAX_SEMITONES));
  return n.pitch === pitch ? p : replace(p, seq, { ...n, pitch });
}

/**
 * A roll: replace the note with `parts` notes spread evenly over `span` ticks (a step), the way TR-REC
 * writes a sub-step (2 → 60 ticks apart, 3 → 40, 4 → 30; each one tick shorter than the gap).
 * Returns the new notes' seq too. Refused when they would hit another note or leave the pattern.
 */
export function rollNote(p: Pattern, seq: number, parts: number, span = STEP): { pattern: Pattern; seqs: number[] } {
  const n = findNote(p, seq);
  if (!n || parts < 2) return { pattern: p, seqs: [] };
  const gap = Math.round(span / parts), gate = Math.max(1, gap - 1);
  const rest = p.notes.filter((o) => o.seq !== seq);
  let s = nextSeq(p);
  const made = Array.from({ length: parts }, (_, i): PatternNote => ({ ...n, seq: s++, tick: n.tick + i * gap, gate }));
  const last = made[made.length - 1];
  if (last.tick + last.gate > p.length || made.some((m) => rest.some((o) => o.pad === n.pad && touches(m, o)))) return { pattern: p, seqs: [] };
  return { pattern: withNotes(p, [...rest, ...made]), seqs: made.map((m) => m.seq) };
}

/** Change the length in bars: notes that start past the new end go, the others are cut to fit. */
export function setBars(p: Pattern, bars: number): Pattern {
  bars = clampInt(bars, 1, MAX_BARS);
  const length = bars * barTicks(p);
  if (bars === p.bars && length === p.length) return p;
  return {
    ...p, bars, length,
    notes: p.notes.filter((n) => n.tick < length).map((n) => (n.tick + n.gate > length ? { ...n, gate: length - n.tick } : n)),
    controls: p.controls.filter((c) => c.tick < length),
  };
}

/** Copy the notes of bar `from` (0-based) over bar `to`, replacing what was there. */
export function copyBar(p: Pattern, from: number, to: number): Pattern {
  const bt = barTicks(p), bars = Math.ceil(p.length / bt);
  if (from === to || from < 0 || to < 0 || from >= bars || to >= bars) return p;
  const inBar = (n: PatternNote, b: number) => n.tick >= b * bt && n.tick < (b + 1) * bt;
  let s = nextSeq(p);
  const copies = p.notes.filter((n) => inBar(n, from)).map((n): PatternNote => {
    const tick = n.tick + (to - from) * bt;
    return { ...n, seq: s++, tick, gate: Math.min(n.gate, p.length - tick) };
  });
  return withNotes(p, [...p.notes.filter((n) => !inBar(n, to)), ...copies]);
}

// ------------------------------------------------------------------ rows and bars

/** Replace the notes of `pad` with one every `every` ticks from `offset`, each one step long (`gate`) at most. */
export function fillPad(p: Pattern, pad: number, every: number, offset = 0, gate = gateFor(STEP), velocity = DEFAULT_VELOCITY): Pattern {
  every = Math.max(1, Math.round(every));
  let q = clearPad(p, pad);
  for (let t = Math.max(0, Math.round(offset)); t < q.length; t += every) q = addNote(q, pad, t, Math.min(gate, every - 1 || 1), velocity).pattern;
  return q;
}

/** Move every note of `pad` by `ticks`, round the pattern: what leaves at the end comes back at the start. */
export function shiftPad(p: Pattern, pad: number, ticks: number): Pattern {
  ticks = Math.round(ticks);
  const mine = p.notes.filter((n) => n.pad === pad);
  if (!ticks || !mine.length || p.length <= 0) return p;
  const moved = mine.map((n) => {
    const tick = (((n.tick + ticks) % p.length) + p.length) % p.length;
    return { ...n, tick, gate: Math.max(1, Math.min(n.gate, p.length - tick)) };
  });
  return withNotes(p, [...p.notes.filter((n) => n.pad !== pad), ...moved]);
}

/** Remove the notes that start in bar `bar` (0-based). */
export function clearBar(p: Pattern, bar: number): Pattern {
  const bt = barTicks(p), from = bar * bt, to = from + bt;
  return p.notes.some((n) => n.tick >= from && n.tick < to) ? withNotes(p, p.notes.filter((n) => n.tick < from || n.tick >= to)) : p;
}

/** Twice as long, the new half a copy of the old. Refused past MAX_BARS. */
export function doublePattern(p: Pattern): Pattern {
  const bars = Math.ceil(p.length / barTicks(p));
  if (bars * 2 > MAX_BARS || p.length !== bars * barTicks(p)) return p;
  let q = setBars(p, bars * 2);
  for (let b = 0; b < bars; b++) q = copyBar(q, b, b + bars);
  return q;
}

// ------------------------------------------------------------------ several notes at once

/**
 * Move notes together by `dt` ticks, and to other pads through `mapPad` (the editor passes a shift
 * by rows). All or nothing: refused when one would leave the pattern, have no pad, or land on a
 * note that does not move.
 */
export function moveNotes(p: Pattern, seqs: number[], dt: number, mapPad: (pad: number) => number | null = (x) => x): Pattern {
  const set = new Set(seqs), moving = p.notes.filter((n) => set.has(n.seq));
  dt = Math.round(dt);
  if (!moving.length) return p;
  const moved: PatternNote[] = [];
  for (const n of moving) {
    const tick = n.tick + dt, pad = mapPad(n.pad);
    if (tick < 0 || tick >= p.length || pad === null) return p;
    moved.push({ ...n, tick, pad, gate: Math.min(n.gate, p.length - tick) });
  }
  const rest = p.notes.filter((n) => !set.has(n.seq));
  if (moved.some((m) => rest.some((o) => o.pad === m.pad && touches(m, o)))) return p;
  if (moved.every((m, i) => m.tick === moving[i].tick && m.pad === moving[i].pad)) return p;
  return withNotes(p, [...rest, ...moved]);
}

export function removeNotes(p: Pattern, seqs: number[]): Pattern {
  const set = new Set(seqs);
  return p.notes.some((n) => set.has(n.seq)) ? withNotes(p, p.notes.filter((n) => !set.has(n.seq))) : p;
}

/** Set the velocity of several notes, or change it with a function of the old one. */
export function setVelocities(p: Pattern, seqs: number[], v: number | ((old: number) => number)): Pattern {
  const set = new Set(seqs);
  let changed = false;
  const notes = p.notes.map((n) => {
    if (!set.has(n.seq)) return n;
    const nv = clampInt(typeof v === "number" ? v : v(n.velocity), 1, 127);
    if (nv === n.velocity) return n;
    changed = true;
    return { ...n, velocity: nv };
  });
  return changed ? withNotes(p, notes) : p;
}

/** Notes copied: times from the first one, everything else as it was. */
export type Clip = { dt: number; pad: number; gate: number; velocity: number; offVelocity: number; pitch: number }[];

export function copyNotes(p: Pattern, seqs: number[]): Clip {
  const set = new Set(seqs), mine = p.notes.filter((n) => set.has(n.seq)).sort((a, b) => a.tick - b.tick || a.pad - b.pad);
  const t0 = mine[0]?.tick ?? 0;
  return mine.map((n) => ({ dt: n.tick - t0, pad: n.pad, gate: n.gate, velocity: n.velocity, offVelocity: n.offVelocity, pitch: n.pitch }));
}

/** Paste a clip with its first note at `at`. Notes that would leave the pattern or land on a note are skipped. */
export function pasteNotes(p: Pattern, clip: Clip, at: number): { pattern: Pattern; seqs: number[]; skipped: number } {
  let q = p;
  const seqs: number[] = [];
  for (const c of clip) {
    const r = addNote(q, c.pad, at + c.dt, c.gate, c.velocity);
    if (!r.note) continue;
    // addNote makes a TR-REC-like note: give it back the copied pitch and release velocity.
    q = replace(r.pattern, r.note.seq, { ...r.note, pitch: c.pitch, offVelocity: c.offVelocity });
    seqs.push(r.note.seq);
  }
  return { pattern: q, seqs, skipped: clip.length - seqs.length };
}

/** How far "duplicate" puts a copy of the notes: past their span, rounded up to whole beats. */
export function duplicateOffset(p: Pattern, seqs: number[]): number {
  const set = new Set(seqs), mine = p.notes.filter((n) => set.has(n.seq));
  if (!mine.length) return 0;
  const lo = Math.min(...mine.map((n) => n.tick)), hi = Math.max(...mine.map((n) => n.tick));
  return Math.ceil((hi - lo + 1) / PPQ) * PPQ;
}
