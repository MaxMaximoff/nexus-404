// Patterns: PTN/PTNnnnnn.BIN of a project, and their export as a MIDI file (SparkyMK2 spec
// docs/re/04-patterns.md). Checked against the user's project 4: patterns of 1 and 4 bars,
// velocities 25–127 (the spec saw only 127), pitched notes (byte 3 = 0x8D / 0x8F), and the
// length in bars in trailer bytes 0 and 6 (the spec: byte 6 always 4).

import { PAD_COUNT } from "./control";

/** Ticks per quarter note. */
export const PPQ = 480;
const REC = 8;
const NOTE_FIRST = 0x2f; // A1 (F1 with group 1)
const NOTES_PER_GROUP = 80; // banks A–E, F–J
const END = 0x8c;
const CONTROL = 0x8e;
/** Time signature code in the trailer → beats per bar (quarters); 7 and above read as 4/4. */
const BEATS = [4, 1, 2, 3, 5, 6, 7];

const projectDir = (project1: number) => `ROLAND/SP-404MKII/PROJECT_${String(project1).padStart(2, "0")}`;
/** Folder of a project's patterns (project 1-based). */
export const patternDir = (project1: number): string => `${projectDir(project1)}/PTN`;
/** File of pattern slot `slot` (0..159, A1 = 0): `PTN00001.BIN` … `PTN00160.BIN`. */
export const patternPath = (project1: number, slot: number): string => `${patternDir(project1)}/${patternFileName(slot)}`;
export const patternFileName = (slot: number): string => `PTN${String(slot + 1).padStart(5, "0")}.BIN`;
/** Slot of a file name in PTN/, or null for anything else (the chain file, temporary files). */
export function slotOfFileName(name: string): number | null {
  const m = /^PTN(\d{5})\.BIN$/i.exec(name);
  const slot = m ? +m[1] - 1 : -1;
  return slot >= 0 && slot < PAD_COUNT ? slot : null;
}

export interface PatternNote {
  tick: number;
  /** Record number in the file: events on one tick keep this order. */
  seq: number;
  /** Pad index 0..159 (A1 = 0). */
  pad: number;
  velocity: number;
  offVelocity: number;
  /** Length in ticks. */
  gate: number;
  /**
   * Byte 3: 0 for a note played live; TR-REC writes 0x80 | (13 + semitones), so 0x8D is the
   * sample's own pitch (checked on the SP: +1 semitone on a step gave 0x8E).
   */
  pitch: number;
}

export interface PatternControl { tick: number; seq: number; channel: number; controller: number; value: number }

export interface Pattern {
  notes: PatternNote[];
  controls: PatternControl[];
  /** Length in ticks: from the start to the end record. */
  length: number;
  /** Length in bars as the trailer states it. */
  bars: number;
  /** Quarters per bar (time signature n/4). */
  beatsPerBar: number;
  /** Records of a kind not known yet (left out of notes and controls). */
  unknown: number;
  /** Records in the file before the end record: every note's `seq` is below it, so new notes number from here. */
  records?: number;
}

export class PatternError extends Error {}

export function parsePattern(bytes: Uint8Array): Pattern {
  if (bytes.length < 2 * REC || bytes.length % REC) throw new PatternError(`файл паттерна ${bytes.length} байт — не кратно 8`);
  const notes: PatternNote[] = [], controls: PatternControl[] = [];
  let tick = 0, unknown = 0, end = -1;
  for (let at = 0; at + REC <= bytes.length; at += REC) {
    const r = bytes.subarray(at, at + REC), type = r[1];
    if (type === END) { tick += r[0]; end = at; break; }
    if (type >= NOTE_FIRST && type < NOTE_FIRST + NOTES_PER_GROUP && (r[2] & 0x0f) < 2) {
      const pad = (r[2] & 0x0f) * NOTES_PER_GROUP + type - NOTE_FIRST;
      notes.push({ tick, seq: at / REC, pad, velocity: r[4] & 0x7f, offVelocity: r[5] & 0x7f, gate: r[6] | (r[7] << 8), pitch: r[3] });
    } else if (type === CONTROL) controls.push({ tick, seq: at / REC, channel: r[2] & 0x0f, controller: r[5] & 0x7f, value: r[6] & 0x7f });
    else if (type < 0x80) unknown++; // ≥ 0x80: only advances time
    tick += r[0];
  }
  if (end < 0 || end + 2 * REC > bytes.length) throw new PatternError("в файле паттерна нет конца");
  const trailer = bytes.subarray(end + REC, end + 2 * REC);
  const beatsPerBar = BEATS[trailer[4]] ?? 4;
  return { notes, controls, length: tick, bars: trailer[0] || Math.round(tick / (beatsPerBar * PPQ)), beatsPerBar, unknown, records: end / REC };
}

