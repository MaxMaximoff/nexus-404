import { signal } from "@preact/signals";
import { useEffect, useRef, useState } from "preact/hooks";
import { LEVEL_MAX, byteToFrame, findSound, formatBpm, padName, parseBpmInput } from "../sp404";
import {
  channelsOf, conn, importFiles, loadWaveform, pads, preview, project, selectedPad, setBpm, setBpmSync, setGate, setLevel, setLoop, setOneShot,
  setRange, waveLoading, waveforms, writeBlockReason,
} from "./store";
import { Waveform, type Range } from "./Waveform";
import type { Waveform as Wave } from "./store";
import { IconCheck, IconPlay, IconUpload, IconWave } from "./icons";

const RATE = 48000;
const TRIM_THRESHOLDS = [-60, -48, -36, -24];
/** Silence threshold for "Убрать тишину", dBFS; kept while switching pads. */
const trimDb = signal(-36);

export function Inspector() {
  const pad = selectedPad.value;
  const p = pads.value[pad];
  const ready = conn.value === "ready";
  const protectedBank = !!project.value?.banks[pad >> 4]?.protected;
  return (
    <aside class="inspector glass">
      <div class="insp-head">
        <span class="chip chip-accent">{padName(pad)}</span>
        <span class="insp-name" title={p?.name}>{p?.size ? p.name || "без имени" : "Пустой pad"}</span>
      </div>
      {p?.size ? <FilledPad pad={pad} ready={ready} /> : <EmptyPad pad={pad} ready={ready} protectedBank={protectedBank} />}
    </aside>
  );
}

function FilledPad({ pad, ready }: { pad: number; ready: boolean }) {
  const p = pads.value[pad]!;
  const wave = waveforms.value.get(pad);
  const loading = waveLoading.value?.pad === pad ? waveLoading.value : null;
  const channels = channelsOf(pad);
  const total = channels ? byteToFrame(p.size, channels) : null;
  const range = channels && total ? { start: byteToFrame(p.startByte, channels) / total, end: byteToFrame(p.endByte, channels) / total } : undefined;
  const frames = channels ? (p.endByte - p.startByte) / (2 * channels) : null;
  return (
    <>
      {wave ? <Waveform wave={wave} range={range} onCommit={total && !writeBlockReason.value ? (r) => commitDrag(pad, r, total) : undefined} /> : (
        <div class="wave-box">
          <div class="wave-placeholder">
            {loading ? (
              <>
                <span>Читаю сэмпл с SP… {Math.round(loading.progress * 100)} %</span>
                <span class="bar"><span style={{ width: `${loading.progress * 100}%` }} /></span>
              </>
            ) : (
              <button class="btn" disabled={!ready} onClick={() => loadWaveform(pad)}>
                <IconWave /> Показать волну ({(p.size / 1048576).toFixed(1)} MB)
              </button>
            )}
          </div>
        </div>
      )}

      <BpmEditor pad={pad} />

      <section class="params" aria-label="Параметры pad'а">
        <LevelControl pad={pad} />
        <div class="toggles">
          <Toggle label="Gate" on={p.gate} onChange={(on) => setGate(pad, on)} />
          <Toggle label="Loop" on={p.loop} onChange={(on) => setLoop(pad, on)} />
          <Toggle label="One Shot" on={p.oneShot} onChange={(on) => setOneShot(pad, on)}
            hint="Как в официальном App: при включении One Shot выключаются Gate и Loop" />
          <Toggle label="BPM Sync" on={p.bpmSync} onChange={(on) => setBpmSync(pad, on)} />
        </div>
        {channels ? <RangeEditor pad={pad} channels={channels} wave={wave} /> : <div class="range-editor muted">Start/End: читаю заголовок сэмпла…</div>}
      </section>

      <dl class="facts">
        <div><dt>Звучит</dt><dd>{frames !== null ? `${(frames / RATE).toFixed(2)} s` : "—"}</dd></div>
        <div><dt>Весь сэмпл</dt><dd>{total !== null ? `${(total / RATE).toFixed(2)} s` : "—"}</dd></div>
        <div><dt>Каналы</dt><dd>{channels ? (channels === 1 ? "mono" : "stereo") : "—"}</dd></div>
        <div><dt>Размер</dt><dd>{(p.size / 1048576).toFixed(2)} MB</dd></div>
      </dl>

      <button
        class="btn btn-wide"
        disabled={!ready}
        onPointerDown={() => preview(pad, true)}
        onPointerUp={() => preview(pad, false)}
        onPointerLeave={(e) => e.buttons && preview(pad, false)}
        title="Держите, чтобы SP играл pad"
      >
        <IconPlay /> Прослушать на SP (удерживайте)
      </button>
    </>
  );
}

