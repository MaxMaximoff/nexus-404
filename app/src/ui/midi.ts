// The SP-404MKII is also a USB MIDI device: a note hits a pad as a hand does (velocity, PAD Link,
// several pads at once), which the remote preview (8E) cannot: it plays one pad at a time
// (checked on the unit). Note map as the SP's MIDI export of patterns uses it (SparkyMK2 spec
// 04-patterns.md): channel = bank (A = 1 … J = 10), note = 36 + the pad's place in the 4 × 4 grid
// from the bottom row up (pad 13 = 36, pad 1 = 48). That is Roland's MIDI mode "A" (notes 35–51,
// one channel per bank; checked on the unit); mode "B" maps notes 12–91 differently.

import { signal } from "@preact/signals";
import { log } from "./store";

export const midiState = signal<"off" | "asking" | "ready" | "nodevice" | "denied" | "unsupported">("off");
export const midiPort = signal<string | null>(null);

const GRID = [12, 13, 14, 15, 8, 9, 10, 11, 4, 5, 6, 7, 0, 1, 2, 3];
/** MIDI channel (0-based) and note of a pad 0..159. */
export const padNote = (pad: number) => ({ ch: pad >> 4, note: 36 + GRID[pad & 15] });

let out: MIDIOutput | null = null;

/** Find the SP's MIDI output (Chrome asks for permission the first time). */
export async function connectMidi(): Promise<boolean> {
  if (out && midiState.value === "ready") return true;
  if (!("requestMIDIAccess" in navigator)) { midiState.value = "unsupported"; return false; }
  midiState.value = "asking";
  try {
    const access = await navigator.requestMIDIAccess();
    const pick = () => [...access.outputs.values()].find((o) => /SP-?404/i.test(o.name ?? "")) ?? null;
    out = pick();
    access.onstatechange = () => {
      out = pick();
      midiState.value = out ? "ready" : "nodevice";
      midiPort.value = out?.name ?? null;
    };
    midiState.value = out ? "ready" : "nodevice";
    midiPort.value = out?.name ?? null;
    if (out) log("info", `MIDI: ${out.name}`);
    return !!out;
  } catch {
    midiState.value = "denied";
    return false;
  }
}

/** Hit pads like hands: all note-ons in one go (the same timestamp), velocity 1–127. */
export function hitPads(pads: number[], velocity = 127): void {
  if (!out) throw new Error("MIDI-порт SP не подключён");
  const t = performance.now();
  for (const pad of pads) { const { ch, note } = padNote(pad); out.send([0x90 | ch, note, velocity], t); }
}

export function releasePads(pads: number[]): void {
  if (!out) return;
  const t = performance.now();
  for (const pad of pads) { const { ch, note } = padNote(pad); out.send([0x80 | ch, note, 0], t); }
}

/** Play a pad once for a moment, as a tap: the editor's way to hear a step. Silent when the SP is not connected. */
export function auditionPad(pad: number, velocity = 100): void {
  if (!out) return;
  const { ch, note } = padNote(pad), t = performance.now();
  out.send([0x90 | ch, note, Math.max(1, Math.min(127, velocity))], t);
  out.send([0x80 | ch, note, 0], t + 120);
}

/** A note at `at` and its release at `off` (performance.now() times; the past means now). Silent when the SP is not connected. */
export function scheduleNote(pad: number, velocity: number, at: number, off: number): void {
  if (!out) return;
  const { ch, note } = padNote(pad);
  out.send([0x90 | ch, note, Math.max(1, Math.min(127, velocity))], at);
  out.send([0x80 | ch, note, 0], Math.max(at + 1, off));
}