/** Transposition of a note in semitones, or null when it carries no pitch (played live). */
export const noteSemitones = (n: PatternNote): number | null => (n.pitch & 0x80 ? (n.pitch & 0x7f) - 13 : null);

/** Pads a pattern plays, in pad order. */
export const patternPads = (p: Pattern): number[] => [...new Set(p.notes.map((n) => n.pad))].sort((a, b) => a - b);

/** MIDI note of a pad as the SP exports it: pad 13 (bottom left) = 36, pad 1 = 48; channel = bank. */
export const PAD_NOTE_OFFSET = [12, 13, 14, 15, 8, 9, 10, 11, 4, 5, 6, 7, 0, 1, 2, 3];
export const padMidiNote = (pad: number): number => 36 + PAD_NOTE_OFFSET[pad & 15];

/** `EXPORT PATTERN` name the official app gives: `Proj4_PTN_BANK_A-01.MID`. */
export const patternMidiName = (project1: number, slot: number): string =>
  `Proj${project1}_PTN_BANK_${"ABCDEFGHIJ"[slot >> 4]}-${String((slot & 15) + 1).padStart(2, "0")}.MID`;

/**
 * Standard MIDI File of a pattern, as the official app exports it: format 0, 480 ticks per quarter,
 * the tempo of the pattern's bank (`bankTempoX100`), the time signature at the first tick past 0
 * and again at the end, aftertouch around pitched notes, running status within a channel.
 */
export function patternToMidi(p: Pattern, bankTempoX100: number): Uint8Array<ArrayBuffer> {
  const events: { tick: number; bytes: number[] }[] = [];
  const add = (tick: number, ...bytes: number[]) => events.push({ tick, bytes });
  const usPerQuarter = Math.min(0xffffff, Math.floor(6_000_000_000 / Math.max(1, bankTempoX100)));
  add(0, 0xff, 0x51, 0x03, usPerQuarter >> 16, (usPerQuarter >> 8) & 0xff, usPerQuarter & 0xff);
  const timeSig = [0xff, 0x58, 0x04, p.beatsPerBar, 0x02, 0x01, 0x60];
  let sigPlaced = false;
  const inFile = [...p.notes.map((n) => ({ n, tick: n.tick, seq: n.seq })), ...p.controls.map((c) => ({ c, tick: c.tick, seq: c.seq }))].sort((a, b) => a.seq - b.seq);
  for (const e of inFile) {
    if (!sigPlaced && e.tick > 0) { add(0, ...timeSig); sigPlaced = true; }
    if ("n" in e) {
      const { n } = e, ch = Math.min(15, n.pad >> 4), note = padMidiNote(n.pad), off = n.tick + n.gate;
      const at = n.pitch ? [0xa0 | ch, note, ((n.pitch & 0x80 ? 64 : 0) + (n.pitch & 0x7f)) & 0x7f] : null;
      if (at) add(n.tick, ...at);
      add(n.tick, 0x90 | ch, note, n.velocity);
      if (at) add(off, ...at);
      add(off, 0x80 | ch, note, n.offVelocity);
    } else add(e.c.tick, 0xb0 | e.c.channel, e.c.controller, e.c.value);
  }
  if (!sigPlaced) add(0, ...timeSig);
  add(p.length, ...timeSig);
  events.sort((a, b) => a.tick - b.tick); // stable: same-tick events keep their order

  const track: number[] = [];
  let now = 0, status = -1;
  for (const { tick, bytes } of events) {
    varLen(track, tick - now);
    track.push(...(bytes[0] < 0xf0 && bytes[0] === status ? bytes.slice(1) : bytes));
    status = bytes[0];
    now = tick;
  }
  varLen(track, Math.max(now, p.length) - now);
  track.push(0xff, 0x2f, 0x00);

  const out = new Uint8Array(22 + track.length);
  const dv = new DataView(out.buffer);
  out.set([0x4d, 0x54, 0x68, 0x64], 0); // MThd
  dv.setUint32(4, 6);
  dv.setUint16(8, 0);
  dv.setUint16(10, 1);
  dv.setUint16(12, PPQ);
  out.set([0x4d, 0x54, 0x72, 0x6b], 14); // MTrk
  dv.setUint32(18, track.length);
  out.set(track, 22);
  return out;
}

