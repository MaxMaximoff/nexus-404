import { useEffect } from "preact/hooks";
import { padName } from "../sp404";
import {
  RATE, TAKE_DRAG, arm, disarm, dropTake, listInputs, playTake, recClip, recError, recInputId, recInputs, recLevel, recSeconds, recState, recTake, record,
  setInput, stop, takePlaying, takeTarget, takeToPad,
} from "./rec";
import { conn } from "./store";
import { Waveform } from "./Waveform";
import { IconMic, IconPlay, IconStop, IconTrash } from "./icons";

const fmtTime = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
const db = (v: number) => (v <= 0.00001 ? "−∞" : `${(20 * Math.log10(v)).toFixed(1)}`);

/**
 * Record from an input of the computer onto a pad. The input stays open only while this panel is
 * shown (or a recording runs), so the browser's microphone indicator is not left on.
 */
export function Recorder() {
  const state = recState.value, take = recTake.value, ready = conn.value === "ready";
  useEffect(() => {
    void listInputs();
    return () => { if (recState.value !== "recording") disarm(); };
  }, []);
  const target = takeTarget();
  const on = state === "armed" || state === "recording";
  return (
    <aside class="inspector glass recorder">
      <div class="insp-head"><span class="chip chip-accent"><IconMic /></span><span class="insp-name">Запись со входа</span></div>
      <div class="insp-scroll">
        <div class="rec-input">
          <select value={recInputId.value} onChange={(e) => setInput((e.target as HTMLSelectElement).value)} disabled={state === "recording"} aria-label="Вход">
            {!recInputs.value.some((i) => i.id === recInputId.value) && <option value={recInputId.value}>{recInputId.value ? "выбранный вход" : "вход по умолчанию"}</option>}
            {recInputs.value.map((i) => <option key={i.id} value={i.id}>{i.label}</option>)}
          </select>
          {on ? <button class="btn" disabled={state === "recording"} onClick={disarm}>Выключить вход</button>
            : <button class="btn btn-primary" disabled={state === "arming"} onClick={() => void arm()}>{state === "arming" ? "…" : "Включить вход"}</button>}
        </div>
        {recError.value && <span class="err">{recError.value}</span>}

        <div class={`rec-meter ${on ? "" : "off"}`} title="Пиковый уровень входа">
          {recLevel.value.map((v, c) => (
            <div key={c} class="rec-bar">
              <span class="rec-ch">{recLevel.value.length > 1 ? (c ? "R" : "L") : "M"}</span>
              <span class="rec-track"><span class={`rec-fill ${v >= 0.999 ? "hot" : v > 0.7 ? "warm" : ""}`} style={{ width: `${Math.min(1, Math.sqrt(v)) * 100}%` }} /></span>
              <span class="rec-db">{db(v)}</span>
            </div>
          ))}
          {recClip.value && <button class="rec-clip" onClick={() => (recClip.value = false)} title="Был перегруз; щёлкните, чтобы сбросить">CLIP</button>}
        </div>

        <div class="rec-controls">
          {state === "recording" ? (
            <button class="btn btn-danger rec-btn" onClick={stop}><IconStop /> Стоп</button>
          ) : (
            <button class="btn rec-btn rec-go" disabled={state !== "armed"} onClick={record} title={state === "armed" ? "Начать запись" : "Сначала включите вход"}>
              <span class="rec-dot" /> Запись
            </button>
          )}
          <span class={`rec-time ${state === "recording" ? "live" : ""}`}>{fmtTime(state === "recording" ? recSeconds.value : take ? take.frames / RATE : 0)}</span>
        </div>

        {take && (
          <div class="rec-take" draggable onDragStart={(e) => { e.dataTransfer!.setData(TAKE_DRAG, take.name); e.dataTransfer!.effectAllowed = "copy"; }}
            title="Перетащите дубль на пустой pad">
            <div class="rec-take-head">
              <b>{take.name}</b>
              <span class="muted">{(take.frames / RATE).toFixed(2)} s · {take.channels === 1 ? "моно" : "стерео"} · пик {db(take.peak)} dB</span>
            </div>
            <Waveform wave={take.wave} />
            <div class="rec-take-actions">
              <button class="btn" onClick={() => void playTake()}>{takePlaying.value ? <><IconStop /> Стоп</> : <><IconPlay /> Прослушать</>}</button>
              <button class="btn btn-primary" disabled={!ready || target === null} onClick={() => target !== null && takeToPad(target)}
                title={target === null ? "В банке нет пустых pad'ов" : "Записать дубль на SP"}>
                {target === null ? "Нет пустого pad'а" : `На ${padName(target)}`}
              </button>
              <button class="icon-btn" onClick={dropTake} title="Выбросить дубль" aria-label="Выбросить дубль"><IconTrash /></button>
            </div>
          </div>
        )}

        <p class="hint">
          Из Ableton: поставьте виртуальный кабель (например, VB-Audio Cable), в Ableton → Preferences → Audio выберите выход «CABLE Input», здесь — вход «CABLE Output».
          Подойдёт и loopback вашей звуковой карты. Запись идёт в 48 kHz без обработки; дубль можно перетащить на пустой pad или положить кнопкой.
        </p>
      </div>
    </aside>
  );
}
