// Resample through the SP's own effects: the app hits a pad with a MIDI note while it records the
// SP's output on an input of the computer (the SP's USB line, or its outputs into an audio
// interface), lets the effect's tail ring out, normalizes in float, and offers the take for a pad.
// By MIDI the SP plays a PAD Link group as layers. A group of picked pads goes through the same
// effect one after another and lands on empty pads in one import.
// The effect is set on the SP beforehand; whatever else the SP plays meanwhile is recorded too.

import { signal } from "@preact/signals";
import { BPM_MAX_X100, BPM_MIN_X100, byteToFrame, encodeWav, floatBlocksToPcm, padName, padSpeed, trimAndNormalize } from "../sp404";
import { capture, ensureArmed, recError, setTake } from "./rec";
import { connectMidi, hitPads, midiState, releasePads } from "./midi";
import { channelsOf, groupProgress, importFiles, log, notice, pads, pickedList, playing, project1, tempoFor, withDevice, writeBlockReason } from "./store";

export const rsTail = signal(2); // seconds after the release, for reverb / delay tails
export const rsNormalize = signal(true);
/** What a resample is doing now, for the button; null when idle. */
export const rsBusy = signal<string | null>(null);
/** Set by "Стоп" during a group resample: it ends after the pad being recorded. */
export const rsCancel = signal(false);

const MAX_PLAY = 600;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The pads that sound together with `pad` on the SP (same PAD Link group), itself first. */
export function linkedPads(pad: number): number[] {
  const link = pads.value[pad]?.padLink ?? 0;
  if (!link) return [pad];
  return [pad, ...pads.value.flatMap((b, i) => (i !== pad && b?.size && b.padLink === link ? [i] : []))];
}

/** How long a pad sounds from Start to End at the tempo playing now, in seconds. */
async function playSeconds(pad: number): Promise<number> {
  const p = pads.value[pad]!;
  const ch = channelsOf(pad) ?? (await withDevice((d) => d.sampleChannels(project1.value, pad)));
  const tempo = tempoFor(pad >> 4);
  const speed = tempo ? padSpeed(p, tempo.tempoX100).ratio : 1;
  return (byteToFrame(p.endByte, ch) - byteToFrame(p.startByte, ch)) / 48000 / speed;
}

/** Open the input and the SP's MIDI port; false (with a notice) when either is missing. */
async function prepare(): Promise<boolean> {
  if (writeBlockReason.value) { notice.value = { kind: "error", text: writeBlockReason.value }; return false; }
  if (!(await ensureArmed())) {
    notice.value = { kind: "error", text: `Could not open the recording input${recError.value ? `: ${recError.value}` : ""}` };
    return false;
  }
  // The pad is hit by a MIDI note, as by a hand: the remote preview (8E) plays one pad at a time and
  // ignores PAD Link (checked on the unit), so it cannot layer.
  if (!(await connectMidi())) {
    notice.value = { kind: "error", text: midiState.value === "denied" ? "MIDI access denied — allow it for this page" : "SP MIDI port not found" };
    return false;
  }
  return true;
}

interface Recorded { samples: Int16Array; channels: 1 | 2; name: string; bpmX100: number | null; seconds: number }

/**
 * Hit one pad and record the SP's output until the longest pad of its PAD Link group has ended,
 * plus the tail; normalized in float. Null when the recording is silent. `label` prefixes the
 * progress text (for a group).
 */
async function recordPad(pad: number, label = ""): Promise<Recorded | null> {
  const p = pads.value[pad]!;
  const tempo = tempoFor(pad >> 4);
  const speed = tempo ? padSpeed(p, tempo.tempoX100).ratio : 1;
  const group = linkedPads(pad);
  let play = 0;
  for (const i of group) play = Math.max(play, await playSeconds(i));
  play = Math.min(MAX_PLAY, play);
  const tail = Math.max(0, Math.min(10, rsTail.value));
  let pressed = false;
  const rec = await capture(async () => {
    await sleep(50); // a moment before the hit, so its start is not cut
    rsBusy.value = `${label}Playing ${group.length > 1 ? group.map(padName).join("+") : padName(pad)}: ${play.toFixed(1)} s`;
    try {
      hitPads([pad]);
      pressed = true;
      playing.value = pad;
      await sleep(play * 1000);
    } finally {
      if (pressed) {
        // Gate on: the release stops a pad. Gate off with Loop: only the panic stop does. Gate off: it has ended.
        const looping = group.filter((i) => pads.value[i]?.loop && !pads.value[i]?.gate);
        releasePads(group);
        if (looping.length) await withDevice(async (d) => { for (const i of looping) await d.stopPad(project1.value, i); }).catch(() => {});
        playing.value = null;
      }
    }
    for (let left = tail; left > 0; left -= 0.5) {
      rsBusy.value = `${label}Effects tail: ${left.toFixed(1)} s`;
      await sleep(Math.min(0.5, left) * 1000);
    }
  });
  // No silence trim: an analogue input's noise sits above any fixed threshold (checked on the unit);
  // Start/End can be set after the import with "Убрать тишину".
  const cut = trimAndNormalize(rec.chans, { thresholdDb: null, normalizeDb: rsNormalize.value ? -0.3 : null });
  if (!cut) return null;
  const bpm = Math.round(p.bpmX100 * speed);
  const seconds = cut.chans[0].length / 48000;
  log("info", `Resample ${padName(pad)}: ${seconds.toFixed(2)} s, gain ${(20 * Math.log10(cut.gain)).toFixed(1)} dB`);
  return {
    samples: floatBlocksToPcm([cut.chans], rec.channels), channels: rec.channels, seconds,
    name: `${(p.name || padName(pad)).slice(0, 19)}_rs`, bpmX100: bpm >= BPM_MIN_X100 && bpm <= BPM_MAX_X100 ? bpm : null,
  };
}

