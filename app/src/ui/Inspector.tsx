import { signal } from "@preact/signals";
import { useEffect, useRef, useState } from "preact/hooks";
import {
  BPM_RANGES, LEVEL_MAX, PITCH_COARSE_MAX, PITCH_FINE_MAX, STRETCH_MAX_X100, STRETCH_MIN_X100, VARI_MODES, byteToFrame, findSound, formatBpm, padName, padSpeed,
  parseBpmInput,
} from "../sp404";
import {
  bpmRange, channelsOf, confirmDelete, conn, deletePad, detectPadBpm, importFiles, loadWaveform, pads, playing, preview, project, selectedPad, setBpm, setBpmSync, setGate, setLevel, setLoop, setOneShot, setPitch, setTimeStretch, setVari, setVinyl,
  setRange, stopPlaying, waveLoading, waveforms, writeBlockReason,
} from "./store";
import { Waveform, type Range } from "./Waveform";
import type { Waveform as Wave } from "./store";
import { ValueField, intIn, signed, type Parse } from "./ValueField";
import { IconCheck, IconPlay, IconStop, IconTrash, IconUpload, IconWave } from "./icons";

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
      {p?.size && confirmDelete.value === pad ? <ConfirmDelete pad={pad} /> : (
        <div class="insp-head">
          <span class="chip chip-accent">{padName(pad)}</span>
          <span class="insp-name" title={p?.name}>{p?.size ? p.name || "без имени" : "Пустой pad"}</span>
          {!!p?.size && (
            <button class="btn insp-delete" disabled={!!writeBlockReason.value} onClick={() => (confirmDelete.value = pad)}
              title={writeBlockReason.value ?? `Удалить ${padName(pad)} с SP (Delete)`} aria-label="Удалить pad">
              <IconTrash />
            </button>
          )}
        </div>
      )}
      {p?.size ? <FilledPad pad={pad} ready={ready} /> : <EmptyPad pad={pad} ready={ready} protectedBank={protectedBank} />}
    </aside>
  );
}

/** Delete asks once, right in the header: Enter or the button deletes, Esc or Отмена keeps the pad. */
function ConfirmDelete({ pad }: { pad: number }) {
  const p = pads.value[pad]!;
  const yes = useRef<HTMLButtonElement>(null);
  useEffect(() => yes.current?.focus(), [pad]); // so Delete then Enter deletes, like a y/n prompt
  return (
    <div class="insp-head confirm-delete" role="alertdialog" aria-label="Подтверждение удаления"
      onKeyDown={(e) => { if (e.key === "Escape") confirmDelete.value = null; }}>
      <span class="confirm-text">Удалить <b>{padName(pad)}</b> «{p.name || "без имени"}» с SP? Вернуть будет нельзя.</span>
      <button ref={yes} class="btn btn-danger" onClick={() => deletePad(pad)}><IconTrash /> Удалить</button>
      <button class="btn" onClick={() => (confirmDelete.value = null)}>Отмена</button>
    </div>
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
  const speed = speedOf(pad);
  const sec = (f: number) => (f / RATE).toFixed(2);
  return (
    <>
      <div class="insp-scroll">
      <Section id="sample" title="Сэмпл" summary={channels && total ? `${sec(byteToFrame(p.startByte, channels))}–${sec(byteToFrame(p.endByte, channels))} s из ${sec(total)} s` : undefined}>
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
        {channels ? <RangeEditor pad={pad} channels={channels} wave={wave} /> : <div class="range-editor muted">Start/End: читаю заголовок сэмпла…</div>}
      </Section>

      <Section id="tempo" title="Темп и высота"
        summary={[`${formatBpm(p.bpmX100)} BPM`, speed && `×${speed.ratio.toFixed(2)}`, p.bpmSync && "Sync", p.vinyl ? "Vinyl" : p.vari > 0 && VARI_MODES[p.vari]].filter(Boolean).join(" · ")}>
        <BpmEditor pad={pad} />
        <TempoPitch pad={pad} />
      </Section>

      <Section id="play" title="Воспроизведение"
        summary={[`Level ${p.level}`, p.gate && "Gate", p.loop && "Loop", p.oneShot && "One Shot"].filter(Boolean).join(" · ")}>
        <LevelControl pad={pad} />
        <div class="toggles">
          <Toggle label="Gate" on={p.gate} onChange={(on) => setGate(pad, on)} />
          <Toggle label="Loop" on={p.loop} onChange={(on) => setLoop(pad, on)} />
          <Toggle label="One Shot" on={p.oneShot} onChange={(on) => setOneShot(pad, on)}
            hint="Как в официальном App: при включении One Shot выключаются Gate и Loop" />
        </div>
      </Section>

      <Section id="file" title="Файл"
        summary={[frames !== null && `${sec(frames)} s`, channels && (channels === 1 ? "mono" : "stereo"), `${(p.size / 1048576).toFixed(2)} MB`].filter(Boolean).join(" · ")}>
        <dl class="facts">
          <div><dt>Звучит</dt><dd>{frames !== null ? `${sec(frames)} s` : "—"}</dd></div>
          <div><dt>Весь сэмпл</dt><dd>{total !== null ? `${sec(total)} s` : "—"}</dd></div>
          <div><dt>Каналы</dt><dd>{channels ? (channels === 1 ? "mono" : "stereo") : "—"}</dd></div>
          <div><dt>Размер</dt><dd>{(p.size / 1048576).toFixed(2)} MB</dd></div>
        </dl>
      </Section>

      </div>
      <div class="play-row">
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
        <button
          class="btn btn-stop"
          disabled={!ready || playing.value === null}
          onClick={stopPlaying}
          title={playing.value === null ? "Нечего останавливать" : `Остановить ${padName(playing.value)}: на миг включает Gate, нажимает pad и выключает Gate`}
          aria-label="Стоп"
        >
          <IconStop /> Стоп
        </button>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ accordion

const OPEN_KEY = "nexus404.inspector.open";
const DEFAULT_OPEN = ["sample", "tempo", "play"];

function loadOpen(): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(OPEN_KEY) ?? "null");
    if (Array.isArray(v)) return new Set(v.filter((x) => typeof x === "string"));
  } catch { /* storage blocked or broken: use the default */ }
  return new Set(DEFAULT_OPEN);
}

