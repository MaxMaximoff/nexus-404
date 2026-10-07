import { signal } from "@preact/signals";
import { useEffect, useRef, useState } from "preact/hooks";
import {
  BALANCE_CENTRE, BPM_MAX_X100, BPM_MIN_X100, BPM_RANGES, LEVEL_MAX, PARAM_ATTACK, PARAM_BALANCE, PARAM_BUS_FX, PARAM_HOLD, PARAM_MUTE_GROUP, PARAM_PAD_LINK,
  PARAM_PLAY_MODE, PARAM_RELEASE, PARAM_ROLL, PLAY_MODES, bpmFromLength, PITCH_COARSE_MAX, PITCH_FINE_MAX, STRETCH_MAX_X100, STRETCH_MIN_X100, VARI_MODES, byteToFrame, findSound, formatBpm, padName, padSpeed,
  parseBpmInput,
} from "../sp404";
import {
  bpmRange, channelsOf, confirmDelete, conn, deletePad, detectPadBpm, importFiles, loadWaveform, pads, playing, preview, project, selectedPad, setBpm, setBpmSync, setGate, setLevel, setLoop, setFixedVelocity, setOneShot, setPadParam, setPitch, setTimeStretch, setVari, setVinyl,
  setRange, stopPlaying, waveLoading, waveforms, writeBlockReason, editGroup, pickedList,
} from "./store";
import type { PadBlock } from "../sp404";
import { Waveform, type Range } from "./Waveform";
import type { Waveform as Wave } from "./store";
import { ValueField, intIn, signed, type Parse } from "./ValueField";
import { IconCheck, IconPlay, IconStop, IconTrash, IconUpload, IconWave } from "./icons";

const RATE = 48000;
const TRIM_THRESHOLDS = [-60, -48, -36, -24];
/** Silence threshold for "Убрать тишину", dBFS; kept while switching pads. */
const trimDb = signal(-36);

