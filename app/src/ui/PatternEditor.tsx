// The pattern editor: a step grid you draw in with the mouse, on a draft (patternDraft.ts).
// One gesture does the right thing by where it lands: an empty cell adds a note (drag to paint a run),
// a note's body picks it (a second click on the picked note removes it; drag moves it, also to another
// row), its right edge changes the length. Velocity is edited on its own lane under the grid, pitch,
// length and rolls for the picked note in a strip below. A step is heard through the SP over MIDI.

import { signal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import { PPQ, padName, type Pattern, type PatternNote } from "../sp404";
import {
  DEFAULT_VELOCITY, MAX_BARS, MAX_SEMITONES, STEP, addNote, barTicks, findNote, gateFor, moveNote, removeNote, resizeNote, rollNote, semitonesOf, setBars,
  setSemitones, setVelocity,
} from "../sp404/patternEdit";
import { IconMinus, IconPlus, IconRedo, IconTrash, IconUndo } from "./icons";
import { auditionPad, connectMidi, midiState } from "./midi";
import { Pager, pagingOf } from "./PatternPager";
import { draftOf, edit, editingSlot, isDirty, pick, preview, redo, revert, settle, undo, type Draft } from "./patternDraft";
import { pads, selectPad, selectedPad } from "./store";

/** The grid's step: 1/8, 1/16 or 1/32 of a note. */
const gridTicks = signal(STEP);
const snapOn = signal(true);
const GRIDS: [number, string][] = [[PPQ / 2, "1/8"], [STEP, "1/16"], [PPQ / 8, "1/32"]];

const signed = (v: number) => (v > 0 ? `+${v}` : v < 0 ? `−${-v}` : "0");
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** A drag in progress, kept outside the signals: it changes on every pointer move. */
type Gesture =
  | { kind: "paint"; pad: number; last: number; before: Pattern; rect: DOMRect }
  | { kind: "move" | "resize"; seq: number; x0: number; y0: number; t0: number; g0: number; pad0: number; wasPicked: boolean; moved: boolean; before: Pattern; rect: DOMRect };
let gesture: Gesture | null = null;

export function PatternEditor({ slot }: { slot: number }) {
  const d = draftOf(slot);
  useEffect(() => {
    if (midiState.value !== "ready") void connectMidi();
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest("input, textarea, select, [contenteditable]")) return;
      const cur = draftOf(slot);
      if (!cur) return;
      const mod = e.ctrlKey || e.metaKey, key = e.key.toLowerCase();
      if ((e.key === "Delete" || e.key === "Backspace") && cur.sel !== null) { e.preventDefault(); edit(slot, removeNote(cur.p, cur.sel), { sel: null }); }
      else if (mod && key === "z") { e.preventDefault(); if (e.shiftKey) redo(slot); else undo(slot); }
      else if (mod && key === "y") { e.preventDefault(); redo(slot); }
      else if (e.key === "Escape") pick(slot, { sel: null });
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [slot]);
  if (!d) return null;
  const pg = pagingOf(slot, d.p), p = d.p;
  const rows = [...new Set([...p.notes.map((n) => n.pad), ...d.rows])].sort((a, b) => a - b);
  const g = gridTicks.value, snap = snapOn.value;

  const tickAt = (x: number, rect: DOMRect) => pg.from + ((x - rect.left) / rect.width) * pg.pageTicks;
  const snapDown = (t: number) => (snap ? Math.floor(t / g) * g : Math.round(t));
  const snapNear = (t: number) => (snap ? Math.round(t / g) * g : Math.round(t));

  const onDown = (e: PointerEvent, pad: number) => {
    if (e.button !== 0) return;
    const lane = e.currentTarget as HTMLElement, rect = lane.getBoundingClientRect(), cur = draftOf(slot)!;
    const target = e.target as HTMLElement, noteEl = target.closest<HTMLElement>(".ptn-note");
    lane.setPointerCapture(e.pointerId);
    if (noteEl) {
      const seq = +noteEl.dataset.seq!, n = findNote(cur.p, seq);
      if (!n) return;
      gesture = { kind: target.closest(".ptn-h") ? "resize" : "move", seq, x0: e.clientX, y0: e.clientY, t0: n.tick, g0: n.gate, pad0: n.pad, wasPicked: cur.sel === seq, moved: false, before: cur.p, rect };
      pick(slot, { sel: seq, active: pad });
      if (cur.sel !== seq) auditionPad(n.pad, n.velocity);
    } else {
      const t = snapDown(tickAt(e.clientX, rect)), r = addNote(cur.p, pad, t, gateFor(g), DEFAULT_VELOCITY);
      gesture = { kind: "paint", pad, last: t, before: cur.p, rect };
      pick(slot, { active: pad, sel: r.note?.seq ?? cur.sel });
      if (r.note) { preview(slot, r.pattern, { sel: r.note.seq }); auditionPad(pad, r.note.velocity); }
    }
  };

  const onMove = (e: PointerEvent) => {
    const gs = gesture;
    if (!gs) return;
    const cur = draftOf(slot)!;
    if (gs.kind === "paint") {
      const t = snapDown(tickAt(e.clientX, gs.rect));
      if (t === gs.last) return;
      // A fast drag skips cells between two pointer events: fill them in.
      const dir = t > gs.last ? 1 : -1;
      let next = cur.p, picked: number | null = null;
      for (let x = gs.last + dir * g; dir > 0 ? x <= t : x >= t; x += dir * g) {
        const r = addNote(next, gs.pad, x, gateFor(g), DEFAULT_VELOCITY);
        if (r.note) { next = r.pattern; picked = r.note.seq; }
      }
      gs.last = t;
      if (next !== cur.p) preview(slot, next, { sel: picked });
      return;
    }
    if (!gs.moved && Math.abs(e.clientX - gs.x0) < 4 && Math.abs(e.clientY - gs.y0) < 6) return;
    gs.moved = true;
    const dt = ((e.clientX - gs.x0) / gs.rect.width) * pg.pageTicks;
    if (gs.kind === "resize") {
      const end = snap ? Math.round((gs.t0 + gs.g0 + dt + 1) / g) * g - 1 : Math.round(gs.t0 + gs.g0 + dt);
      preview(slot, resizeNote(gs.before, gs.seq, end - gs.t0));
      return;
    }
    // Which row is the pointer over?
    let pad = gs.pad0;
    (e.currentTarget as HTMLElement).closest(".ptn-grid")?.querySelectorAll<HTMLElement>(".ptn-lane").forEach((l) => {
      const b = l.getBoundingClientRect();
      if (e.clientY >= b.top && e.clientY <= b.bottom) pad = +l.dataset.pad!;
    });
    preview(slot, moveNote(gs.before, gs.seq, { tick: snapNear(gs.t0 + dt), pad }), { active: pad });
  };

  const onUp = () => {
    const gs = gesture;
    gesture = null;
    if (!gs) return;
    // A plain click on the picked note removes it: the step sequencer's toggle.
    if (gs.kind === "move" && !gs.moved && gs.wasPicked) edit(slot, removeNote(gs.before, gs.seq), { sel: null });
    else settle(slot, gs.before);
  };

  const addPad = (pad: number) => { pick(slot, { rows: [...new Set([...d.rows, pad])], active: pad }); auditionPad(pad); };
  const dropRow = (pad: number) => pick(slot, { rows: d.rows.filter((r) => r !== pad), active: d.active === pad ? null : d.active });
  const active = d.active !== null && rows.includes(d.active) ? d.active : rows[0] ?? null;

  return (
    <div class="ptn-edit">
      <EditBar slot={slot} d={d} rows={rows} onAddPad={addPad} />
      {pg.pages > 1 && <Pager page={pg.page} pages={pg.pages} barsPerPage={pg.barsPerPage} totalBars={pg.totalBars} onPage={pg.setPage} />}
      <div class="ptn-scroll">
        <div class="ptn-grid ptn-grid-edit" style={{ "--steps": pg.steps, "--bar": pg.barSteps }}>
          <div class="ptn-ruler-head" />
          <div class="ptn-ruler">
            {Array.from({ length: pg.pageBars }, (_, bar) => (
              <span key={bar} style={{ gridColumn: `span ${Math.min(pg.barSteps, pg.steps - bar * pg.barSteps)}` }}>{pg.page * pg.barsPerPage + bar + 1}</span>
            ))}
          </div>
          {rows.map((pad) => {
            const b = pads.value[pad], mine = p.notes.filter((n) => n.pad === pad), empty = mine.length === 0;
            return [
              <div key={`h${pad}`} class="ptn-row-cell">
                <button class={`ptn-row-head ${pad === active ? "act" : ""} ${b?.size ? "" : "missing"}`}
                  onClick={() => { selectPad(pad); pick(slot, { active: pad }); auditionPad(pad); }}
                  title={b?.size ? `${padName(pad)} «${b.name}» — послушать и выбрать` : `${padName(pad)} пуст: ноты играют тишину`}>
                  <b>{padName(pad)}</b><span>{b?.size ? b.name || "без имени" : "пусто"}</span>
                </button>
                {empty && <button class="icon-btn ptn-row-x" onClick={() => dropRow(pad)} title="Убрать пустую строку" aria-label={`Убрать строку ${padName(pad)}`}><IconMinus /></button>}
              </div>,
              <div key={`l${pad}`} class={`ptn-lane ptn-lane-edit ${pad === selectedPad.value ? "cur" : ""} ${pg.used < 100 ? "short" : ""}`} data-pad={pad} style={{ "--used": `${pg.used}%` }}
                onPointerDown={(e) => onDown(e, pad)} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
                {mine.map((n) => <EditNote key={n.seq} n={n} picked={d.sel === n.seq} from={pg.from} pageTicks={pg.pageTicks} length={p.length} />)}
              </div>,
            ];
          })}
          {active !== null && <VelocityLane slot={slot} d={d} pad={active} from={pg.from} pageTicks={pg.pageTicks} />}
        </div>
      </div>
      <NoteStrip slot={slot} d={d} grid={g} />
    </div>
  );
}

function EditNote({ n, picked, from, pageTicks, length }: { n: PatternNote; picked: boolean; from: number; pageTicks: number; length: number }) {
  const end = Math.min(n.tick + Math.max(n.gate, 1), length), to = from + pageTicks;
  if (n.tick >= to || end <= from) return null;
  const start = Math.max(n.tick, from), stop = Math.min(end, to), st = semitonesOf(n);
  const pct = (t: number) => `${((t - from) / pageTicks) * 100}%`;
  return (
    <span class={`ptn-note ${n.tick % STEP ? "off" : ""} ${st ? "pitched" : ""} ${n.tick < from ? "cont-in" : ""} ${end > to ? "cont-out" : ""} ${picked ? "focus" : ""}`}
      data-seq={n.seq} style={{ left: pct(start), width: `max(4px, ${((stop - start) / pageTicks) * 100}%)`, "--vel": `${(n.velocity / 127) * 100}%` }}>
      {st ? signed(st) : ""}
      <i class="ptn-h" />
    </span>
  );
}

/** Velocity of the active row's notes as bars under the grid: press and drag over them. */
function VelocityLane({ slot, d, pad, from, pageTicks }: { slot: number; d: Draft; pad: number; from: number; pageTicks: number }) {
  const mine = d.p.notes.filter((n) => n.pad === pad && n.tick < from + pageTicks && n.tick + n.gate > from);
  let before: Pattern | null = null;
  const setAt = (e: PointerEvent) => {
    const lane = e.currentTarget as HTMLElement, r = lane.getBoundingClientRect(), cur = draftOf(slot)!;
    const t = from + ((e.clientX - r.left) / r.width) * pageTicks;
    const v = 1 + clamp(1 - (e.clientY - r.top) / r.height, 0, 1) * 126;
    const near = cur.p.notes.filter((n) => n.pad === pad).map((n) => ({ n, dist: t < n.tick ? n.tick - t : t > n.tick + n.gate ? t - n.tick - n.gate : 0 }))
      .filter((x) => x.dist < STEP).sort((a, b) => a.dist - b.dist)[0];
    if (!near) return;
    const next = setVelocity(cur.p, near.n.seq, v);
    if (next !== cur.p) preview(slot, next, { sel: near.n.seq });
  };
  return [
    <div key="vh" class="ptn-vel-head" title="Сила удара строки: протяните по столбикам">сила <b>{padName(pad)}</b></div>,
    <div key="vl" class="ptn-vellane" role="group" aria-label={`Сила удара ${padName(pad)}`}
      onPointerDown={(e) => { if (e.button !== 0) return; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); before = draftOf(slot)!.p; setAt(e); }}
      onPointerMove={(e) => { if (before) setAt(e); }}
      onPointerUp={() => { if (before) settle(slot, before); before = null; }} onPointerCancel={() => { if (before) settle(slot, before); before = null; }}>
      {mine.map((n) => (
        <i key={n.seq} class={d.sel === n.seq ? "picked" : ""}
          style={{ left: `${((Math.max(n.tick, from) - from) / pageTicks) * 100}%`, width: `max(3px, ${(Math.min(n.gate, STEP) / pageTicks) * 60}%)`, height: `${(n.velocity / 127) * 100}%` }} />
      ))}
    </div>,
  ];
}