function varLen(out: number[], v: number): void {
  const bytes = [v & 0x7f];
  for (v >>>= 7; v > 0; v >>>= 7) bytes.unshift(0x80 | (v & 0x7f));
  out.push(...bytes);
}

// ------------------------------------------------------------------ writing a pattern file

const isNoteRecord = (r: Uint8Array): boolean => r[1] >= NOTE_FIRST && r[1] < NOTE_FIRST + NOTES_PER_GROUP && (r[2] & 0x0f) < 2;
/** A time-only record: the SP pads gaps longer than 255 ticks with `FF 80 00 00 00 00 00 00`. */
const filler = (delta: number): Uint8Array => Uint8Array.of(delta, 0x80, 0, 0, 0, 0, 0, 0);
const MAX_DELTA = 0xff;

interface FileParts { recs: { tick: number; seq: number; r: Uint8Array }[]; endTick: number; end: Uint8Array; trailer: Uint8Array; tail: Uint8Array; length: number }

/** The records of a file with the tick each one sits on, its end record, trailer and anything after it. */
function splitPattern(bytes: Uint8Array): FileParts {
  const recs: FileParts["recs"] = [];
  let tick = 0;
  for (let at = 0; at + REC <= bytes.length; at += REC) {
    const r = bytes.slice(at, at + REC);
    if (r[1] === END && at + 2 * REC <= bytes.length)
      return { recs, endTick: tick, end: r, trailer: bytes.slice(at + REC, at + 2 * REC), tail: bytes.slice(at + 2 * REC), length: tick + r[0] };
    recs.push({ tick, seq: at / REC, r });
    tick += r[0];
  }
  throw new PatternError("в файле паттерна нет конца");
}

/** A note's record (byte 0, the delta, is set later). Over `base` it keeps that record's flag bits in byte 2. */
function noteRecord(n: PatternNote, base?: Uint8Array): Uint8Array {
  const r = base ? base.slice() : new Uint8Array(REC);
  const gate = Math.max(0, Math.min(0xffff, Math.round(n.gate)));
  r[1] = NOTE_FIRST + (n.pad % NOTES_PER_GROUP);
  r[2] = (base ? base[2] & 0xf0 : 0) | (n.pad >= NOTES_PER_GROUP ? 1 : 0);
  r[3] = n.pitch & 0xff;
  r[4] = n.velocity & 0x7f;
  r[5] = n.offVelocity & 0x7f;
  r[6] = gate & 0xff;
  r[7] = gate >> 8;
  return r;
}

/**
 * The file for pattern `p`. Given the file it was read from (`original`), every record that is not a
 * note stays on its tick — fillers, control changes, the records the SP leaves behind, unknown
 * ones — and so do the notes that did not move (with their flag bits); moved and new notes go
 * after the records already on their tick. So an unedited pattern comes out byte for byte, and an
 * edit changes only what was edited. Gaps over 255 ticks get `FF 80` fillers. The trailer stays,
 * with the length in bars (bytes 0 and 6) changed only when the bars changed.
 * Without an original (a diagnostic of how we lay a file out), notes and control changes are
 * written in tick order with `trailer` (or the one SP files have) and no extra records.
 */
