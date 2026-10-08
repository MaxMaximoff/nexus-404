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
  return { notes, controls, length: tick, bars: trailer[0] || Math.round(tick / (beatsPerBar * PPQ)), beatsPerBar, unknown };
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
