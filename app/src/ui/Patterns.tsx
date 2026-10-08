// Patterns of the current project: the 160 slots, and a pattern as a step grid (pads as rows,
// 1/16 steps as columns). Notes off the grid (played live) are drawn where they are, not snapped to
// a step. "Править" opens the editor (PatternEditor.tsx) on a draft; nothing is written to the SP.

import { computed, effect, signal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import { BANKS, PPQ, decodeAudio, formatBpm, noteSemitones, padName, patternFileName, type Pattern, type PatternNote } from "../sp404";
import {
  bouncePattern, bouncing, conn, downloadPatternMidi, emptyPattern, log, notice, patternFiles, patterns, patternsLoading, patternsOf, pads, project1,
  refreshPatterns, selectPad, selectedBank, selectedPad, tempoFor, writeBlockReason,
} from "./store";
import { IconDownload, IconPencil, IconPlay, IconRefresh, IconStop, IconWave } from "./icons";
import { midiState } from "./midi";
import { playingSlot, stopPattern, togglePattern } from "./ptnPlayer";
import { RowSound, silentClass } from "./PatternRowSound";
import { PatternEditor, SaveControl } from "./PatternEditor";
import { Pager, pagingOf } from "./PatternPager";
import { NEW_SLOT, draftOf, dropDraft, drafts, editingSlot, fileSum, isDirty, pick, revert, startDraft } from "./patternDraft";
import { TakeCard } from "./Recorder";
import { recTake, setTake } from "./rec";
import { saveFile } from "./download";
import { showSide } from "./card";

const VIEW_KEY = "nexus404.main.view";
type View = "pads" | "patterns";
function savedView(): View {
  try { return localStorage.getItem(VIEW_KEY) === "patterns" ? "patterns" : "pads"; } catch { return "pads"; }
}
/** What the left column shows: banks and pads, or the patterns. */
export const mainView = signal<View>(savedView());
// Playing stops when the patterns leave the screen or the SP goes away.
effect(() => { if (mainView.value !== "patterns" || (conn.value !== "ready" && conn.value !== "loading")) stopPattern(); });

export function showView(v: View): void {
  mainView.value = v;
  try { localStorage.setItem(VIEW_KEY, v); } catch { /* not kept: fine */ }
}

/** The slot picked in the matrix; the first pattern of the project when it has none there. */
const pickedSlot = signal<number | null>(null);
export const shownSlot = computed(() => {
  const m = patterns.value, s = pickedSlot.value;
  if (!m) return null;
  // An empty slot shows too when picked: a new pattern is made there.
  if (s !== null) return s;
  return m.size ? [...m.keys()][0] : null;
});
/** Back from a pattern to one of its pads: the pads screen, that pad in the inspector. */
export function openPad(pad: number): void {
  selectPad(pad);
  showSide("pad");
  showView("pads");
}

export function openPattern(slot: number): void {
  pickedSlot.value = slot;
  showView("patterns");
}

const signed = (v: number) => (v > 0 ? `+${v}` : `−${-v}`);

/** One step of the grid: a sixteenth note. */
const STEP = PPQ / 4;

export function PatternsPane() {
  const m = patterns.value, c = conn.value;
  return (
    <section class="ptn-area glass">
      <div class="ptn-head">
        <div class="panel-title">Паттерны</div>
        <span class="muted small">{m ? `${m.size} из 160` : ""}</span>
        {c === "ready" && (
          <button class="btn btn-ghost" onClick={() => void refreshPatterns()} disabled={patternsLoading.value} title="Перечитать паттерны с SP (после записи на SP)">
            <IconRefresh /> {patternsLoading.value ? "Читаю…" : "Обновить"}
          </button>
        )}
      </div>
      {!m ? (
        <p class="muted ptn-empty">{c === "ready" || c === "loading" ? "Читаю паттерны…" : "Подключите SP, чтобы увидеть паттерны проекта."}</p>
      ) : (
        <>
          <SlotMatrix />
          {shownSlot.value !== null ? <PatternView /> : <p class="muted ptn-empty">В проекте нет паттернов. Выберите слот выше, чтобы создать паттерн, или запишите его на SP и нажмите «Обновить».</p>}
        </>
      )}
    </section>
  );
}

/** All 160 slots, a row per bank: which hold a pattern, and which play the selected pad. */
function SlotMatrix() {
  const m = patterns.value!, shown = shownSlot.value, sel = selectedPad.value;
  const ofSel = new Set(pads.value[sel]?.size ? patternsOf(sel) : []);
  return (
    <div class="ptn-matrix" role="grid" aria-label="Слоты паттернов">
      {[...BANKS].map((letter, b) => (
        <div class="ptn-mrow" role="row" key={letter}>
          <span class="ptn-mbank">{letter}</span>
          {Array.from({ length: 16 }, (_, i) => {
            const slot = b * 16 + i, p = m.get(slot);
            const edited = drafts.value.get(slot);
            const cls = ["ptn-slot", p !== undefined && (typeof p === "string" ? "bad" : "on"), slot === shown && "cur", ofSel.has(slot) && "uses", edited && isDirty(edited) && "edited"].filter(Boolean).join(" ");
            const title = p === undefined ? `${padName(slot)}: пусто`
              : typeof p === "string" ? `${padName(slot)}: не прочитан — ${p}`
              : `${padName(slot)}: ${p.bars} ${bars(p.bars)}, ${p.notes.length} нот${ofSel.has(slot) ? ` · играет ${padName(sel)}` : ""}${edited && isDirty(edited) ? " · есть правки" : ""}`;
            return <button key={slot} role="gridcell" class={`${cls} ${p === undefined ? "empty" : ""}`} title={p === undefined ? `${padName(slot)}: пусто — создать паттерн` : title} aria-label={title} onClick={() => (pickedSlot.value = slot)}>{i + 1}</button>;
          })}
        </div>
      ))}
    </div>
  );
}

const bars = (n: number) => (n % 10 === 1 && n % 100 !== 11 ? "такт" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? "такта" : "тактов");

function PatternView() {
  const slot = shownSlot.value!, read = patterns.value!.get(slot), d = draftOf(slot);
  if (typeof read === "string") return <p class="err ptn-empty">{padName(slot)}: файл паттерна не прочитан — {read}</p>;
  if (!read && !d) return <NewPattern slot={slot} />;
  const base = read ?? d!.base, isNew = !read;
  const p = d?.p ?? base, dirty = !!d && isDirty(d), editing = editingSlot.value === slot;
  const t = tempoFor(slot >> 4);
  const rows = [...new Set(p.notes.map((n) => n.pad))].sort((a, b) => a - b);
  // TR-REC sub-steps sit between steps on purpose: only notes played live count as off the grid.
  const offGrid = p.notes.filter((n) => n.tick % STEP && noteSemitones(n) === null).length;
  const pitched = p.notes.some((n) => noteSemitones(n));
  // Space plays and stops (not while a field or a button has the focus: they use it themselves).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.ctrlKey || e.metaKey || e.altKey || mainView.value !== "patterns") return;
      if ((e.target as HTMLElement | null)?.closest?.("input, textarea, select, button, [contenteditable]")) return;
      e.preventDefault();
      void togglePattern(slot);
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); if (playingSlot.peek() === slot) stopPattern(); };
  }, [slot]);
  const playing = playingSlot.value === slot, midi = midiState.value === "ready";
  const toggleEdit = () => {
    if (editing) { editingSlot.value = null; if (d && !dirty) dropDraft(slot); return; }
    const f = patternFiles.value.get(slot);
    startDraft(slot, base, isNew ? NEW_SLOT : f ? fileSum(f.bytes) : undefined);
    editingSlot.value = slot;
  };
  return (
    <div class="ptn-view">
      <div class="ptn-info">
        <span class="chip chip-accent">{padName(slot)}</span>
        <button class={`btn ptn-play ${playing ? "card-toggle on" : ""}`} onClick={() => void togglePattern(slot)} aria-pressed={playing}
          title={`${playing ? "Остановить" : "Играть по кругу"} (пробел): ноты уходят на SP по MIDI${dirty ? ", с вашими правками" : ""}${midi ? "" : ". Сейчас MIDI-порта SP нет — будет идти только курсор"}. Транспонирование нот TR-REC не играется`}>
          {playing ? <IconStop /> : <IconPlay />} {playing ? "Стоп" : "Играть"}
        </button>
        <span>{p.bars} {bars(p.bars)} · {p.beatsPerBar}/4 · {p.notes.length} нот · {rows.length} pad'ов{t ? ` · ${formatBpm(t.tempoX100)} BPM ${t.of}` : ""}</span>
        {offGrid > 0 && !editing && <span class="chip" title="Ноты, сыгранные вживую мимо шагов 1/16. Показаны там, где они есть. Sub-step из TR-REC сюда не входят">вне сетки 1/16: {offGrid}</span>}
        {isNew && <span class="chip chip-warn" title="Этого паттерна на SP ещё нет: он появится после сохранения">новый</span>}
        {dirty && !isNew && <span class="chip chip-warn" title="Правки лежат в браузере: «Сохранить на SP» запишет их">изменён</span>}
        <button class={`btn ptn-edit-toggle ${editing ? "card-toggle on" : ""}`} onClick={toggleEdit} aria-pressed={editing}
          title={editing ? "Закрыть редактор: правки остаются в браузере" : "Править паттерн: правки остаются в браузере, на SP они не пишутся"}>
          <IconPencil /> {editing ? "Готово" : "Править"}
        </button>
        <button class="icon-btn insp-dl" onClick={() => downloadPatternMidi(slot)}
          title={`Скачать как MIDI-файл, как экспорт SP: канал = банк, A13 = нота 36${dirty ? "; с вашими правками" : ""}${t ? `; темп ${formatBpm(t.tempoX100)} — тот, что играет сейчас` : ""}`}><IconDownload /> MIDI</button>
        {patternFiles.value.has(slot) && (
          <button class="icon-btn insp-dl ptn-bin" title="Скачать файл паттерна, как он лежит на SP (.BIN, без правок)"
            onClick={() => saveFile(`Proj${project1.value}_${patternFileName(slot)}`, Uint8Array.from(patternFiles.value.get(slot)!.bytes), "application/octet-stream")}><IconDownload /> BIN</button>
        )}
      </div>
      {editing ? <PatternEditor slot={slot} /> : <StepGrid slot={slot} p={p} rows={rows} />}
      {dirty || isNew ? (
        <div class="ptn-dirty-row">
          {!editing && <SaveControl slot={slot} />}
          <span class="muted small">Bounce играет паттерн таким, как он на SP: правки в нём не слышны, пока не сохранены.</span>
          {!editing && <button class="btn btn-ghost ptn-revert" onClick={() => revert(slot)}>сбросить правки</button>}
        </div>
      ) : (
        <Bounce slot={slot} p={base} />
      )}
      {!editing && <p class="hint">Строки — pad'ы, которые играет паттерн; клик по номеру pad'а (A1) открывает его сэмпл, по названию — выбирает pad: в матрице выше видно, в каких ещё паттернах он играет. Столбцы — шаги 1/16, высота заливки ноты — сила удара{pitched ? ", цветные с «+1», «−2» — ноты, транспонированные в TR-REC" : ""}. «Править» открывает редактор.</p>}
    </div>
  );
}