/** One pad: the take is offered (listen, then onto a pad). */
export async function resamplePad(pad: number): Promise<void> {
  if (!pads.value[pad]?.size || rsBusy.value) return;
  rsBusy.value = "Opening input…";
  try {
    if (!(await prepare())) return;
    const r = await recordPad(pad);
    if (!r) return void (notice.value = { kind: "error", text: "The recording is silent: check the input, SP volume and whether the effect/pad is playing" });
    setTake(r.samples, r.channels, r.name, { bpmX100: r.bpmX100, source: pad });
  } catch (e) {
    notice.value = { kind: "error", text: `Resample ${padName(pad)}: ${(e as Error).message}` };
  } finally {
    rsBusy.value = null;
  }
}

/**
 * The picked pads that get their own pass: a pad that sounds as a layer of an earlier picked pad
 * (same PAD Link group) is skipped, as it is already in that take.
 */
export function groupPlan(list: number[]): { sources: number[]; skipped: number[] } {
  const sources: number[] = [], skipped: number[] = [], covered = new Set<number>();
  for (const pad of list) {
    if (covered.has(pad)) { skipped.push(pad); continue; }
    sources.push(pad);
    for (const i of linkedPads(pad)) covered.add(i);
  }
  return { sources, skipped };
}

/** The first `n` empty pads of `bank`, or null when there are fewer. */
export function emptyPadsOf(bank: number, n: number): number[] | null {
  const out: number[] = [];
  for (let i = bank * 16; i < bank * 16 + 16 && out.length < n; i++) if (!pads.value[i]?.size) out.push(i);
  return out.length === n ? out : null;
}

/**
 * Every picked pad through the effect set on the SP, one after another; then all takes in one
 * import onto the first empty pads of `bank` (the SP does not write files while it plays).
 * "Стоп" ends it after the pad being recorded; what was recorded so far is still imported.
 */
export async function resampleGroup(bank: number): Promise<void> {
  if (rsBusy.value || groupProgress.value) return;
  const { sources } = groupPlan(pickedList.value);
  if (!sources.length) return;
  if (!emptyPadsOf(bank, sources.length)) return void (notice.value = { kind: "error", text: `Bank ${"ABCDEFGHIJ"[bank]} does not have enough empty pads` });
  rsCancel.value = false;
  rsBusy.value = "Opening input…";
  const takes: Recorded[] = [];
  try {
    if (!(await prepare())) return;
    for (const [i, pad] of sources.entries()) {
      if (rsCancel.value) break;
      groupProgress.value = { done: i, total: sources.length, verb: "Resample" };
      const r = await recordPad(pad, `${i + 1}/${sources.length} · `);
      if (r) takes.push(r);
      else log("warn", `Resample ${padName(pad)}: silent recording — skipped`);
    }
  } catch (e) {
    notice.value = { kind: "error", text: `Group resample: ${(e as Error).message}` };
  } finally {
    groupProgress.value = null;
    rsBusy.value = null;
  }
  if (!takes.length) return;
  const targets = emptyPadsOf(bank, takes.length);
  if (!targets) return void (notice.value = { kind: "error", text: `During recording, bank ${"ABCDEFGHIJ"[bank]} ran out of empty pads` });
  log("info", `Group resample: ${takes.length} takes → ${targets.map(padName).join(", ")}`);
  importFiles(takes.map((t) => new File([encodeWav(t.samples, t.channels)], `${t.name}.wav`, { type: "audio/wav" })), targets[0], takes.map((t) => t.bpmX100 ?? undefined));
}
