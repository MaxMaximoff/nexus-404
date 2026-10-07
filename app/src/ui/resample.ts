// Resample through the SP's own effects: the app plays a pad (8E) while it records the SP's output
// on an input of the computer (the SP's USB line, or its outputs into an audio interface), lets
// the effect's tail ring out, normalizes in float, and offers the take for a pad. The pad is hit by
// a MIDI note, so PAD Link groups play as layers.
// The effect is set on the SP beforehand; whatever else the SP plays meanwhile is recorded too.

import { signal } from "@preact/signals";
import { BPM_MAX_X100, BPM_MIN_X100, byteToFrame, floatBlocksToPcm, padName, padSpeed, trimAndNormalize } from "../sp404";
import { capture, ensureArmed, recError, setTake } from "./rec";
import { connectMidi, hitPads, midiState, releasePads } from "./midi";
import { channelsOf, log, notice, pads, playing, project1, tempoFor, withDevice, writeBlockReason } from "./store";

export const rsTail = signal(2); // seconds after the release, for reverb / delay tails
export const rsNormalize = signal(true);
/** What a resample is doing now, for the button; null when idle. */
export const rsBusy = signal<string | null>(null);

const MAX_PLAY = 600;

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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function resamplePad(pad: number): Promise<void> {
  const p = pads.value[pad];
  if (!p?.size || rsBusy.value) return;
  if (writeBlockReason.value) return void (notice.value = { kind: "error", text: writeBlockReason.value });
  rsBusy.value = "Открываю вход…";
  try {
    if (!(await ensureArmed())) {
      notice.value = { kind: "error", text: `Вход для записи не открылся${recError.value ? `: ${recError.value}` : ""}` };
      return;
    }
    // The pad is hit by a MIDI note, as by a hand: the remote preview (8E) plays one pad at a time and
    // ignores PAD Link (checked on the unit), so it cannot layer.
    if (!(await connectMidi())) {
      notice.value = { kind: "error", text: midiState.value === "denied" ? "Доступ к MIDI запрещён — разрешите его для этой страницы" : "MIDI-порт SP не найден" };
      return;
    }
    const tempo = tempoFor(pad >> 4);
    const speed = tempo ? padSpeed(p, tempo.tempoX100).ratio : 1;
    // The SP plays the PAD Link group itself: record until the longest of them has ended.
    const group = linkedPads(pad);
    let play = 0;
    for (const i of group) play = Math.max(play, await playSeconds(i));
    play = Math.min(MAX_PLAY, play);
    const tail = Math.max(0, Math.min(10, rsTail.value));
    let pressed = false;
    const rec = await capture(async () => {
      await sleep(50); // a moment before the hit, so its start is not cut
      rsBusy.value = `Играет ${group.length > 1 ? group.map(padName).join("+") : padName(pad)}: ${play.toFixed(1)} s`;
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
        rsBusy.value = `Хвост эффекта: ${left.toFixed(1)} s`;
        await sleep(Math.min(0.5, left) * 1000);
      }
    });
    // No silence trim: an analogue input's noise sits above any fixed threshold (checked on the unit);
    // Start/End can be set after the import with "Убрать тишину".
    const cut = trimAndNormalize(rec.chans, { thresholdDb: null, normalizeDb: rsNormalize.value ? -0.3 : null });
    if (!cut) {
      notice.value = { kind: "error", text: "В записи тишина: проверьте вход, громкость SP и что эффект/pad звучат" };
      return;
    }
    const bpm = Math.round(p.bpmX100 * speed);
    const name = `${(p.name || padName(pad)).slice(0, 19)}_rs`;
    setTake(floatBlocksToPcm([cut.chans], rec.channels), rec.channels, name,
      { bpmX100: bpm >= BPM_MIN_X100 && bpm <= BPM_MAX_X100 ? bpm : null, source: pad });
    log("info", `Ресэмпл ${padName(pad)}: ${(cut.chans[0].length / 48000).toFixed(2)} s, усиление ${(20 * Math.log10(cut.gain)).toFixed(1)} dB`);
  } catch (e) {
    notice.value = { kind: "error", text: `Ресэмпл ${padName(pad)}: ${(e as Error).message}` };
  } finally {
    rsBusy.value = null;
  }
}