/** A switch that writes to the SP and then shows the state the device reports back. */
function Toggle({ label, on, hint, onChange }: { label: string; on: boolean; hint?: string; onChange: (on: boolean) => Promise<boolean> }) {
  const [busy, setBusy] = useState(false);
  const blocked = writeBlockReason.value;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      class={`toggle ${on ? "on" : ""} ${busy ? "busy" : ""}`}
      disabled={!!blocked || busy}
      title={blocked ?? hint}
      onClick={async () => {
        setBusy(true);
        await onChange(!on);
        setBusy(false);
      }}
    >
      <span class="knob" aria-hidden="true" />
      {label}
    </button>
  );
}

/** Level slider: shows the value while dragging, writes once on release (or per arrow key). */
function LevelControl({ pad }: { pad: number }) {
  const p = pads.value[pad]!;
  const [value, setValue] = useState(p.level);
  const [busy, setBusy] = useState(false);
  useEffect(() => setValue(p.level), [pad, p.level]);
  const blocked = writeBlockReason.value;

  const commit = async (v: number) => {
    if (v === p.level) return;
    setBusy(true);
    if (!(await setLevel(pad, v))) setValue(pads.value[pad]?.level ?? p.level);
    setBusy(false);
  };

  return (
    <div class={`level ${busy ? "busy" : ""}`}>
      <label for="level-input">Level</label>
      <input
        id="level-input"
        type="range"
        min={0}
        max={LEVEL_MAX}
        step={1}
        value={value}
        disabled={!!blocked}
        title={blocked ?? undefined}
        style={{ "--fill": `${(value / LEVEL_MAX) * 100}%` }}
        onInput={(e) => setValue(+(e.target as HTMLInputElement).value)}
        onChange={(e) => commit(+(e.target as HTMLInputElement).value)}
      />
      <output for="level-input">{value}</output>
    </div>
  );
}

const fmtSec = (frames: number) => (frames / RATE).toFixed(3);

/** Seconds typed by the user → frames; within 1 ms of the sample's end snaps to the end. */
function parseSec(text: string, total: number): number | null {
  const t = text.trim().replace(",", ".");
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(t)) return null;
  const f = Math.round(parseFloat(t) * RATE);
  return Math.abs(f - total) < RATE / 1000 ? total : f;
}

/** Dropped markers (fractions of the sample) → frames on the device. */
function commitDrag(pad: number, r: Range, total: number): Promise<boolean> {
  const start = Math.round(r.start * total);
  const end = Math.max(start + 1, Math.round(r.end * total));
  return setRange(pad, start, Math.min(end, total));
}

function RangeEditor({ pad, channels, wave }: { pad: number; channels: number; wave?: Wave }) {
  const p = pads.value[pad]!;
  const total = byteToFrame(p.size, channels);
  const s0 = byteToFrame(p.startByte, channels), e0 = byteToFrame(p.endByte, channels);
  const [startText, setStartText] = useState(fmtSec(s0));
  const [endText, setEndText] = useState(fmtSec(e0));
  const [busy, setBusy] = useState(false);
  useEffect(() => { setStartText(fmtSec(s0)); setEndText(fmtSec(e0)); }, [pad, s0, e0]);
  const blocked = writeBlockReason.value;

  // An untouched field keeps its exact frame (the text is rounded to 1 ms).
  const s1 = startText === fmtSec(s0) ? s0 : parseSec(startText, total);
  const e1 = endText === fmtSec(e0) ? e0 : parseSec(endText, total);
  const error = s1 === null || e1 === null ? "Введите секунды, например 1.25"
    : !(s1 < e1) ? "Start должен быть меньше End"
    : e1 > total ? `End не дальше конца сэмпла (${fmtSec(total)} s)` : null;
  const dirty = s1 !== s0 || e1 !== e0;
  const whole = s0 === 0 && e0 === total;

  const save = async (start: number, end: number) => {
    if (blocked || busy) return;
    setBusy(true);
    await setRange(pad, start, end);
    setBusy(false);
  };
  // Silence trim over the whole sample (not just the current Start–End), so the result depends only on the threshold.
  const sound = wave ? findSound(wave.envelope, total, trimDb.value) : undefined;
  const trimNote = !wave ? "Чтобы убрать тишину, загрузите волну"
    : sound === null ? `Весь сэмпл тише ${trimDb.value} dB`
    : sound && sound.start === s0 && sound.end === e0 ? "Тишины по краям нет" : null;

  const keys = (reset: () => void) => (e: KeyboardEvent) => {
    if (e.key === "Enter" && dirty && !error && s1 !== null && e1 !== null) save(s1, e1);
    if (e.key === "Escape") reset();
  };
  const field = (label: string, text: string, set: (t: string) => void, saved: number, bad: boolean) => (
    <label>
      <span>{label}</span>
      <input type="text" inputMode="decimal" autoComplete="off" spellcheck={false} value={text} disabled={!!blocked}
        title={`${saved} кадров`} class={bad ? "invalid" : ""}
        onInput={(e) => set((e.target as HTMLInputElement).value)} onKeyDown={keys(() => set(fmtSec(saved)))}
        onFocus={(e) => (e.target as HTMLInputElement).select()} />
      <i>s</i>
    </label>
  );

  return (
    <div class="range-editor">
      {field("Start", startText, setStartText, s0, s1 === null)}
      {field("End", endText, setEndText, e0, e1 === null)}
      <div class="range-actions">
        <button class="btn btn-primary" disabled={!dirty || !!error || !!blocked || busy} onClick={() => s1 !== null && e1 !== null && save(s1, e1)}>
          {busy ? "…" : "Применить"}
        </button>
        <button class="btn" disabled={whole || !!blocked || busy} onClick={() => save(0, total)} title="Start = 0, End = конец сэмпла">Весь сэмпл</button>
      </div>
      <div class="trim">
        <button class="btn" disabled={!sound || !!trimNote || !!blocked || busy} title={trimNote ?? "Поставить Start/End на первый и последний звук громче порога"}
          onClick={() => sound && save(sound.start, sound.end)}>
          Убрать тишину
        </button>
        <label>
          <span>порог</span>
          <select value={trimDb.value} onChange={(e) => (trimDb.value = +(e.target as HTMLSelectElement).value)}>
            {TRIM_THRESHOLDS.map((db) => <option value={db}>{db} dB</option>)}
          </select>
        </label>
        {trimNote && <span class="muted">{trimNote}</span>}
      </div>
      <span class={`bpm-note ${dirty && error ? "err" : ""}`}>
        {(dirty && error) || blocked || (dirty ? "Enter — применить, Esc — отменить" : `Звучит ${fmtSec(e0 - s0)} s из ${fmtSec(total)} s`)}
      </span>
    </div>
  );
}