function EditBar({ slot, d, rows, onAddPad }: { slot: number; d: Draft; rows: number[]; onAddPad: (pad: number) => void }) {
  const p = d.p, g = gridTicks.value, bars = Math.max(1, Math.ceil(p.length / barTicks(p)));
  const options = Array.from({ length: 160 }, (_, i) => i).filter((i) => pads.value[i]?.size && !rows.includes(i));
  const byBank = new Map<number, number[]>();
  options.forEach((i) => byBank.set(i >> 4, [...(byBank.get(i >> 4) ?? []), i]));
  return (
    <div class="ptn-editbar">
      <div class="ptn-editbar-group">
        <button class="icon-btn" disabled={!d.undo.length} onClick={() => undo(slot)} title="Отменить (Ctrl+Z)" aria-label="Отменить"><IconUndo /></button>
        <button class="icon-btn" disabled={!d.redo.length} onClick={() => redo(slot)} title="Вернуть (Ctrl+Y)" aria-label="Вернуть"><IconRedo /></button>
      </div>
      <div class="ptn-editbar-group">
        <span class="muted small">сетка</span>
        <div class="segmented" role="group" aria-label="Шаг сетки">
          {GRIDS.map(([t, label]) => <button key={t} class={t === g ? "on" : ""} aria-pressed={t === g} onClick={() => (gridTicks.value = t)}>{label}</button>)}
        </div>
        <div class="segmented">
          <button class={snapOn.value ? "on" : ""} aria-pressed={snapOn.value} onClick={() => (snapOn.value = !snapOn.value)}
            title="Привязка к сетке. Выключите, чтобы ставить и двигать ноты между шагами">привязка</button>
        </div>
      </div>
      <div class="ptn-editbar-group">
        <span class="muted small">такты</span>
        <button class="icon-btn" disabled={bars <= 1} onClick={() => edit(slot, setBars(p, bars - 1))} title="Короче на такт: ноты за концом пропадут" aria-label="Короче на такт"><IconMinus /></button>
        <b class="ptn-bars">{bars}</b>
        <button class="icon-btn" disabled={bars >= MAX_BARS} onClick={() => edit(slot, setBars(p, bars + 1))} title="Длиннее на такт" aria-label="Длиннее на такт"><IconPlus /></button>
      </div>
      <select class="project-select ptn-addpad" value="" aria-label="Добавить строку" onChange={(e) => { const v = (e.currentTarget as HTMLSelectElement).value; (e.currentTarget as HTMLSelectElement).value = ""; if (v) onAddPad(+v); }} disabled={!options.length}>
        <option value="">+ строка…</option>
        {[...byBank].map(([bank, list]) => (
          <optgroup key={bank} label={`Банк ${"ABCDEFGHIJ"[bank]}`}>
            {list.map((i) => <option key={i} value={i}>{padName(i)} {pads.value[i]?.name || "без имени"}</option>)}
          </optgroup>
        ))}
      </select>
      {isDirty(d) && <button class="btn btn-ghost ptn-revert" onClick={() => revert(slot)} title="Вернуть паттерн таким, как он на SP (можно отменить)">сбросить правки</button>}
      {midiState.value !== "ready" && <span class="muted small" title="Шаги слышны через SP по USB-MIDI. Откройте страницу в Chrome и подключите SP">звук: нет MIDI-порта SP</span>}
    </div>
  );
}

