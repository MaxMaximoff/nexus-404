// Mute and solo of a pattern row while it plays: for listening only, nothing of it is saved.

import { audible, mutedPads, soloPads, toggleMute, toggleSolo } from "./ptnPlayer";

export function RowSound({ pad }: { pad: number }) {
  const m = mutedPads.value.has(pad), s = soloPads.value.has(pad);
  return (
    <span class="ptn-rowsound">
      <button class={`ptn-ms ${m ? "on mute" : ""}`} onClick={() => toggleMute(pad)} aria-pressed={m}
        title="Mute row during playback (preview only; not written to the pattern)">M</button>
      <button class={`ptn-ms ${s ? "on solo" : ""}`} onClick={() => toggleSolo(pad)} aria-pressed={s}
        title="Solo this row (multiple rows can be soloed)">S</button>
    </span>
  );
}

/** Class for a lane that will not sound: muted, or another row is soloed. */
export const silentClass = (pad: number): string => (audible(pad) ? "" : "silent");
