import { showSide, sideTab } from "./card";
import { IconCard, IconGrid, IconMic, IconScissors } from "./icons";
import { mainView, showView } from "./Patterns";
import { patterns } from "./store";

/** Top bar switch: the right column shows the SD card browser instead of the pad inspector. */
export function CardToggle() {
  const on = sideTab.value === "card";
  return (
    <button type="button" class={`btn card-toggle ${on ? "on" : ""}`} aria-pressed={on} onClick={() => showSide(on ? "pad" : "card")}
      title={on ? "Return to pad" : "Open the SD card on the right to load card samples onto pads"}>
      <IconCard /> SD Card
    </button>
  );
}

/** Top bar switch: the left column shows the patterns instead of banks and pads. */
export function PatternsToggle() {
  const on = mainView.value === "patterns", n = patterns.value?.size;
  return (
    <button type="button" class={`btn card-toggle ${on ? "on" : ""}`} aria-pressed={on} onClick={() => showView(on ? "pads" : "patterns")}
      title={on ? "Return to pads" : "Project patterns: which pads play and when, with MIDI export"}>
      <IconGrid /> Patterns{n ? ` · ${n}` : ""}
    </button>
  );
}

/** Top bar switch: the right column shows the recorder (an input of the computer → a pad). */
export function RecToggle() {
  const on = sideTab.value === "rec";
  return (
    <button type="button" class={`btn card-toggle ${on ? "on" : ""}`} aria-pressed={on} onClick={() => showSide(on ? "pad" : "rec")}
      title={on ? "Return to pad" : "Record audio from a computer input (such as Ableton) onto a pad"}>
      <IconMic /> Record
    </button>
  );
}

/** Top bar switch: the left column shows the track slicer instead of banks and pads. */
export function SlicerToggle() {
  const on = mainView.value === "slicer";
  return (
    <button type="button" class={`btn card-toggle ${on ? "on" : ""}`} aria-pressed={on}
      onClick={() => { showView(on ? "pads" : "slicer"); if (!on && sideTab.value === "pad") showSide("card"); }}
      title={on ? "Return to pads" : "Cut a long track into loops of whole bars; the loops go to a folder on the SD card"}>
      <IconScissors /> Slicer
    </button>
  );
}