/** An empty slot: make a new pattern there, 1, 2 or 4 bars long, and open the editor on it. */
function NewPattern({ slot }: { slot: number }) {
  const create = (bars: number) => {
    startDraft(slot, emptyPattern(bars), NEW_SLOT);
    // Rows to start with: the loaded pads of the slot's own bank (A5 → bank A), else of the bank open now.
    const of = (bank: number) => Array.from({ length: 16 }, (_, i) => bank * 16 + i).filter((i) => pads.value[i]?.size);
    const rows = of(slot >> 4).length ? of(slot >> 4) : of(selectedBank.value);
    pick(slot, { rows, active: rows[0] ?? null });
    editingSlot.value = slot;
  };
  return (
    <div class="ptn-view">
      <div class="ptn-info">
        <span class="chip chip-accent">{padName(slot)}</span>
        <span>пусто — создать паттерн:</span>
        {[1, 2, 4].map((b) => <button key={b} class="btn ptn-mini" onClick={() => create(b)}>{b} {bars(b)}</button>)}
      </div>
      <p class="hint">Новый паттерн собирается в браузере; на SP он появится после «Сохранить на SP». Размер такта берётся из паттернов этого проекта.</p>
    </div>
  );
}

/** The last bounce: its WAV as the SP wrote it, for saving to the computer. */
const lastBounce = signal<{ slot: number; project1: number; wav: Uint8Array<ArrayBuffer> } | null>(null);

