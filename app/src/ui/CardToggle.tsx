import { showSide, sideTab } from "./card";
import { IconCard, IconMic } from "./icons";

/** Top bar switch: the right column shows the SD card browser instead of the pad inspector. */
export function CardToggle() {
  const on = sideTab.value === "card";
  return (
    <button type="button" class={`btn card-toggle ${on ? "on" : ""}`} aria-pressed={on} onClick={() => showSide(on ? "pad" : "card")}
      title={on ? "Вернуться к pad'у" : "Открыть карту SD справа: раскладывать сэмплы с карты по pad'ам"}>
      <IconCard /> Карта SD
    </button>
  );
}

/** Top bar switch: the right column shows the recorder (an input of the computer → a pad). */
export function RecToggle() {
  const on = sideTab.value === "rec";
  return (
    <button type="button" class={`btn card-toggle ${on ? "on" : ""}`} aria-pressed={on} onClick={() => showSide(on ? "pad" : "rec")}
      title={on ? "Вернуться к pad'у" : "Записать звук со входа компьютера (например, из Ableton) на pad"}>
      <IconMic /> Запись
    </button>
  );
}
