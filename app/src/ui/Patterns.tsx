// Patterns of the current project, read-only for now: the 160 slots, and a pattern as a step grid
// (pads as rows, 1/16 steps as columns), the shape the future TR-REC-style editor will take.
// Notes off the grid (played live) are drawn where they are, not snapped to a step.

import { computed, signal } from "@preact/signals";
import { BANKS, PPQ, formatBpm, noteSemitones, padName, type Pattern, type PatternNote } from "../sp404";
import { conn, downloadPatternMidi, patterns, patternsLoading, patternsOf, pads, refreshPatterns, selectPad, selectedPad, tempoFor } from "./store";
import { IconDownload, IconRefresh } from "./icons";

const VIEW_KEY = "nexus404.main.view";
type View = "pads" | "patterns";
function savedView(): View {
  try { return localStorage.getItem(VIEW_KEY) === "patterns" ? "patterns" : "pads"; } catch { return "pads"; }
}
/** What the left column shows: banks and pads, or the patterns. */
export const mainView = signal<View>(savedView());
export function showView(v: View): void {
  mainView.value = v;
  try { localStorage.setItem(VIEW_KEY, v); } catch { /* not kept: fine */ }
}

/** The slot picked in the matrix; the first pattern of the project when it has none there. */
const pickedSlot = signal<number | null>(null);
export const shownSlot = computed(() => {
  const m = patterns.value, s = pickedSlot.value;
  if (!m?.size) return null;
  return s !== null && m.has(s) ? s : [...m.keys()][0];
});
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
          {m.size ? <PatternView /> : <p class="muted ptn-empty">В проекте нет паттернов. Запишите паттерн на SP и нажмите «Обновить».</p>}
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
            const cls = ["ptn-slot", p !== undefined && (typeof p === "string" ? "bad" : "on"), slot === shown && "cur", ofSel.has(slot) && "uses"].filter(Boolean).join(" ");
            const title = p === undefined ? `${padName(slot)}: пусто`
              : typeof p === "string" ? `${padName(slot)}: не прочитан — ${p}`
              : `${padName(slot)}: ${p.bars} ${bars(p.bars)}, ${p.notes.length} нот${ofSel.has(slot) ? ` · играет ${padName(sel)}` : ""}`;
            return <button key={slot} role="gridcell" class={cls} disabled={p === undefined} title={title} aria-label={title} onClick={() => (pickedSlot.value = slot)}>{i + 1}</button>;
          })}
        </div>
      ))}
    </div>
  );
}

const bars = (n: number) => (n % 10 === 1 && n % 100 !== 11 ? "такт" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? "такта" : "тактов");

function PatternView() {
  const slot = shownSlot.value!, p = patterns.value!.get(slot)!;
  if (typeof p === "string") return <p class="err ptn-empty">{padName(slot)}: файл паттерна не прочитан — {p}</p>;
  const t = tempoFor(slot >> 4);
  const rows = [...new Set(p.notes.map((n) => n.pad))].sort((a, b) => a - b);
  // TR-REC sub-steps sit between steps on purpose: only notes played live count as off the grid.
  const offGrid = p.notes.filter((n) => n.tick % STEP && noteSemitones(n) === null).length;
  const pitched = p.notes.some((n) => noteSemitones(n));
  return (
    <div class="ptn-view">
      <div class="ptn-info">
        <span class="chip chip-accent">{padName(slot)}</span>
        <span>{p.bars} {bars(p.bars)} · {p.beatsPerBar}/4 · {p.notes.length} нот · {rows.length} pad'ов{t ? ` · ${formatBpm(t.tempoX100)} BPM ${t.of}` : ""}</span>
        {offGrid > 0 && <span class="chip" title="Ноты, сыгранные вживую мимо шагов 1/16. Показаны там, где они есть. Sub-step из TR-REC сюда не входят">вне сетки 1/16: {offGrid}</span>}
        <button class="icon-btn insp-dl" onClick={() => downloadPatternMidi(slot)}
          title={`Скачать как MIDI-файл, как экспорт SP: канал = банк, A13 = нота 36${t ? `; темп ${formatBpm(t.tempoX100)} — тот, что играет сейчас` : ""}`}><IconDownload /> MIDI</button>
      </div>
      <StepGrid p={p} rows={rows} />
      <p class="hint">Строки — pad'ы, которые играет паттерн; клик по названию открывает pad справа. Столбцы — шаги 1/16, яркость ноты — сила удара{pitched ? ", зелёные с «+1», «−2» — ноты, транспонированные в TR-REC" : ""}. Паттерн пока только для просмотра.</p>
    </div>
  );
}

function StepGrid({ p, rows }: { p: Pattern; rows: number[] }) {
  const steps = Math.max(1, Math.ceil(p.length / STEP)), barSteps = p.beatsPerBar * 4;
  const sel = selectedPad.value;
  const byPad = new Map<number, PatternNote[]>();
  for (const n of p.notes) byPad.set(n.pad, [...(byPad.get(n.pad) ?? []), n]);
  return (
    <div class="ptn-scroll">
      <div class="ptn-grid" style={{ "--steps": steps, "--bar": barSteps }}>
        <div class="ptn-ruler-head" />
        <div class="ptn-ruler">
          {Array.from({ length: Math.ceil(steps / barSteps) }, (_, bar) => (
            <span key={bar} style={{ gridColumn: `span ${Math.min(barSteps, steps - bar * barSteps)}` }}>{bar + 1}</span>
          ))}
        </div>
        {rows.map((pad) => {
          const b = pads.value[pad];
          return [
            <button key={`h${pad}`} class={`ptn-row-head ${pad === sel ? "cur" : ""} ${b?.size ? "" : "missing"}`} onClick={() => selectPad(pad)}
              title={b?.size ? `${padName(pad)} «${b.name}» — открыть справа` : `${padName(pad)} пуст: паттерн играет тишину`}>
              <b>{padName(pad)}</b><span>{b?.size ? b.name || "без имени" : "пусто"}</span>
            </button>,
            <div key={`l${pad}`} class={`ptn-lane ${pad === sel ? "cur" : ""}`}>
              {byPad.get(pad)!.map((n, i) => <Note key={i} n={n} p={p} />)}
            </div>,
          ];
        })}
      </div>
    </div>
  );
}

function Note({ n, p }: { n: PatternNote; p: Pattern }) {
  const pos = (t: number) => `${(t / p.length) * 100}%`;
  const barTicks = p.beatsPerBar * PPQ, inBar = n.tick % barTicks, off = n.tick % STEP;
  const where = `такт ${Math.floor(n.tick / barTicks) + 1}, шаг ${Math.floor(inBar / STEP) + 1}${off ? ` +${off} тиков` : ""}`;
  const st = noteSemitones(n);
  const pitch = st === null ? (n.pitch ? ` · байт 3 = 0x${n.pitch.toString(16)}` : "") : st ? ` · высота ${signed(st)} пт` : "";
  const title = `${padName(n.pad)} · ${where} · сила ${n.velocity} · длина ${+(n.gate / STEP).toFixed(2)} шага${pitch}${st === null ? " · сыграна вживую" : " · из TR-REC"}`;
  return (
    <span class={`ptn-note ${off ? "off" : ""} ${st ? "pitched" : ""}`} title={title}
      style={{ left: pos(n.tick), width: `max(4px, ${pos(Math.min(n.gate, p.length - n.tick))})`, opacity: 0.35 + (0.65 * n.velocity) / 127 }}>
      {st ? signed(st) : ""}
    </span>
  );
}