/** Which inspector sections are open; kept per browser, the same for every pad. */
const openSections = signal(loadOpen());

function toggleSection(id: string): void {
  const next = new Set(openSections.value);
  if (!next.delete(id)) next.add(id);
  openSections.value = next;
  try { localStorage.setItem(OPEN_KEY, JSON.stringify([...next])); } catch { /* not kept: fine */ }
}

/** A collapsible inspector section; a collapsed one shows `summary` in its header. */
function Section({ id, title, summary, children }: { id: string; title: string; summary?: string; children: preact.ComponentChildren }) {
  const open = openSections.value.has(id);
  return (
    <section class={`acc ${open ? "open" : ""}`}>
      <button type="button" class="acc-head" aria-expanded={open} aria-controls={`acc-${id}`} onClick={() => toggleSection(id)}>
        <span class="acc-title">{title}</span>
        {!open && summary && <span class="acc-sum">{summary}</span>}
        <svg class="acc-chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && <div class="acc-body" id={`acc-${id}`}>{children}</div>}
    </section>
  );
}

/** The tempo playing now for this pad (project or its bank, by Tempo Select) and the speed that gives. */
function speedOf(pad: number) {
  const p = pads.value[pad], ps = project.value;
  if (!p || !ps) return null;
  const bank = ps.banks[pad >> 4];
  const useProject = ps.useProjectTempo || !bank;
  const tempo = useProject ? ps.projectTempoX100 : bank.tempoX100;
  return { ...padSpeed(p, tempo), tempo, tempoOf: useProject ? "проекта" : `банка ${bank.letter}` };
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

const parseStretch: Parse = (text) => {
  const t = text.trim().replace(",", ".").replace(/%$/, "").trim();
  if (!t) return null;
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(t)) return { error: "проценты, например 100 или 97.5" };
  const x100 = Math.round(parseFloat(t) * 100);
  return x100 < STRETCH_MIN_X100 || x100 > STRETCH_MAX_X100 ? { error: "от 50 до 150 %" } : { value: x100 };
};
const formatStretch = (x100: number) => (x100 / 100).toFixed(2).replace(/\.?0+$/, "");

const fmtSt = (st: number) => (Math.abs(st) < 0.05 ? "без изменений" : `${st > 0 ? "+" : "−"}${Math.abs(st).toFixed(1)} st`);

/** The speed and pitch the SP plays the pad at, with the tempo playing now. */
function SpeedLine({ pad }: { pad: number }) {
  const s = speedOf(pad);
  if (!s) return null;
  const why = s.source === "stretch"
    ? "по Stretch, BPM Sync выключен"
    : `${formatBpm(s.tempo)} BPM ${s.tempoOf} / ${formatBpm(s.syncedBpmX100)} BPM pad'а`;
  const fold = s.fold > 0 ? `темп pad'а ×${2 ** s.fold}, чтобы уложиться в 150 %`
    : s.fold < 0 ? `темп pad'а ÷${2 ** -s.fold}, чтобы уложиться в 50 %` : null;
  return (
    <div class={`speed ${s.fold ? "folded" : ""}`} title="Расчёт по правилам, проверенным на SP: BPM Sync держит скорость в 50–150 %">
      <b>×{s.ratio.toFixed(2)}</b>
      <span>{why}</span>
      {fold && <span class="fold">{fold}</span>}
      <span class="pitch">высота {fmtSt(s.pitchSt)}</span>
    </div>
  );
}

