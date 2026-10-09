import { useEffect } from "preact/hooks";
import { padName } from "../sp404";
import {
  RATE, TAKE_DRAG, arm, disarm, dropTake, listInputs, playTake, recClip, recError, recInputId, recInputs, recLevel, recSeconds, recState, recTake, record,
  setInput, stop, takeBank, takePlaying, takeTarget, takeToPad,
} from "./rec";
import { conn, pads, selectedPad } from "./store";
import { BANKS } from "../sp404";
import { Waveform } from "./Waveform";
import { IconMic, IconPlay, IconStop, IconTrash } from "./icons";

export const fmtTime = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
const db = (v: number) => (v <= 0.00001 ? "−∞" : `${(20 * Math.log10(v)).toFixed(1)}`);

/** Which input to record from, and the switch that opens / closes it. */
export function InputPicker() {
  const state = recState.value;
  const on = state === "armed" || state === "recording";
  useEffect(() => { void listInputs(); }, []);
  return (
    <>
      <div class="rec-input">
        <select value={recInputId.value} onChange={(e) => setInput((e.target as HTMLSelectElement).value)} disabled={state === "recording"} aria-label="Input">
          {!recInputs.value.some((i) => i.id === recInputId.value) && <option value={recInputId.value}>{recInputId.value ? "selected input" : "default input"}</option>}
          {recInputs.value.map((i) => <option key={i.id} value={i.id}>{i.label}</option>)}
        </select>
        {on ? <button class="btn" disabled={state === "recording"} onClick={disarm}>Close input</button>
          : <button class="btn btn-primary" disabled={state === "arming"} onClick={() => void arm()}>{state === "arming" ? "…" : "Open input"}</button>}
      </div>
      {recError.value && <span class="err">{recError.value}</span>}
    </>
  );
}

/** Peak meter of the open input, with a clip mark. */
export function RecMeter() {
  const on = recState.value === "armed" || recState.value === "recording";
  return (
    <div class={`rec-meter ${on ? "" : "off"}`} title="Input peak level">
      {recLevel.value.map((v, c) => (
        <div key={c} class="rec-bar">
          <span class="rec-ch">{recLevel.value.length > 1 ? (c ? "R" : "L") : "M"}</span>
          <span class="rec-track"><span class={`rec-fill ${v >= 0.999 ? "hot" : v > 0.7 ? "warm" : ""}`} style={{ width: `${Math.min(1, Math.sqrt(v)) * 100}%` }} /></span>
          <span class="rec-db">{db(v)}</span>
        </div>
      ))}
      {recClip.value && <button class="rec-clip" onClick={() => (recClip.value = false)} title="Clipping detected; click to reset">CLIP</button>}
    </div>
  );
}

/** The take: its waveform, listen on the computer, onto a pad (button or drag), throw away. */
export function TakeCard() {
  const take = recTake.value;
  if (!take) return null;
  const target = takeTarget(), ready = conn.value === "ready";
  return (
    <div class="rec-take" draggable onDragStart={(e) => { e.dataTransfer!.setData(TAKE_DRAG, take.name); e.dataTransfer!.effectAllowed = "copy"; }}
      title="Drag the take onto an empty pad">
      <div class="rec-take-head">
        <b>{take.name}</b>
        <span class="muted">
          {(take.frames / RATE).toFixed(2)} s · {take.channels === 1 ? "mono" : "stereo"} · peak {db(take.peak)} dB
          {take.bpmX100 ? ` · ${(take.bpmX100 / 100).toFixed(2)} BPM` : ""}{take.source !== undefined ? ` · of ${padName(take.source)}` : ""}
        </span>
      </div>
      <Waveform wave={take.wave} />
      <div class="rec-take-actions">
        <button class="btn" onClick={() => void playTake()}>{takePlaying.value ? <><IconStop /> Stop</> : <><IconPlay /> Preview</>}</button>
        <select class="take-bank" value={takeBank.value ?? selectedPad.value >> 4} onChange={(e) => (takeBank.value = +(e.target as HTMLSelectElement).value)}
          aria-label="Bank for the take" title="Destination for the take: the first empty pad in this bank">
          {[...BANKS].map((l, b) => <option key={l} value={b}>bank {l} ({16 - pads.value.slice(b * 16, b * 16 + 16).filter((x) => x?.size).length} free)</option>)}
        </select>
        <button class="btn btn-primary" disabled={!ready || target === null} onClick={() => target !== null && takeToPad(target)}
          title={target === null ? "No empty pads in this bank" : "Upload the take to SP"}>
          {target === null ? "No empty pad" : `To ${padName(target)}`}
        </button>
        <button class="icon-btn" onClick={dropTake} title="Discard take" aria-label="Discard take"><IconTrash /></button>
      </div>
    </div>
  );
}

/**
 * Record from an input of the computer onto a pad. The input stays open only while this panel is
 * shown (or a recording runs), so the browser's microphone indicator is not left on.
 */
export function Recorder() {
  const state = recState.value, take = recTake.value;
  useEffect(() => () => { if (recState.value !== "recording") disarm(); }, []);
  return (
    <aside class="inspector glass recorder">
      <div class="insp-head"><span class="chip chip-accent"><IconMic /></span><span class="insp-name">Input recording</span></div>
      <div class="insp-scroll">
        <InputPicker />
        <RecMeter />
        <div class="rec-controls">
          {state === "recording" ? (
            <button class="btn btn-danger rec-btn" onClick={stop}><IconStop /> Stop</button>
          ) : (
            <button class="btn rec-btn rec-go" disabled={state !== "armed"} onClick={record} title={state === "armed" ? "Start recording" : "Open the input first"}>
              <span class="rec-dot" /> Record
            </button>
          )}
          <span class={`rec-time ${state === "recording" ? "live" : ""}`}>{fmtTime(state === "recording" ? recSeconds.value : take ? take.frames / RATE : 0)}</span>
        </div>
        <TakeCard />
        <p class="hint">
          From Ableton: install a virtual cable (such as VB-Audio Cable), select ‘CABLE Input’ as Ableton's output in Preferences → Audio, then choose ‘CABLE Output’ as the input here. Your audio interface's loopback also works. Audio is recorded at 48 kHz without processing; drag the take onto an empty pad or upload it with the button.
        </p>
      </div>
    </aside>
  );
}