/**
 * Bounce: the SP plays the pattern in real time and sends the WAV back. It becomes the take
 * (listen, put on an empty pad with the tempo it played at) and can be saved as a file.
 */
function Bounce({ slot, p }: { slot: number; p: Pattern }) {
  const b = bouncing.value, t = tempoFor(slot >> 4), blocked = writeBlockReason.value;
  const secs = t ? (p.length / PPQ) * (6000 / t.tempoX100) : null;
  const last = lastBounce.value, mine = last?.slot === slot && last.project1 === project1.value;
  const take = recTake.value;
  const run = async () => {
    const wav = await bouncePattern(slot);
    if (!wav) return;
    const bytes = Uint8Array.from(wav);
    lastBounce.value = { slot, project1: project1.value, wav: bytes };
    try {
      const a = await decodeAudio(new Blob([bytes]));
      setTake(a.samples, a.channels, `ptn_${padName(slot)}_bounce`, { bpmX100: t?.tempoX100 ?? null });
      if (secs) log("info", `Bounce ${padName(slot)}: ${(a.frames / 48000).toFixed(2)} s при ожидаемых ${secs.toFixed(2)} s (${a.note})`);
    } catch (e) {
      notice.value = { kind: "error", text: `Bounce ${padName(slot)}: WAV не разобрался — ${(e as Error).message}. Его можно скачать и посмотреть` };
    }
  };
  return (
    <div class="ptn-bounce">
      <div class="ptn-bounce-row">
        <button class="btn" disabled={!!blocked || !!b} onClick={() => void run()}
          title={blocked ?? `SP сыграет паттерн в реальном времени${secs ? ` (~${Math.ceil(secs)} s)` : ""} и пришлёт WAV. На SP ничего не записывается`}>
          <IconWave /> Bounce в WAV
        </button>
        {b?.slot === slot ? (
          <span class="ptn-bounce-prog"><span class="bar"><span style={{ width: `${Math.round(b.progress * 100)}%` }} /></span>SP играет паттерн… {Math.round(b.progress * 100)} %</span>
        ) : mine ? (
          <button class="icon-btn insp-dl" onClick={() => saveFile(`Proj${last.project1}_${padName(slot)}_BOUNCE.WAV`, last.wav, "audio/wav")}
            title="Сохранить WAV, как его прислал SP"><IconDownload /> WAV</button>
        ) : (
          <span class="muted small">SP сам сыграет паттерн и пришлёт звук{secs ? ` — около ${Math.ceil(secs)} s` : ""}</span>
        )}
      </div>
      {mine && take?.name === `ptn_${padName(slot)}_bounce` && <TakeCard />}
    </div>
  );
}