/** Pitch, length and rolls of the picked note; velocity too, as a number. */
function NoteStrip({ slot, d, grid }: { slot: number; d: Draft; grid: number }) {
  const n = d.sel !== null ? findNote(d.p, d.sel) : undefined;
  if (!n) return <div class="ptn-readout idle">Пустая клетка — нота, протяните — ряд нот. Клик по ноте выбирает её, второй клик убирает (или Delete). Тяните ноту — сдвиг, за правый край — длина.</div>;
  const p = d.p, bt = barTicks(p), inBar = n.tick % bt, off = inBar % STEP, st = semitonesOf(n);
  const lenSteps = (n.gate + 1) / STEP;
  const b = pads.value[n.pad];
  let before: Pattern | null = null;
  const roll = (k: number) => { const r = rollNote(p, n.seq, k, Math.max(grid, STEP)); if (r.seqs.length) edit(slot, r.pattern, { sel: r.seqs[0] }); };
  return (
    <div class="ptn-readout ptn-notestrip" role="group" aria-label="Выбранная нота">
      <b class="ptn-readout-pad">{padName(n.pad)}</b>
      <span class="ptn-readout-name">{b?.size ? b.name || "без имени" : "пусто"}</span>
      <span>такт {Math.floor(n.tick / bt) + 1}, шаг {Math.floor(inBar / STEP) + 1}{off ? ` +${off}` : ""}</span>
      <label class="ptn-vel" title="Сила удара, 1–127">
        <span class="ptn-vel-label">сила</span>
        <input type="range" min={1} max={127} value={n.velocity}
          onInput={(e) => { before ??= draftOf(slot)!.p; preview(slot, setVelocity(draftOf(slot)!.p, n.seq, +(e.currentTarget as HTMLInputElement).value)); }}
          onChange={() => { if (before) settle(slot, before); before = null; }} />
        <b>{n.velocity}</b>
      </label>
      <span class="ptn-strip-group" title="Высота в полутонах, как пишет TR-REC">
        <span class="ptn-vel-label">высота</span>
        <button class="icon-btn" disabled={(st ?? 0) <= -MAX_SEMITONES} onClick={() => { edit(slot, setSemitones(p, n.seq, (st ?? 0) - 1)); auditionPad(n.pad, n.velocity); }} aria-label="Ниже на полутон"><IconMinus /></button>
        <b>{st === null ? "—" : signed(st)}</b>
        <button class="icon-btn" disabled={(st ?? 0) >= MAX_SEMITONES} onClick={() => { edit(slot, setSemitones(p, n.seq, (st ?? 0) + 1)); auditionPad(n.pad, n.velocity); }} aria-label="Выше на полутон"><IconPlus /></button>
      </span>
      <span class="ptn-strip-group">
        <span class="ptn-vel-label">длина</span>
        {[[0.5, "½"], [1, "1"], [2, "2"], [4, "4"]].map(([s, label]) => (
          <button key={s} class={`btn ptn-mini ${Math.abs(lenSteps - +s) < 0.02 ? "on" : ""}`} onClick={() => edit(slot, resizeNote(p, n.seq, +s * STEP - 1))}>{label}</button>
        ))}
        <span class="muted small">шага</span>
      </span>
      <span class="ptn-strip-group" title="Разбить ноту на части внутри шага, как sub-step в TR-REC">
        <span class="ptn-vel-label">ролл</span>
        {[2, 3, 4].map((k) => <button key={k} class="btn ptn-mini" disabled={!rollNote(p, n.seq, k, Math.max(grid, STEP)).seqs.length} onClick={() => roll(k)}>×{k}</button>)}
      </span>
      <button class="icon-btn insp-delete ptn-strip-del" onClick={() => edit(slot, removeNote(p, n.seq), { sel: null })} title="Убрать ноту (Delete)" aria-label="Убрать ноту"><IconTrash /></button>
    </div>
  );
}

export const startEditing = (slot: number): void => { editingSlot.value = slot; };
export const stopEditing = (): void => { editingSlot.value = null; };