export function Inspector() {
  if (pickedList.value.length > 1) return <GroupInspector />;
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
        summary={[`Level ${p.level}`, p.balance !== BALANCE_CENTRE && `Balance ${fmtBalance(p.balance)}`, p.gate && "Gate", p.loop && "Loop", p.oneShot && "One Shot",
          p.fixedVelocity && "Fixed Vel", p.playMode && PLAY_MODES[p.playMode]].filter(Boolean).join(" · ")}>
        <Slider pad={pad} label="Level" value={p.level} min={0} max={LEVEL_MAX} commit={(v) => setLevel(pad, v)} />
        <Slider pad={pad} label="Balance" value={p.balance} min={13} max={115} show={fmtBalance} centre={BALANCE_CENTRE}
          commit={(v) => setPadParam(pad, PARAM_BALANCE, v, `Balance ${fmtBalance(v)}`)}
          hint="Баланс стерео: громкость левого и правого канала (L51 … C … R51); двойной клик — в центр. На моно-сэмпл не действует (проверено на SP)" />
        {channels === 1 && <span class="note slider-note">Моно-сэмпл: Balance на него не действует</span>}
        <div class="toggles">
          <Toggle label="Gate" on={p.gate} onChange={(on) => setGate(pad, on)} />
          <Toggle label="Loop" on={p.loop} onChange={(on) => setLoop(pad, on)} />
          <Toggle label="One Shot" on={p.oneShot} onChange={(on) => setOneShot(pad, on)}
            hint="Как в официальном App: при включении One Shot выключаются Gate и Loop" />
          <Toggle label="Fixed Velocity" on={p.fixedVelocity} onChange={(on) => setFixedVelocity(pad, on)}
            hint="Громкость не зависит от силы удара по pad'у" />
        </div>
        <Choice label="Play" value={p.playMode} options={PLAY_MODES.map((n, i) => [i, n])} kind="segmented"
          pick={(v) => setPadParam(pad, PARAM_PLAY_MODE, v, `Play Mode ${PLAY_MODES[v]}`)} hint="Направление воспроизведения" />
      </Section>

      <Section id="ahr" title="Огибающая" summary={`A ${p.attack} · H ${p.hold} · R ${p.release}`}>
        <Slider pad={pad} label="Attack" value={p.attack} min={0} max={127} commit={(v) => setPadParam(pad, PARAM_ATTACK, v, `Attack ${v}`)} hint="Нарастание в начале" />
        <Slider pad={pad} label="Hold" value={p.hold} min={1} max={100} commit={(v) => setPadParam(pad, PARAM_HOLD, v, `Hold ${v}`)} hint="Сколько держится полная громкость" />
        <Slider pad={pad} label="Release" value={p.release} min={0} max={127} commit={(v) => setPadParam(pad, PARAM_RELEASE, v, `Release ${v}`)} hint="Затухание в конце" />
      </Section>

      <Section id="mix" title="Микс"
        summary={[p.muteGroup && `Mute ${OFF_A_J[p.muteGroup]?.[1] ?? p.muteGroup}`, p.padLink && `Link ${OFF_A_J[p.padLink]?.[1] ?? p.padLink}`, BUS_FX[p.busFx] ?? `BUS ${p.busFx}`, `Roll ${ROLL[p.roll] ?? p.roll}`].filter(Boolean).join(" · ")}>
        <Choice label="Mute Group" value={p.muteGroup} options={OFF_A_J} pick={(v) => setPadParam(pad, PARAM_MUTE_GROUP, v, `Mute Group ${OFF_A_J[v][1]}`)}
          hint="Pad'ы одной группы глушат друг друга" />
        <Choice label="PAD Link" value={p.padLink} options={OFF_A_J} pick={(v) => setPadParam(pad, PARAM_PAD_LINK, v, `PAD Link ${OFF_A_J[v][1]}`)}
          hint="Pad'ы одной группы звучат вместе" />
        <Choice label="BUS FX" value={p.busFx} options={BUS_FX.map((n, i) => [i, n])} kind="segmented"
          pick={(v) => setPadParam(pad, PARAM_BUS_FX, v, `BUS FX ${BUS_FX[v]}`)} hint="Через какую шину эффектов идёт pad" />
        <Choice label="Roll" value={p.roll} options={ROLL.map((n, i) => [i, n])} pick={(v) => setPadParam(pad, PARAM_ROLL, v, `Roll ${ROLL[v]}`)}
          hint="Шаг повтора при Roll" />
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
function Toggle({ label, on, mixed, hint, onChange }: { label: string; on: boolean; mixed?: boolean; hint?: string; onChange: (on: boolean) => Promise<boolean> }) {
  const [busy, setBusy] = useState(false);
  const blocked = writeBlockReason.value;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={mixed ? "mixed" : on}
      class={`toggle ${on ? "on" : ""} ${mixed ? "mixed" : ""} ${busy ? "busy" : ""}`}
      disabled={!!blocked || busy}
      title={blocked ?? hint}
      onClick={async () => {
        setBusy(true);
        await onChange(mixed ? true : !on); // mixed: switch them all on
        setBusy(false);
      }}
    >
      <span class="knob" aria-hidden="true" />
      {label}
    </button>
  );
}

const fmtBalance = (v: number) => (v === BALANCE_CENTRE ? "C" : v < BALANCE_CENTRE ? `L${BALANCE_CENTRE - v}` : `R${v - BALANCE_CENTRE}`);
/** Mute Group and PAD Link groups are lettered A–J (1–10 on the wire). */
const OFF_A_J: [number, string][] = Array.from({ length: 11 }, (_, i) => [i, i ? "ABCDEFGHIJ"[i - 1] : "Off"]);
// Labels from SparkyMK2: only BUS 1 = 1 and Roll 2 = 1/4 are confirmed there. To be checked against the official app.
const BUS_FX = ["Off", "BUS 1", "BUS 2"];
const ROLL = Array.from({ length: 11 }, (_, i) => (i === 2 ? "1/4" : String(i)));

/**
 * A parameter slider: shows the value while dragging, writes once on release (or per arrow key).
 * With `centre`, the fill grows from the centre and a double click returns there.
 */