/** A note under the pointer or focus (`pinned` false), or kept with a click (`pinned` true). */
const noteFocus = signal<{ slot: number; idx: number; pinned: boolean } | null>(null);

/** What the readout and the note's aria-label say about one note. */
function noteFacts(n: PatternNote, p: Pattern) {
  const barTicks = p.beatsPerBar * PPQ, inBar = n.tick % barTicks, off = n.tick % STEP;
  const st = noteSemitones(n);
  return {
    where: `такт ${Math.floor(n.tick / barTicks) + 1}, шаг ${Math.floor(inBar / STEP) + 1}${off ? ` +${off} тиков` : ""}`,
    len: `${+(n.gate / STEP).toFixed(2)} шага`,
    pitch: st === null ? (n.pitch ? `байт 3 = 0x${n.pitch.toString(16)}` : "") : st ? `высота ${signed(st)} пт` : "",
    origin: st === null ? "сыграна вживую" : "из TR-REC",
  };
}

function StepGrid({ slot, p, rows }: { slot: number; p: Pattern; rows: number[] }) {
  const pg = pagingOf(slot, p), { barSteps, steps, pageTicks, from, pageBars, used } = pg;
  const sel = selectedPad.value;
  const byPad = new Map<number, { n: PatternNote; idx: number }[]>();
  p.notes.forEach((n, idx) => byPad.set(n.pad, [...(byPad.get(n.pad) ?? []), { n, idx }]));
  const f = noteFocus.value?.slot === slot ? noteFocus.value : null;
  return (
    <>
      {pg.pages > 1 && <Pager page={pg.page} pages={pg.pages} barsPerPage={pg.barsPerPage} totalBars={pg.totalBars} onPage={pg.setPage} />}
      <div class="ptn-scroll" onClick={(e) => { if (f?.pinned && !(e.target as Element).closest(".ptn-note")) noteFocus.value = null; }}>
        <div class="ptn-grid" style={{ "--steps": steps, "--bar": barSteps }} data-slot={slot} data-from={from} data-span={pageTicks}>
          <div class="ptn-playhead" aria-hidden="true" />
          <div class="ptn-ruler-head" />
          <div class="ptn-ruler">
            {Array.from({ length: pageBars }, (_, bar) => (
              <span key={bar} style={{ gridColumn: `span ${Math.min(barSteps, steps - bar * barSteps)}` }}>{pg.page * pg.barsPerPage + bar + 1}</span>
            ))}
          </div>
          {rows.map((pad) => {
            const b = pads.value[pad];
            return [
              <div key={`h${pad}`} class="ptn-row-cell">
                <button class="ptn-row-pad" onClick={() => openPad(pad)} title={`Открыть ${padName(pad)} на экране pad'ов — править сэмпл`}>{padName(pad)}</button>
                <button class={`ptn-row-head ${pad === sel ? "cur" : ""} ${b?.size ? "" : "missing"}`} onClick={() => selectPad(pad)}
                  title={b?.size ? `${padName(pad)} «${b.name}» — выбрать: в матрице отметятся паттерны, где он играет` : `${padName(pad)} пуст: паттерн играет тишину`}>
                  <span>{b?.size ? b.name || "без имени" : "пусто"}</span>
                </button>
                <RowSound pad={pad} />
              </div>,
              <div key={`l${pad}`} class={`ptn-lane ${pad === sel ? "cur" : ""} ${used < 100 ? "short" : ""} ${silentClass(pad)}`} style={{ "--used": `${used}%` }}>
                {byPad.get(pad)!.map(({ n, idx }) => <Note key={idx} slot={slot} idx={idx} n={n} p={p} from={from} pageTicks={pageTicks} />)}
              </div>,
            ];
          })}
        </div>
      </div>
      <NoteReadout slot={slot} p={p} />
    </>
  );
}