function BpmEditor({ pad }: { pad: number }) {
  const p = pads.value[pad]!;
  const saved = formatBpm(p.bpmX100);
  const [text, setText] = useState(saved);
  const [state, setState] = useState<"idle" | "saving" | "saved">("idle");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { setText(saved); setState("idle"); }, [pad, p.bpmX100]);

  const parsed = parseBpmInput(text);
  const error = parsed && "error" in parsed ? parsed.error : null;
  const dirty = parsed && "x100" in parsed && parsed.x100 !== p.bpmX100;
  const blocked = writeBlockReason.value;

  const save = async () => {
    if (!parsed || !("x100" in parsed) || !dirty || blocked) return;
    setState("saving");
    const ok = await setBpm(pad, parsed.x100);
    setState(ok ? "saved" : "idle");
    if (ok) setTimeout(() => setState("idle"), 1500);
  };

  return (
    <div class="bpm-editor">
      <label for="bpm-input">BPM</label>
      <input
        id="bpm-input"
        ref={inputRef}
        class={error ? "invalid" : ""}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        spellcheck={false}
        value={text}
        onInput={(e) => setText((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") setText(saved);
        }}
        onFocus={(e) => (e.target as HTMLInputElement).select()}
      />
      <button class="btn btn-primary" disabled={!dirty || !!error || !!blocked || state === "saving"} onClick={save}>
        {state === "saving" ? "…" : state === "saved" ? <><IconCheck /> Сохранено</> : "Сохранить"}
      </button>
      <span class={`bpm-note ${error ? "err" : ""}`}>{error ?? blocked ?? (dirty ? "Enter — сохранить, Esc — отменить" : "40–200, например 93.25")}</span>
    </div>
  );
}

function EmptyPad({ pad, ready, protectedBank }: { pad: number; ready: boolean; protectedBank: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const blocked = protectedBank ? "Банк защищён (BANK Protect)" : writeBlockReason.value;
  return (
    <div
      class={`dropzone ${over ? "drop" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); importFiles([...(e.dataTransfer?.files ?? [])], pad); }}
    >
      <IconUpload />
      <b>Перетащите сюда аудио</b>
      <span class="muted">WAV, AIFF, FLAC, MP3 — будет сконвертировано в 48 kHz / 16 bit.<br />Несколько файлов займут {padName(pad)} и следующие пустые pad'ы.</span>
      <input ref={input} type="file" multiple accept="audio/*,.wav,.aif,.aiff,.flac,.mp3" hidden
        onChange={(e) => { const f = (e.target as HTMLInputElement).files; if (f) importFiles([...f], pad); (e.target as HTMLInputElement).value = ""; }} />
      <button class="btn btn-primary" disabled={!ready || !!blocked} onClick={() => input.current?.click()}>Выбрать файлы…</button>
      {ready && blocked && <span class="err">{blocked}</span>}
    </div>
  );
}