function Slider({ pad, label, value: saved, min, max, show = String, centre, hint, mixed, commit }: {
  pad: number; label: string; value: number; min: number; max: number; show?: (v: number) => string; centre?: number; hint?: string;
  mixed?: boolean; commit: (v: number) => Promise<boolean>;
}) {
  const [value, setValue] = useState(saved);
  const [busy, setBusy] = useState(false);
  useEffect(() => setValue(saved), [pad, saved]);
  const blocked = writeBlockReason.value;
  const id = `slider-${label.toLowerCase()}`;
  const [touched, setTouched] = useState(false);
  useEffect(() => setTouched(false), [pad, saved, mixed]);
  const write = async (v: number) => {
    if (v === saved && !mixed) return;
    setValue(v);
    setBusy(true);
    if (!(await commit(v))) setValue(saved);
    setBusy(false);
  };
  const at = (v: number) => ((v - min) / (max - min)) * 100;
  const fill = centre === undefined ? { "--fill": `${at(value)}%` }
    : { "--from": `${Math.min(at(value), at(centre))}%`, "--to": `${Math.max(at(value), at(centre))}%` };
  return (
    <div class={`level ${busy ? "busy" : ""} ${centre !== undefined ? "centred" : ""}`} title={blocked ?? hint}>
      <label for={id}>{label}</label>
      <input id={id} type="range" min={min} max={max} step={1} value={value} disabled={!!blocked} style={fill}
        onInput={(e) => { setTouched(true); setValue(+(e.target as HTMLInputElement).value); }}
        onChange={(e) => write(+(e.target as HTMLInputElement).value)}
        onDblClick={() => centre !== undefined && write(centre)} />
      <output for={id}>{mixed && !touched ? "разн." : show(value)}</output>
    </div>
  );
}