/** One line under the grid for the note under the pointer: velocity as a number and a meter, and the rest. A click keeps it. */
function NoteReadout({ slot, p }: { slot: number; p: Pattern }) {
  const f = noteFocus.value, n = f?.slot === slot ? p.notes[f.idx] : undefined;
  if (!f || !n) return <div class="ptn-readout idle">Наведите на ноту: покажу силу удара, длину и позицию. Клик закрепляет.</div>;
  const k = noteFacts(n, p), b = pads.value[n.pad];
  return (
    <div class={`ptn-readout ${f.pinned ? "pinned" : ""}`} aria-live="polite">
      <b class="ptn-readout-pad">{padName(n.pad)}</b>
      <span class="ptn-readout-name">{b?.size ? b.name || "без имени" : "пусто"}</span>
      <span class="ptn-vel" title="Сила удара, 1–127">
        <span class="ptn-vel-label">сила</span>
        <span class="ptn-vel-meter"><span style={{ width: `${(n.velocity / 127) * 100}%` }} /></span>
        <b>{n.velocity}</b>
      </span>
      <span>{k.where}</span>
      <span>длина {k.len}</span>
      {k.pitch && <span>{k.pitch}</span>}
      <span class="muted">{k.origin}</span>
    </div>
  );
}

function Note({ slot, idx, n, p, from, pageTicks }: { slot: number; idx: number; n: PatternNote; p: Pattern; from: number; pageTicks: number }) {
  const end = Math.min(n.tick + Math.max(n.gate, 1), p.length), to = from + pageTicks;
  if (n.tick >= to || end <= from) return null;
  const start = Math.max(n.tick, from), stop = Math.min(end, to);
  const pct = (t: number) => `${((t - from) / pageTicks) * 100}%`;
  const off = n.tick % STEP, st = noteSemitones(n), k = noteFacts(n, p), f = noteFocus.value;
  const here = f?.slot === slot && f.idx === idx;
  const aria = `${padName(n.pad)} · ${k.where} · сила ${n.velocity} · длина ${k.len}${k.pitch ? ` · ${k.pitch}` : ""} · ${k.origin}`;
  const hover = (on: boolean) => { if (!noteFocus.value?.pinned || noteFocus.value.slot !== slot) noteFocus.value = on ? { slot, idx, pinned: false } : null; };
  const pin = () => { noteFocus.value = here && f!.pinned ? null : { slot, idx, pinned: true }; };
  return (
    <span class={`ptn-note ${off ? "off" : ""} ${st ? "pitched" : ""} ${n.tick < from ? "cont-in" : ""} ${end > to ? "cont-out" : ""} ${here ? "focus" : ""}`}
      role="button" tabIndex={0} aria-label={aria} aria-pressed={here && f!.pinned}
      onPointerEnter={() => hover(true)} onPointerLeave={() => hover(false)} onFocus={() => hover(true)} onBlur={() => hover(false)}
      onClick={pin} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pin(); } }}
      style={{ left: pct(start), width: `max(4px, ${((stop - start) / pageTicks) * 100}%)`, "--vel": `${(n.velocity / 127) * 100}%` }}>
      {st ? signed(st) : ""}
    </span>
  );
}
