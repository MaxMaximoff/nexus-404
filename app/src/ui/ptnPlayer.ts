// Playing a pattern from the browser: its notes go to the SP as MIDI, so the real pads sound with
// their own samples and effects. A scheduler looks a little ahead every 25 ms and hands Web MIDI
// notes with timestamps, so the timing holds even when the page is busy. The pattern is read again
// on every pass, so an edit is heard on the next loop. The playhead is moved by setting a style on
// the grids directly: re-rendering the grid every frame would be wasted work.
// Not played: the transposition of TR-REC notes (MIDI note-on has no pitch for a pad).

import { signal } from "@preact/signals";
import { padName, type Pattern } from "../sp404";
import { connectMidi, midiPort, midiState, scheduleNote, releasePads } from "./midi";
import { draftOf } from "./patternDraft";
import { followTick } from "./PatternPager";
import { demo, log, notice, padSoundMs, pads, patterns, silencePads, tempoFor } from "./store";

const LOOKAHEAD_MS = 100;
const TICK_EVERY_MS = 25;
const START_DELAY_MS = 60;

/** The slot playing, or null. */
export const playingSlot = signal<number | null>(null);

/** Rows silenced while playing, and rows played alone (pads): listening only, nothing of it is saved. */
export const mutedPads = signal<ReadonlySet<number>>(new Set());
export const soloPads = signal<ReadonlySet<number>>(new Set());
export const audible = (pad: number): boolean => (soloPads.value.size ? soloPads.value.has(pad) : !mutedPads.value.has(pad));
const flip = (s: ReadonlySet<number>, pad: number) => { const n = new Set(s); if (!n.delete(pad)) n.add(pad); return n; };
export const toggleMute = (pad: number): void => { mutedPads.value = flip(mutedPads.value, pad); };
export const toggleSolo = (pad: number): void => { soloPads.value = flip(soloPads.value, pad); };
/** Mute and solo belong to the pattern they were set on: another one starts with every row on. */
let soundsOf = -1;

interface State {
  slot: number;
  /** performance.now() at tick 0 of the first loop. */
  t0: number;
  tickMs: number;
  /** Absolute tick (over all loops) up to which notes are scheduled. */
  next: number;
  timer: ReturnType<typeof setInterval>;
  raf: number;
  pads: Set<number>;
  /** When each pad was last hit (performance.now(), up to the lookahead ahead). */
  hits: Map<number, number>;
}
let st: State | null = null;

/** What plays: the draft when there is one, else the pattern as read from the SP. */
function current(slot: number): Pattern | null {
  const d = draftOf(slot)?.p;
  if (d) return d;
  const p = patterns.value?.get(slot);
  return p && typeof p !== "string" ? p : null;
}

/** Milliseconds per tick at the tempo the pattern's bank plays at now. */
const msPerTick = (slot: number): number => 60000 / ((tempoFor(slot >> 4)?.tempoX100 ?? 12000) / 100) / 480;

export function playPattern(slot: number): void {
  stopPattern();
  if (soundsOf !== slot) { mutedPads.value = new Set(); soloPads.value = new Set(); soundsOf = slot; }
  const p = current(slot);
  if (!p || !p.length) return;
  const now = performance.now();
  st = { slot, t0: now + START_DELAY_MS, tickMs: msPerTick(slot), next: 0, timer: setInterval(pump, TICK_EVERY_MS), raf: requestAnimationFrame(frame), pads: new Set(), hits: new Map() };
  playingSlot.value = slot;
  pump();
}