/** Pick one of a few values: a dropdown, or a segmented control for short lists; written on pick. */
function Choice({ label, value, options, kind = "select", hint, mixed, disabled, pick }: {
  label: string; value: number; options: [number, string][]; kind?: "select" | "segmented"; hint?: string; mixed?: boolean; disabled?: string | null;
  pick: (v: number) => Promise<boolean>;
}) {
  const [busy, setBusy] = useState(false);
  const blocked = writeBlockReason.value ?? disabled ?? null;
  const run = async (v: number) => {
    if ((v === value && !mixed) || busy) return;
    setBusy(true);
    await pick(v);
    setBusy(false);
  };
  const known = mixed || options.some(([v]) => v === value);
  return (
    <div class="tp-row choice" title={blocked ?? hint}>
      <span>{label}</span>
      {kind === "segmented" ? (
        <span class="segmented" role="group" aria-label={label}>
          {options.map(([v, name]) => (
            <button key={v} type="button" aria-pressed={!mixed && v === value} class={!mixed && v === value ? "on" : ""} disabled={!!blocked || busy} onClick={() => run(v)}>{name}</button>
          ))}
        </span>
      ) : (
        <select value={mixed ? -1 : value} disabled={!!blocked || busy} aria-label={label} onChange={(e) => run(+(e.target as HTMLSelectElement).value)}>
          {mixed && <option value={-1}>разные</option>}
          {!known && <option value={value}>{value} ?</option>}
          {options.map(([v, name]) => <option key={v} value={v}>{name}</option>)}
        </select>
      )}
      {!known && kind === "segmented" && <span class="note">неизвестное значение {value}</span>}
      {mixed && kind === "segmented" && <span class="note">у pad'ов разные</span>}
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

// ------------------------------------------------------------------ several pads

/**
 * Several picked pads: the settings that make sense for a group, written to every picked pad.
 * A setting the pads don't share shows as "разные"; Start/End, the wave and the name stay per pad.
 */
function GroupInspector() {
  const list = pickedList.value;
  const blocks = list.map((i) => pads.value[i]!);
  const anchor = list.includes(selectedPad.value) ? selectedPad.value : list[0];
  /** The value all picked pads share, or null when they differ. */
  const same = <T,>(get: (b: PadBlock) => T): T | null => (blocks.every((b) => get(b) === get(blocks[0])) ? get(blocks[0]) : null);
  const num = (get: (b: PadBlock) => number) => same(get) ?? Number.NaN;
  const toggle = (label: string, get: (b: PadBlock) => boolean, set: (d: Dev, p1: number, pad: number, on: boolean) => Promise<PadBlock>, hint?: string) => {
    const v = same(get);
    return <Toggle label={label} on={v === true} mixed={v === null} hint={hint}
      onChange={(on) => editGroup(`${label} ${on ? "вкл" : "выкл"}`, (d, p1, pad) => set(d, p1, pad, on), (b) => get(b) === on)} />;
  };
  const param = (id: number, what: (v: number) => string, get: (b: PadBlock) => number) => (v: number) =>
    editGroup(what(v), (d, p1, pad) => d.setPadParam(p1, pad, id, v), (b) => get(b) === v);
  const anyVinyl = blocks.some((b) => b.vinyl);
  const playMode = same((b) => b.playMode), vari = same((b) => b.vari), bus = same((b) => b.busFx);
  const mute = same((b) => b.muteGroup), link = same((b) => b.padLink), roll = same((b) => b.roll);
  return (
    <aside class="inspector glass">
      <div class="insp-head">
        <span class="chip chip-accent">{list.length}</span>
        <span class="insp-name" title={list.map(padName).join(", ")}>Выбрано: {list.map(padName).join(", ")}</span>
      </div>
      <div class="insp-scroll">
        <p class="group-note">Изменения записываются во все выбранные pad'ы. Start/End, волна и имя — по одному pad'у: снимите выделение (Esc).</p>

        <Section id="tempo" title="Темп и высота">
          <div class="tempo-pitch">
            <div class="tp-row">
              <span>BPM</span>
              <ValueField value={num((b) => b.bpmX100)} format={formatBpm} parse={parseBpmField} label="BPM" width={84} placeholder="разные"
                onSave={(v) => editGroup(`BPM ${formatBpm(v)}`, (d, p1, pad) => d.setBpm(p1, pad, v), (b) => b.bpmX100 === v)} />
              <span class="note">40–200, Enter — записать во все</span>
            </div>
            <div class="toggles">
              {toggle("BPM Sync", (b) => b.bpmSync, (d, p1, pad, on) => d.setBpmSync(p1, pad, on), "Сэмплы следуют темпу банка или проекта")}
              {toggle("Vinyl", (b) => b.vinyl, (d, p1, pad, on) => d.setVinyl(p1, pad, on), "Смена темпа меняет и высоту, как у пластинки")}
            </div>
            <Choice label="VARI" value={vari ?? -1} mixed={vari === null} kind="segmented" options={VARI_MODES.map((n, i) => [i, n])}
              disabled={anyVinyl ? "VARI MODE работает при выключенном Vinyl — у части pad'ов Vinyl включён" : null}
              pick={(v) => editGroup(`VARI MODE ${VARI_MODES[v]}`, (d, p1, pad) => d.setVari(p1, pad, v), (b) => b.vari === v)} />
            <div class="tp-row">
              <span>Stretch</span>
              <ValueField value={num((b) => b.timeStretchX100)} format={formatStretch} parse={parseStretch} label="Time Stretch" width={64} placeholder="разн."
                onSave={(v) => editGroup(`Time Stretch ${formatStretch(v)} %`, (d, p1, pad) => d.setTimeStretch(p1, pad, v), (b) => b.timeStretchX100 === v)} />
              <span class="unit">%</span>
            </div>
            <div class="tp-row">
              <span>Pitch</span>
              <ValueField value={num((b) => b.pitchCoarse)} format={signed} parse={intIn(-PITCH_COARSE_MAX, PITCH_COARSE_MAX)} label="Pitch, полутоны" width={52} placeholder="разн."
                disabled={anyVinyl ? "Pitch меняется при выключенном Vinyl" : null}
                onSave={(v) => editGroup(`Pitch ${signed(v)} st`, (d, p1, pad) => d.setPitch(p1, pad, v, pads.value[pad]!.pitchFine), (b) => b.pitchCoarse === v)} />
              <span class="unit">st</span>
              <ValueField value={num((b) => b.pitchFine)} format={signed} parse={intIn(-PITCH_FINE_MAX, PITCH_FINE_MAX)} label="Pitch, центы" width={58} placeholder="разн."
                disabled={anyVinyl ? "Pitch меняется при выключенном Vinyl" : null}
                onSave={(v) => editGroup(`Pitch ${signed(v)} ct`, (d, p1, pad) => d.setPitch(p1, pad, pads.value[pad]!.pitchCoarse, v), (b) => b.pitchFine === v)} />
              <span class="unit">ct</span>
              {anyVinyl && <span class="note">при выключенном Vinyl</span>}
            </div>
          </div>
        </Section>

        <Section id="play" title="Воспроизведение">
          <Slider pad={anchor} label="Level" value={same((b) => b.level) ?? blocks[0].level} mixed={same((b) => b.level) === null} min={0} max={LEVEL_MAX}
            commit={(v) => editGroup(`Level ${v}`, (d, p1, pad) => d.setLevel(p1, pad, v), (b) => b.level === v)} />
          <Slider pad={anchor} label="Balance" value={same((b) => b.balance) ?? BALANCE_CENTRE} mixed={same((b) => b.balance) === null} min={13} max={115}
            show={fmtBalance} centre={BALANCE_CENTRE} hint="Баланс стерео; на моно-сэмплы не действует"
            commit={param(PARAM_BALANCE, (v) => `Balance ${fmtBalance(v)}`, (b) => b.balance)} />
          <div class="toggles">
            {toggle("Gate", (b) => b.gate, (d, p1, pad, on) => d.setGate(p1, pad, on))}
            {toggle("Loop", (b) => b.loop, (d, p1, pad, on) => d.setLoop(p1, pad, on))}
            {toggle("One Shot", (b) => b.oneShot, (d, p1, pad, on) => d.setOneShot(p1, pad, on), "При включении One Shot выключаются Gate и Loop")}
            {toggle("Fixed Velocity", (b) => b.fixedVelocity, (d, p1, pad, on) => d.setFixedVelocity(p1, pad, on))}
          </div>
          <Choice label="Play" value={playMode ?? -1} mixed={playMode === null} options={PLAY_MODES.map((n, i) => [i, n])} kind="segmented"
            pick={param(PARAM_PLAY_MODE, (v) => `Play Mode ${PLAY_MODES[v]}`, (b) => b.playMode)} />
        </Section>

        <Section id="ahr" title="Огибающая">
          {([["Attack", PARAM_ATTACK, 0, 127, (b: PadBlock) => b.attack], ["Hold", PARAM_HOLD, 1, 100, (b: PadBlock) => b.hold],
            ["Release", PARAM_RELEASE, 0, 127, (b: PadBlock) => b.release]] as const).map(([label, id, min, max, get]) => (
            <Slider key={label} pad={anchor} label={label} value={same(get) ?? get(blocks[0])} mixed={same(get) === null} min={min} max={max}
              commit={param(id, (v) => `${label} ${v}`, get)} />
          ))}
        </Section>

        <Section id="mix" title="Микс">
          <Choice label="Mute Group" value={mute ?? -1} mixed={mute === null} options={OFF_A_J}
            pick={param(PARAM_MUTE_GROUP, (v) => `Mute Group ${OFF_A_J[v][1]}`, (b) => b.muteGroup)} />
          <Choice label="PAD Link" value={link ?? -1} mixed={link === null} options={OFF_A_J}
            pick={param(PARAM_PAD_LINK, (v) => `PAD Link ${OFF_A_J[v][1]}`, (b) => b.padLink)} />
          <Choice label="BUS FX" value={bus ?? -1} mixed={bus === null} options={BUS_FX.map((n, i) => [i, n])} kind="segmented"
            pick={param(PARAM_BUS_FX, (v) => `BUS FX ${BUS_FX[v]}`, (b) => b.busFx)} />
          <Choice label="Roll" value={roll ?? -1} mixed={roll === null} options={ROLL.map((n, i) => [i, n])}
            pick={param(PARAM_ROLL, (v) => `Roll ${ROLL[v]}`, (b) => b.roll)} />
        </Section>
      </div>
    </aside>
  );
}

type Dev = Parameters<Parameters<typeof editGroup>[1]>[0];

const parseBpmField: Parse = (text) => {
  const r = parseBpmInput(text);
  return !r ? null : "error" in r ? { error: r.error } : { value: r.x100 };
};

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
  const ch = channelsOf(pad);

  // "Set BPM by St/End", as the official app: whole beats between Start and End, nearest to the pad's BPM.
  const byRange = () => {
    if (!ch) return;
    const frames = byteToFrame(p.endByte, ch) - byteToFrame(p.startByte, ch);
    const r = bpmFromLength(frames, p.bpmX100);
    if (!r) return setDetect({ busy: false, note: "Слишком короткий участок" });
    const beats = r.beats >= 1 ? String(r.beats) : `1/${1 / r.beats}`;
    if (r.x100 < BPM_MIN_X100 || r.x100 > BPM_MAX_X100) return setDetect({ busy: false, note: `Выходит ${formatBpm(r.x100)} (${beats} долей) — вне 40–200` });
    setText(formatBpm(r.x100));
    setDetect({ busy: false, note: `Start–End = ${beats} долей при ${formatBpm(r.x100)} BPM` });
  };

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
        <button class="btn" disabled={!ch} onClick={byRange}
          title={ch ? "BPM, при котором между Start и End целое число долей (ближайшее к текущему BPM), как «Set BPM by St/End» в App; записывается кнопкой «Сохранить»"
            : "Нужен заголовок сэмпла: откройте секцию «Сэмпл»"}>
          По Start/End
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