/** How the pad follows tempo changes, and its pitch (Pitch is greyed out with Vinyl on, as in the official app). */
function TempoPitch({ pad }: { pad: number }) {
  const p = pads.value[pad]!;
  const pitchOff = p.vinyl ? "Pitch меняется при выключенном Vinyl" : null;
  return (
    <div class="tempo-pitch">
      <div class="toggles">
        <Toggle label="BPM Sync" on={p.bpmSync} onChange={(on) => setBpmSync(pad, on)} hint="Сэмпл следует темпу банка или проекта" />
        <Toggle label="Vinyl" on={p.vinyl} onChange={(on) => setVinyl(pad, on)} hint="Смена темпа меняет и высоту, как у пластинки; без Vinyl высота сохраняется" />
      </div>
      <SpeedLine pad={pad} />
      <VariControl pad={pad} />
      <div class="tp-row">
        <span>Stretch</span>
        <ValueField value={p.timeStretchX100} format={formatStretch} parse={parseStretch} label="Time Stretch" width={64}
          onSave={(v) => setTimeStretch(pad, v)} />
        <span class="unit">%</span>
        <span class="note">скорость, 50–150, по умолчанию 100</span>
      </div>
      <div class="tp-row">
        <span>Pitch</span>
        <ValueField value={p.pitchCoarse} format={signed} parse={intIn(-PITCH_COARSE_MAX, PITCH_COARSE_MAX)} label="Pitch, полутоны" width={52}
          disabled={pitchOff} dim={p.vinyl} onSave={(v) => setPitch(pad, v, p.pitchFine)} />
        <span class="unit">st</span>
        <ValueField value={p.pitchFine} format={signed} parse={intIn(-PITCH_FINE_MAX, PITCH_FINE_MAX)} label="Pitch, центы" width={58}
          disabled={pitchOff} dim={p.vinyl} onSave={(v) => setPitch(pad, p.pitchCoarse, v)} />
        <span class="unit">ct</span>
        {pitchOff && <span class="note">{pitchOff}</span>}
      </div>
    </div>
  );
}

/** What each VARI MODE suits, after the Roland manual: Roland's names alone say little. */
const VARI_HINTS = ["Обычный алгоритм; на сильном растяжении больше артефактов", "Drums / rhythmic: звуки с атакой и затуханием", "Sustained / tonal: пэды, струнные, хор"];

/** Time-stretch algorithm; the SP offers it only with Vinyl off. */
function VariControl({ pad }: { pad: number }) {
  const p = pads.value[pad]!;
  const [busy, setBusy] = useState(false);
  const blocked = writeBlockReason.value ?? (p.vinyl ? "VARI MODE работает при выключенном Vinyl" : null);
  const pick = async (mode: number) => {
    if (mode === p.vari || busy) return;
    setBusy(true);
    await setVari(pad, mode);
    setBusy(false);
  };
  return (
    <div class="tp-row">
      <span>VARI</span>
      <span class={`segmented${p.vinyl ? " muted" : ""}`} role="group" aria-label="VARI MODE" title={blocked ?? "Алгоритм time-stretch (VARI MODE)"}>
        {VARI_MODES.map((name, i) => (
          <button key={name} type="button" aria-pressed={p.vari === i} class={p.vari === i ? "on" : ""} title={VARI_HINTS[i]}
            disabled={!!blocked || busy} onClick={() => pick(i)}>{name}</button>
        ))}
      </span>
      <span class="note">{p.vinyl ? "работает при выключенном Vinyl" : VARI_HINTS[p.vari] ?? `неизвестное значение ${p.vari}`}</span>
    </div>
  );
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
  const [detect, setDetect] = useState<{ busy: boolean; note: string | null }>({ busy: false, note: null });
  const inputRef = useRef<HTMLInputElement>(null);
  const shownPad = useRef(pad);
  shownPad.current = pad;
  useEffect(() => { setText(saved); setState("idle"); }, [pad, p.bpmX100]);
  useEffect(() => setDetect({ busy: false, note: null }), [pad]);
  const canDetect = conn.value === "ready" || !!waveforms.value.get(pad)?.samples;

  const runDetect = async () => {
    setDetect({ busy: true, note: null });
    const r = await detectPadBpm(pad);
    if (shownPad.current !== pad) return; // another pad is shown by now
    if (r) setText(formatBpm(r.x100));
    setDetect({
      busy: false,
      note: r === undefined ? "Не удалось прочитать сэмпл"
        : r === null ? "Чёткого ритма не нашлось — задайте BPM вручную"
        : `Найдено ${formatBpm(r.x100)}${r.beats ? ` · луп ровно ${r.beats} долей` : ""}${r.clarity < 0.4 ? " · ритм нечёткий, проверьте на слух" : ""}`,
    });
  };

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
      <div class="trim">
        <button class="btn" disabled={detect.busy || !canDetect} onClick={runDetect}
          title="Определить темп по звуку между Start и End, как BPM SET AUTO на SP; результат попадёт в поле, записывается кнопкой «Сохранить»">
          {detect.busy ? "Анализ…" : "Определить"}
        </button>
        <label title="Темп сворачивается в этот диапазон удвоением или делением, как на SP">
          <span>диапазон</span>
          <select value={bpmRange.value} onChange={(e) => (bpmRange.value = +(e.target as HTMLSelectElement).value)}>
            {BPM_RANGES.map(([a, b], i) => <option value={i}>{a}–{b}</option>)}
          </select>
        </label>
        {detect.note && <span class="muted">{detect.note}</span>}
      </div>
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