export function stopPattern(): void {
  if (!st) return;
  clearInterval(st.timer);
  cancelAnimationFrame(st.raf);
  releasePads([...st.pads]);
  // Gate off pads play on after note-off: once the notes already handed to MIDI have gone out,
  // stop the ones whose sample would still be sounding.
  const hits = st.hits;
  setTimeout(() => {
    const now = performance.now();
    const on = [...hits].filter(([pad, t]) => pads.value[pad]?.size && !pads.value[pad]!.gate && t + padSoundMs(pad) > now).map(([pad]) => pad);
    void silencePads(on);
  }, LOOKAHEAD_MS + 40);
  st = null;
  playingSlot.value = null;
  document.querySelectorAll<HTMLElement>(".ptn-grid.playing").forEach((g) => g.classList.remove("playing"));
}

/**
 * Play or stop. Playing needs the SP's MIDI port: it is opened here if it is not yet (Chrome may ask
 * for permission the first time); without it nothing would sound, so nothing starts. The demo has no
 * SP: there only the playhead runs.
 */
export async function togglePattern(slot: number): Promise<void> {
  if (playingSlot.value === slot) return stopPattern();
  if (!demo.value && midiState.value !== "ready" && !(await connectMidi())) {
    notice.value = {
      kind: "error",
      text: midiState.value === "denied" ? "MIDI access denied — allow it for this page using the address bar icon, then click ‘Play’ again"
        : midiState.value === "unsupported" ? "This browser does not support MIDI: patterns play through SP over USB MIDI (Chrome or Edge required)"
        : "SP MIDI port not found: patterns play through SP over USB MIDI. Check that SP is connected via USB",
    };
    return;
  }
  playPattern(slot);
  if (playingSlot.value === slot && midiPort.value) log("info", `Playing pattern ${padName(slot)} through ${midiPort.value}`);
}

/** Schedule the notes that fall before now + LOOKAHEAD_MS, looping over the pattern. */
function pump(): void {
  const s = st;
  if (!s) return;
  const p = current(s.slot);
  if (!p || !p.length) { stopPattern(); return; }
  const now = performance.now();
  // The tempo may change while playing (bank or project tempo on the SP): keep the position, change the pace.
  const tickMs = msPerTick(s.slot);
  if (tickMs !== s.tickMs) {
    const pos = Math.max(0, (now - s.t0) / s.tickMs);
    s.t0 = now - pos * tickMs;
    s.tickMs = tickMs;
    s.next = Math.max(s.next, Math.ceil(pos));
  }
  const upTo = (now + LOOKAHEAD_MS - s.t0) / s.tickMs;
  let a = s.next;
  try {
    while (a < upTo) {
      const loop = Math.floor(a / p.length) * p.length, end = Math.min(upTo, loop + p.length);
      for (const n of p.notes) {
        const at = loop + n.tick;
        if (at < a || at >= end || !audible(n.pad)) continue;
        scheduleNote(n.pad, n.velocity, s.t0 + at * s.tickMs, s.t0 + (at + Math.max(1, n.gate)) * s.tickMs);
        s.pads.add(n.pad);
        s.hits.set(n.pad, Math.max(s.hits.get(n.pad) ?? 0, s.t0 + at * s.tickMs));
      }
      a = end;
    }
  } catch (e) {
    log("warn", `Playback ${padName(s.slot)}: ${(e as Error).message}`);
    stopPattern();
    return;
  }
  s.next = Math.max(s.next, upTo);
}

/** The playhead on every grid that shows the playing slot, and its page followed. */
function frame(): void {
  const s = st;
  if (!s) return;
  const p = current(s.slot);
  if (p && p.length) {
    const tick = Math.max(0, (performance.now() - s.t0) / s.tickMs) % p.length;
    followTick(s.slot, p, tick);
    document.querySelectorAll<HTMLElement>(".ptn-grid[data-slot]").forEach((g) => {
      const frac = (tick - Number(g.dataset.from)) / Number(g.dataset.span);
      const on = Number(g.dataset.slot) === s.slot && frac >= 0 && frac < 1;
      g.classList.toggle("playing", on);
      if (on) g.style.setProperty("--ph", frac.toFixed(5));
    });
  }
  s.raf = requestAnimationFrame(frame);
}