export function writePattern(p: Pattern, original?: Uint8Array | null, trailer?: Uint8Array): Uint8Array {
  const parts = original ? splitPattern(original) : null;
  const bySeq = new Map(p.notes.map((n) => [n.seq, n]));
  const out: { tick: number; r: Uint8Array }[] = [];
  const placed = new Set<number>(), bases = new Map<number, Uint8Array>();
  if (parts) {
    for (const { tick, seq, r } of parts.recs) {
      if (isNoteRecord(r)) {
        bases.set(seq, r);
        const n = bySeq.get(seq);
        if (n && n.tick === tick) { out.push({ tick, r: noteRecord(n, r) }); placed.add(seq); }
      } else if (tick < p.length) out.push({ tick, r: r.slice() });
    }
  } else {
    for (const c of p.controls) if (c.tick < p.length) out.push({ tick: c.tick, r: Uint8Array.of(0, CONTROL, c.channel & 0x0f, 0, 0, c.controller & 0x7f, c.value & 0x7f, 0) });
    out.sort((a, b) => a.tick - b.tick);
  }
  for (const n of p.notes.filter((x) => !placed.has(x.seq)).sort((a, b) => a.tick - b.tick || a.seq - b.seq)) {
    if (n.tick < 0 || n.tick >= p.length) throw new PatternError(`нота ${n.pad} на тике ${n.tick} вне паттерна (${p.length})`);
    let i = out.length;
    while (i > 0 && out[i - 1].tick > n.tick) i--;
    out.splice(i, 0, { tick: n.tick, r: noteRecord(n, bases.get(n.seq)) });
  }

  // The end record: where it was when the length did not change, else as far before the new end as it was before the old one.
  const lastTick = out.length ? out[out.length - 1].tick : 0;
  const endDelta = parts ? parts.end[0] : 0;
  const end = parts ? parts.end.slice() : Uint8Array.of(0, END, 0, 0, 0, 0, 0, 0);
  const endTick = Math.max(lastTick, parts && parts.length === p.length ? parts.endTick : p.length - Math.min(endDelta, p.length));
  end[0] = p.length - endTick;

  const recs: Uint8Array[] = [];
  const all = [...out, { tick: endTick, r: end }];
  for (let lead = all[0].tick; lead > 0; lead -= Math.min(MAX_DELTA, lead)) recs.push(filler(Math.min(MAX_DELTA, lead)));
  for (let i = 0; i < all.length - 1; i++) {
    const gap = all[i + 1].tick - all[i].tick, k = gap > MAX_DELTA ? Math.ceil(gap / MAX_DELTA) - 1 : 0;
    all[i].r[0] = gap - MAX_DELTA * k;
    recs.push(all[i].r);
    for (let j = 0; j < k; j++) recs.push(filler(MAX_DELTA));
  }
  recs.push(end);

  const t = parts ? parts.trailer.slice() : trailer ? trailer.slice() : Uint8Array.of(p.bars, 0, 0, 0, Math.max(0, BEATS.indexOf(p.beatsPerBar)), 0x80, p.bars, 1);
  if (parts) {
    const was = parts.trailer[0] || Math.round(parts.length / ((BEATS[parts.trailer[4]] ?? 4) * PPQ));
    if (p.bars !== was) {
      if (parts.trailer[6] === parts.trailer[0]) t[6] = p.bars;
      t[0] = p.bars;
    }
  }
  const file = new Uint8Array((recs.length + 1) * REC + (parts?.tail.length ?? 0));
  recs.forEach((r, i) => file.set(r, i * REC));
  file.set(t, recs.length * REC);
  if (parts) file.set(parts.tail, (recs.length + 1) * REC);
  return file;
}

/**
 * How our writer lays out a pattern from scratch next to the SP's own file: the first record that
 * differs, if any. It tells whether files we make for new patterns look like the SP's.
 */
export function rebuildDiff(bytes: Uint8Array): { same: boolean; record: number; sp: string; ours: string } {
  const p = parsePattern(bytes), ours = writePattern(p, null, splitPattern(bytes).trailer);
  const n = Math.max(bytes.length, ours.length) / REC;
  for (let i = 0; i < n; i++) {
    const a = bytes.subarray(i * REC, i * REC + REC), b = ours.subarray(i * REC, i * REC + REC);
    if (a.length !== b.length || a.some((x, j) => x !== b[j])) return { same: false, record: i, sp: hexRec(a), ours: hexRec(b) };
  }
  return { same: true, record: -1, sp: "", ours: "" };
}

const hexRec = (r: Uint8Array): string => (r.length ? [...r].map((b) => b.toString(16).padStart(2, "0")).join(" ") : "—");
