// The pattern editor: a step grid you draw in with the mouse, on a draft (patternDraft.ts).
// One gesture does the right thing by where it lands: an empty cell adds a note (drag to paint a run),
// a note's body picks it (a second click on the picked note removes it; drag moves it, also to another
// row), its right edge changes the length; the right button removes notes, dragged over them it
// removes each one it passes; Alt+drag up or down on a note sets its velocity. Shift+drag on empty cells picks notes with a frame,
// Shift+click adds or takes one away; picked notes move, copy, paste and delete together. A row's
// menu fills, shifts or clears it; a bar's number repeats or clears that bar. Velocity is edited on
// its own lane under the grid, pitch, length and rolls for the picked note in a strip below. A step
// is heard through the SP over MIDI.

import { signal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import { PPQ, padName, type Pattern, type PatternNote } from "../sp404";
import {
  DEFAULT_VELOCITY, MAX_BARS, MAX_SEMITONES, STEP, addNote, barTicks, clearBar, clearPad, copyBar, copyNotes, doublePattern, duplicateOffset, fillPad, findNote,
  gateFor, moveNote, moveNotes, noteAt, pasteNotes, removeNote, removeNotes, resizeNote, rollNote, semitonesOf, setBars, setSemitones, setVelocities, setVelocity, shiftPad,
  type Clip,
} from "../sp404/patternEdit";
import { IconMinus, IconPlus, IconRedo, IconTrash, IconUndo, IconUpload } from "./icons";
import { auditionPad, connectMidi, midiState } from "./midi";
import { Pager, followTick, pagingOf } from "./PatternPager";
import { openPad } from "./Patterns";
import { RowSound, silentClass } from "./PatternRowSound";
import { draftOf, edit, editingSlot, isDirty, pick, preview, redo, revert, settle, undo, type Draft } from "./patternDraft";
import { confirmSave, pads, patternWriting, project1, reloadVia, requestSave, saveBlockReason, saveConfirm, selectPad, selectedPad } from "./store";

/** The grid's step: 1/8, 1/16 or 1/32 of a note. */
const gridTicks = signal(STEP);
const snapOn = signal(true);
/** Velocity of new notes (clicks, painting, fills): TR-REC's 90 to begin with. */
const newVelocity = signal(DEFAULT_VELOCITY);
const VELOCITY_PRESETS: [number, string][] = [[50, "тихо"], [DEFAULT_VELOCITY, "обычно"], [127, "акцент"]];
const GRIDS: [number, string][] = [[PPQ / 2, "1/8"], [STEP, "1/16"], [PPQ / 8, "1/32"]];
/** An open menu: a row's (by pad) or a bar's (0-based), and where on screen it opens (under its button). */
type Menu = ({ kind: "row"; pad: number } | { kind: "bar"; bar: number }) & { x: number; y: number };
const menu = signal<Menu | null>(null);
/** Open a menu under the button pressed (fixed on screen: the grid's scroll box would clip it). */
const openMenu = (e: MouseEvent, m: { kind: "row"; pad: number } | { kind: "bar"; bar: number }) => {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  menu.value = { ...m, x: Math.min(r.left, window.innerWidth - 300), y: r.bottom + 4 };
};

const signed = (v: number) => (v > 0 ? `+${v}` : v < 0 ? `−${-v}` : "0");
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
/** A length in ticks as a note value: 120 → "1/16". */
const noteValue = (t: number) => (Number.isInteger(1920 / t) ? `1/${1920 / t}` : `${t} т.`);

/** A drag in progress, kept outside the signals: it changes on every pointer move. */
type Gesture =
  | { kind: "paint"; pad: number; last: number; before: Pattern; rect: DOMRect }
  | { kind: "move" | "resize"; seq: number; x0: number; y0: number; t0: number; g0: number; pad0: number; wasPicked: boolean; moved: boolean; before: Pattern; rect: DOMRect }
  | { kind: "group"; seq: number; seqs: number[]; rows: number[]; row0: number; x0: number; y0: number; t0: number; moved: boolean; before: Pattern; rect: DOMRect }
  | { kind: "band"; x0: number; y0: number; grid: HTMLElement }
  | { kind: "erase"; x: number; y: number; before: Pattern }
  | { kind: "vel"; seqs: number[]; y0: number; before: Pattern };
let gesture: Gesture | null = null;
/**
 * The pattern as it was when a slider or the velocity lane was taken hold of: the whole drag becomes
 * one step of the history. Kept here, not in the component: every frame of the drag re-renders it.
 */
let held: Pattern | null = null;
/** The velocity bar taken hold of, and where: it stays the one being set until the pointer goes sideways. */
let velLock: { seq: number; x0: number } | null = null;
/** Copied notes: they can be pasted into this pattern or another one. */
let clip: Clip | null = null;
/**
 * The cell cursor: set by any click on the grid, moved by the arrows when no note is picked; Enter
 * puts a note there or takes it away, Ctrl+V pastes there.
 */
const cursor = signal<{ slot: number; pad: number; tick: number } | null>(null);

/** The notes picked: the group, or the one picked note. */
const pickedSeqs = (d: Draft): number[] => (d.group.length ? d.group : d.sel !== null ? [d.sel] : []);

/** Which row (pad) the pointer is over, from the lanes of the grid around `el`. */
function rowUnder(el: Element, y: number): number | null {
  let pad: number | null = null;
  el.closest(".ptn-grid")?.querySelectorAll<HTMLElement>(".ptn-lane").forEach((l) => {
    const b = l.getBoundingClientRect();
    if (y >= b.top && y <= b.bottom) pad = +l.dataset.pad!;
  });
  return pad;
}

export function PatternEditor({ slot }: { slot: number }) {
  const d = draftOf(slot);
  useEffect(() => {
    if (midiState.value !== "ready") void connectMidi();
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest("input, textarea, select, [contenteditable]")) return;
      if (e.key === "Enter" && (e.target as HTMLElement | null)?.closest?.("button")) return; // a focused button takes its own Enter
      const cur = draftOf(slot);
      if (!cur) return;
      const mod = e.ctrlKey || e.metaKey, key = e.key.toLowerCase(), picked = pickedSeqs(cur);
      if (e.key === "Escape") { if (menu.value) menu.value = null; else pick(slot, { sel: null, group: [] }); }
      else if ((e.key === "Delete" || e.key === "Backspace") && picked.length) { e.preventDefault(); edit(slot, removeNotes(cur.p, picked), { sel: null, group: [] }); }
      else if (mod && key === "z") { e.preventDefault(); if (e.shiftKey) redo(slot); else undo(slot); }
      else if (mod && key === "y") { e.preventDefault(); redo(slot); }
      else if (mod && key === "s") { e.preventDefault(); requestSave(slot); }
      else if (mod && key === "a") { e.preventDefault(); pick(slot, { group: cur.p.notes.map((n) => n.seq), sel: null }); }
      else if (mod && key === "c" && picked.length) { e.preventDefault(); clip = copyNotes(cur.p, picked); }
      else if (mod && key === "v" && clip?.length) {
        e.preventDefault();
        const c = cursor.value, r = pasteNotes(cur.p, clip, c?.slot === slot ? c.tick : 0);
        if (r.seqs.length) edit(slot, r.pattern, { group: r.seqs, sel: null });
      } else if (mod && key === "d" && picked.length) {
        e.preventDefault();
        const t0 = Math.min(...cur.p.notes.filter((n) => picked.includes(n.seq)).map((n) => n.tick));
        const r = pasteNotes(cur.p, copyNotes(cur.p, picked), t0 + duplicateOffset(cur.p, picked));
        if (r.seqs.length) edit(slot, r.pattern, { group: r.seqs, sel: null });
      } else if (!picked.length && !mod && (e.key.startsWith("Arrow") || e.key === "Enter")) {
        // Nothing picked: the arrows walk the cell cursor, Enter toggles a note under it.
        const rows = [...new Set([...cur.p.notes.map((n) => n.pad), ...cur.rows])].sort((a, b) => a - b);
        if (!rows.length) return;
        e.preventDefault();
        const g = gridTicks.value, c = cursor.value?.slot === slot && rows.includes(cursor.value.pad) ? cursor.value : { slot, pad: rows[0], tick: 0 };
        let { pad, tick } = c;
        if (e.key === "ArrowLeft") tick = Math.max(0, Math.ceil(tick / g) * g - g);
        else if (e.key === "ArrowRight") tick = Math.min(Math.floor((cur.p.length - 1) / g) * g, Math.floor(tick / g) * g + g);
        else if (e.key === "ArrowUp") pad = rows[Math.max(0, rows.indexOf(pad) - 1)];
        else if (e.key === "ArrowDown") pad = rows[Math.min(rows.length - 1, rows.indexOf(pad) + 1)];
        else {
          const there = noteAt(cur.p, pad, tick);
          edit(slot, there ? removeNote(cur.p, there.seq) : addNote(cur.p, pad, tick, gateFor(g), newVelocity.value).pattern, { active: pad });
        }
        cursor.value = { slot, pad, tick };
        followTick(slot, cur.p, tick);
      } else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && picked.length) {
        e.preventDefault();
        edit(slot, moveNotes(cur.p, picked, (e.key === "ArrowLeft" ? -1 : 1) * gridTicks.value));
      } else if ((e.key === "ArrowUp" || e.key === "ArrowDown") && picked.length) {
        e.preventDefault();
        if (e.altKey) { edit(slot, setVelocities(cur.p, picked, (v) => v + (e.key === "ArrowUp" ? 10 : -10))); return; }
        const rows = [...new Set([...cur.p.notes.map((n) => n.pad), ...cur.rows])].sort((a, b) => a - b), dr = e.key === "ArrowUp" ? -1 : 1;
        edit(slot, moveNotes(cur.p, picked, 0, (pad) => rows[rows.indexOf(pad) + dr] ?? null));
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [slot]);
  // A menu closes on a press anywhere outside it.
  useEffect(() => {
    const close = (e: PointerEvent) => { if (menu.value && !(e.target as Element).closest?.(".ptn-menu, .ptn-menu-btn")) menu.value = null; };
    const gone = () => { if (menu.value) menu.value = null; };
    document.addEventListener("pointerdown", close);
    addEventListener("scroll", gone, true);
    return () => { document.removeEventListener("pointerdown", close); removeEventListener("scroll", gone, true); };
  }, []);
  if (!d) return null;
  const pg = pagingOf(slot, d.p), p = d.p;
  const rows = [...new Set([...p.notes.map((n) => n.pad), ...d.rows])].sort((a, b) => a - b);
  const g = gridTicks.value, snap = snapOn.value, group = new Set(d.group);

  const tickAt = (x: number, rect: DOMRect) => pg.from + ((x - rect.left) / rect.width) * pg.pageTicks;
  const snapDown = (t: number) => (snap ? Math.floor(t / g) * g : Math.round(t));
  const snapNear = (t: number) => (snap ? Math.round(t / g) * g : Math.round(t));

  const onDown = (e: PointerEvent, pad: number) => {
    if (e.button === 2) {
      // Right button: an eraser — the note under it goes, and every note it is dragged over.
      const cur = draftOf(slot)!;
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      gesture = { kind: "erase", x: e.clientX, y: e.clientY, before: cur.p };
      eraseAlong(slot, e.clientX, e.clientY, e.clientX, e.clientY);
      return;
    }
    if (e.button !== 0) return;
    const lane = e.currentTarget as HTMLElement, rect = lane.getBoundingClientRect(), cur = draftOf(slot)!;
    const target = e.target as HTMLElement, noteEl = target.closest<HTMLElement>(".ptn-note");
    lane.setPointerCapture(e.pointerId);
    cursor.value = { slot, pad, tick: clamp(snapDown(tickAt(e.clientX, rect)), 0, cur.p.length - 1) };
    if (noteEl) {
      const seq = +noteEl.dataset.seq!, n = findNote(cur.p, seq);
      if (!n) return;
      if (e.shiftKey) {
        // Shift+click: add the note to the picked ones, or take it away.
        const now = new Set(pickedSeqs(cur));
        if (now.has(seq)) now.delete(seq); else now.add(seq);
        pick(slot, { group: [...now], sel: null, active: pad });
        return;
      }
      if (e.altKey) {
        // Alt+drag up/down: velocity, of the whole group when the note is in it.
        const seqs = cur.group.length > 1 && cur.group.includes(seq) ? cur.group : [seq];
        gesture = { kind: "vel", seqs, y0: e.clientY, before: cur.p };
        if (seqs.length === 1) pick(slot, { sel: seq, group: [], active: pad });
        return;
      }
      if (cur.group.length > 1 && cur.group.includes(seq)) {
        gesture = { kind: "group", seq, seqs: cur.group, rows, row0: rows.indexOf(n.pad), x0: e.clientX, y0: e.clientY, t0: n.tick, moved: false, before: cur.p, rect };
        return;
      }
      gesture = { kind: target.closest(".ptn-h") ? "resize" : "move", seq, x0: e.clientX, y0: e.clientY, t0: n.tick, g0: n.gate, pad0: n.pad, wasPicked: cur.sel === seq, moved: false, before: cur.p, rect };
      pick(slot, { sel: seq, group: [], active: pad });
      if (cur.sel !== seq) auditionPad(n.pad, n.velocity);
    } else if (e.shiftKey) {
      // Shift+drag on empty cells: a frame that picks the notes it touches.
      gesture = { kind: "band", x0: e.clientX, y0: e.clientY, grid: lane.closest<HTMLElement>(".ptn-grid")! };
      drawBand(gesture, e.clientX, e.clientY);
    } else {
      const t = snapDown(tickAt(e.clientX, rect)), r = addNote(cur.p, pad, t, gateFor(g), newVelocity.value);
      gesture = { kind: "paint", pad, last: t, before: cur.p, rect };
      pick(slot, { active: pad, sel: r.note?.seq ?? cur.sel, group: [] });
      if (r.note) preview(slot, r.pattern, { sel: r.note.seq }); // silent: placing notes should not fire the pad every time
    }
  };

  const onMove = (e: PointerEvent) => {
    const gs = gesture;
    if (!gs) return;
    const cur = draftOf(slot)!;
    if (gs.kind === "band") { drawBand(gs, e.clientX, e.clientY); return; }
    if (gs.kind === "erase") { eraseAlong(slot, gs.x, gs.y, e.clientX, e.clientY); gs.x = e.clientX; gs.y = e.clientY; return; }
    if (gs.kind === "vel") { const dv = Math.round((gs.y0 - e.clientY) * 0.8); preview(slot, setVelocities(gs.before, gs.seqs, (v) => v + dv)); return; }
    if (gs.kind === "paint") {
      const t = snapDown(tickAt(e.clientX, gs.rect));
      if (t === gs.last) return;
      // A fast drag skips cells between two pointer events: fill them in.
      const dir = t > gs.last ? 1 : -1;
      let next = cur.p, picked: number | null = null;
      for (let x = gs.last + dir * g; dir > 0 ? x <= t : x >= t; x += dir * g) {
        const r = addNote(next, gs.pad, x, gateFor(g), newVelocity.value);
        if (r.note) { next = r.pattern; picked = r.note.seq; }
      }
      gs.last = t;
      if (next !== cur.p) preview(slot, next, { sel: picked });
      return;
    }
    if (!gs.moved && Math.abs(e.clientX - gs.x0) < 4 && Math.abs(e.clientY - gs.y0) < 6) return;
    gs.moved = true;
    const dt = ((e.clientX - gs.x0) / gs.rect.width) * pg.pageTicks;
    if (gs.kind === "group") {
      const at = rowUnder(e.currentTarget as Element, e.clientY), dr = at === null ? 0 : gs.rows.indexOf(at) - gs.row0;
      const delta = snapNear(gs.t0 + dt) - gs.t0;
      preview(slot, moveNotes(gs.before, gs.seqs, delta, (pad) => gs.rows[gs.rows.indexOf(pad) + dr] ?? null));
      return;
    }
    if (gs.kind === "resize") {
      const end = snap ? Math.round((gs.t0 + gs.g0 + dt + 1) / g) * g - 1 : Math.round(gs.t0 + gs.g0 + dt);
      preview(slot, resizeNote(gs.before, gs.seq, end - gs.t0));
      return;
    }
    const pad = rowUnder(e.currentTarget as Element, e.clientY) ?? gs.pad0;
    preview(slot, moveNote(gs.before, gs.seq, { tick: snapNear(gs.t0 + dt), pad }), { active: pad });
  };

  const onUp = (e: PointerEvent) => {
    const gs = gesture;
    gesture = null;
    if (!gs) return;
    if (gs.kind === "band") { pickInBand(slot, gs, e.clientX, e.clientY); return; }
    if (gs.kind === "erase" || gs.kind === "vel") { settle(slot, gs.before); return; }
    // A plain click on the picked note removes it: the step sequencer's toggle.
    if (gs.kind === "move" && !gs.moved && gs.wasPicked) edit(slot, removeNote(gs.before, gs.seq), { sel: null });
    // A plain click on one of several picked notes picks it alone.
    else if (gs.kind === "group" && !gs.moved) pick(slot, { group: [], sel: gs.seq });
    else settle(slot, gs.before);
  };

  const addPads = (list: number[]) => { if (list.length) pick(slot, { rows: [...new Set([...d.rows, ...list])], active: list[0] }); };
  const dropRow = (pad: number) => pick(slot, { rows: d.rows.filter((r) => r !== pad), active: d.active === pad ? null : d.active });
  const active = d.active !== null && rows.includes(d.active) ? d.active : rows[0] ?? null;
  const m = menu.value, cur = cursor.value?.slot === slot ? cursor.value : null;

  return (
    <div class="ptn-edit">
      <EditBar slot={slot} d={d} rows={rows} onAddPads={addPads} />
      {pg.pages > 1 && <Pager page={pg.page} pages={pg.pages} barsPerPage={pg.barsPerPage} totalBars={pg.totalBars} onPage={pg.setPage} />}
      <div class="ptn-scroll">
        <div class="ptn-grid ptn-grid-edit" style={{ "--steps": pg.steps, "--bar": pg.barSteps }} data-slot={slot} data-from={pg.from} data-span={pg.pageTicks}>
          <div class="ptn-playhead" aria-hidden="true" />
          <div class="ptn-band" hidden aria-hidden="true" />
          <div class="ptn-ruler-head" />
          <div class="ptn-ruler">
            {Array.from({ length: pg.pageBars }, (_, i) => {
              const bar = pg.page * pg.barsPerPage + i, open = m?.kind === "bar" && m.bar === bar;
              return (
                <span key={i} class="ptn-bar-cell" style={{ gridColumn: `span ${Math.min(pg.barSteps, pg.steps - i * pg.barSteps)}` }}>
                  <button class={`ptn-menu-btn ptn-bar-btn ${open ? "on" : ""}`} onClick={(e) => (open ? (menu.value = null) : openMenu(e, { kind: "bar", bar }))}
                    title={`Такт ${bar + 1}: повторить, очистить`} aria-expanded={open}>{bar + 1} ▾</button>
                  {open && <BarMenu slot={slot} p={p} bar={bar} at={m!} />}
                </span>
              );
            })}
          </div>
          {rows.map((pad) => {
            const b = pads.value[pad], mine = p.notes.filter((n) => n.pad === pad), empty = mine.length === 0, open = m?.kind === "row" && m.pad === pad;
            return [
              <div key={`h${pad}`} class="ptn-row-cell">
                <button class="ptn-row-pad" onClick={() => openPad(pad)} title={`Открыть ${padName(pad)} на экране pad'ов — править сэмпл (черновик паттерна сохранится)`}>{padName(pad)}</button>
                <button class={`ptn-row-head ${pad === active ? "act" : ""} ${b?.size ? "" : "missing"}`}
                  onClick={() => { selectPad(pad); pick(slot, { active: pad }); auditionPad(pad); }}
                  title={b?.size ? `${padName(pad)} «${b.name}» — послушать и выбрать` : `${padName(pad)} пуст: ноты играют тишину`}>
                  <span>{b?.size ? b.name || "без имени" : "пусто"}</span>
                </button>
                <RowSound pad={pad} />
                <button class={`icon-btn ptn-menu-btn ptn-row-more ${open ? "on" : ""}`} onClick={(e) => (open ? (menu.value = null) : openMenu(e, { kind: "row", pad }))}
                  title="Заполнить, сдвинуть, очистить строку" aria-label={`Строка ${padName(pad)}: действия`} aria-expanded={open}>⋯</button>
                {empty && <button class="icon-btn ptn-row-x" onClick={() => dropRow(pad)} title="Убрать пустую строку" aria-label={`Убрать строку ${padName(pad)}`}><IconMinus /></button>}
                {open && <RowMenu slot={slot} p={p} pad={pad} grid={g} at={m!} />}
              </div>,
              <div key={`l${pad}`} class={`ptn-lane ptn-lane-edit ${pad === selectedPad.value ? "cur" : ""} ${pg.used < 100 ? "short" : ""} ${silentClass(pad)}`} data-pad={pad} style={{ "--used": `${pg.used}%` }}
                onPointerDown={(e) => onDown(e, pad)} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onContextMenu={(e) => e.preventDefault()}>
                {mine.map((n) => <EditNote key={n.seq} n={n} picked={d.sel === n.seq || group.has(n.seq)} from={pg.from} pageTicks={pg.pageTicks} length={p.length} />)}
                {cur?.pad === pad && cur.tick >= pg.from && cur.tick < pg.from + pg.pageTicks && (
                  <i class="ptn-cursor" aria-hidden="true" style={{ left: `${((cur.tick - pg.from) / pg.pageTicks) * 100}%`, width: `${(g / pg.pageTicks) * 100}%` }} />
                )}
              </div>,
            ];
          })}
          {active !== null && <VelocityLane slot={slot} d={d} pad={active} from={pg.from} pageTicks={pg.pageTicks} />}
        </div>
      </div>
      {d.group.length > 1 ? <GroupStrip slot={slot} d={d} /> : <NoteStrip slot={slot} d={d} grid={g} />}
    </div>
  );
}

/**
 * The eraser's stroke from (x0, y0) to (x1, y1): every note under it goes. Points are taken every few
 * pixels, so a fast drag between two pointer events does not jump over a note.
 */
function eraseAlong(slot: number, x0: number, y0: number, x1: number, y1: number): void {
  const cur = draftOf(slot);
  if (!cur) return;
  const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 3)), hit = new Set<number>();
  for (let i = 0; i <= n; i++) {
    const el = document.elementFromPoint(x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n)?.closest<HTMLElement>(".ptn-grid-edit .ptn-note");
    if (el) hit.add(+el.dataset.seq!);
  }
  if (hit.size) preview(slot, removeNotes(cur.p, [...hit]));
}

/** The selection frame, in the grid's own coordinates. */
function drawBand(gs: { x0: number; y0: number; grid: HTMLElement }, x: number, y: number): void {
  const el = gs.grid.querySelector<HTMLElement>(".ptn-band"), r = gs.grid.getBoundingClientRect();
  if (!el) return;
  el.hidden = false;
  Object.assign(el.style, {
    left: `${Math.min(gs.x0, x) - r.left}px`, top: `${Math.min(gs.y0, y) - r.top}px`,
    width: `${Math.abs(x - gs.x0)}px`, height: `${Math.abs(y - gs.y0)}px`,
  });
}

/** End of a frame: the notes it touches become the picked ones. */
function pickInBand(slot: number, gs: { x0: number; y0: number; grid: HTMLElement }, x: number, y: number): void {
  const el = gs.grid.querySelector<HTMLElement>(".ptn-band");
  if (el) el.hidden = true;
  const l = Math.min(gs.x0, x), rgt = Math.max(gs.x0, x), t = Math.min(gs.y0, y), b = Math.max(gs.y0, y);
  const seqs = [...gs.grid.querySelectorAll<HTMLElement>(".ptn-note")].filter((n) => {
    const r = n.getBoundingClientRect();
    return r.right >= l && r.left <= rgt && r.bottom >= t && r.top <= b;
  }).map((n) => +n.dataset.seq!);
  pick(slot, seqs.length === 1 ? { sel: seqs[0], group: [] } : { group: seqs, sel: null });
}

/** A row's menu: fill it at a note value (replacing its notes), shift it round, clear it. */
function RowMenu({ slot, p, pad, grid, at }: { slot: number; p: Pattern; pad: number; grid: number; at: Menu }) {
  const bt = barTicks(p), steps = [1, 2, 4, 8].map((k) => k * grid).filter((t) => t <= bt);
  const fill = (every: number, offset: number) => { edit(slot, fillPad(p, pad, every, offset, gateFor(Math.min(grid, every)), newVelocity.value)); menu.value = null; };
  const has = p.notes.some((n) => n.pad === pad);
  return (
    <div class="ptn-menu" role="menu" aria-label={`Строка ${padName(pad)}`} style={{ left: `${at.x}px`, top: `${at.y}px` }}>
      <div class="ptn-menu-title">заполнить строку (заменит её ноты)</div>
      <div class="ptn-menu-row">
        {steps.map((t) => <button key={t} class="btn ptn-mini" role="menuitem" onClick={() => fill(t, 0)} title={`Нота каждую ${noteValue(t)}`}>{noteValue(t)}</button>)}
      </div>
      <div class="ptn-menu-row">
        {steps.filter((t) => t >= 2 * grid).map((t) => (
          <button key={t} class="btn ptn-mini" role="menuitem" onClick={() => fill(t, t / 2)} title={`Нота каждую ${noteValue(t)}, между долями`}>{noteValue(t)} ↷</button>
        ))}
        <span class="muted small">со сдвигом на половину</span>
      </div>
      <div class="ptn-menu-row">
        <button class="btn ptn-mini" role="menuitem" disabled={!has} onClick={() => edit(slot, shiftPad(p, pad, -grid))} title={`Сдвинуть всю строку на ${noteValue(grid)} раньше (по кругу)`}>← сдвиг</button>
        <button class="btn ptn-mini" role="menuitem" disabled={!has} onClick={() => edit(slot, shiftPad(p, pad, grid))} title={`Сдвинуть всю строку на ${noteValue(grid)} позже (по кругу)`}>сдвиг →</button>
        <button class="btn ptn-mini" role="menuitem" disabled={!has} onClick={() => { edit(slot, clearPad(p, pad), { sel: null, group: [] }); menu.value = null; }}>очистить</button>
      </div>
    </div>
  );
}

/** A bar's menu: repeat it into the next bar (adding one at the end), or clear it. */
function BarMenu({ slot, p, bar, at }: { slot: number; p: Pattern; bar: number; at: Menu }) {
  const bars = Math.ceil(p.length / barTicks(p)), last = bar === bars - 1;
  const repeat = () => {
    const q = last ? setBars(p, bars + 1) : p;
    if (q === p && last) return;
    edit(slot, copyBar(q, bar, bar + 1));
    menu.value = null;
  };
  return (
    <div class="ptn-menu ptn-bar-menu" role="menu" aria-label={`Такт ${bar + 1}`} style={{ left: `${at.x}px`, top: `${at.y}px` }}>
      <button class="btn ptn-mini" role="menuitem" disabled={last && bars >= MAX_BARS} onClick={repeat}
        title={last ? "Добавить такт в конце и скопировать в него этот" : `Скопировать этот такт поверх такта ${bar + 2}`}>повторить в такте {bar + 2}{last ? " (новом)" : ""}</button>
      <button class="btn ptn-mini" role="menuitem" onClick={() => { edit(slot, clearBar(p, bar), { sel: null, group: [] }); menu.value = null; }}>очистить такт</button>
    </div>
  );
}

/** Several notes picked: their velocity and pitch together, copy, duplicate, delete. */
function GroupStrip({ slot, d }: { slot: number; d: Draft }) {
  const p = d.p, mine = p.notes.filter((n) => d.group.includes(n.seq));
  const avg = Math.round(mine.reduce((s, n) => s + n.velocity, 0) / Math.max(1, mine.length));
  const transpose = (by: number) => {
    let q = p;
    for (const n of mine) q = setSemitones(q, n.seq, (semitonesOf(n) ?? 0) + by);
    edit(slot, q);
  };
  const dup = () => {
    const t0 = Math.min(...mine.map((n) => n.tick)), r = pasteNotes(p, copyNotes(p, d.group), t0 + duplicateOffset(p, d.group));
    if (r.seqs.length) edit(slot, r.pattern, { group: r.seqs, sel: null });
  };
  return (
    <div class="ptn-readout ptn-notestrip" role="group" aria-label="Выбранные ноты">
      <b class="ptn-readout-pad">{mine.length} нот</b>
      <label class="ptn-vel" title="Сила удара всех выбранных нот">
        <span class="ptn-vel-label">сила</span>
        <input type="range" min={1} max={127} value={avg}
          onInput={(e) => { held ??= draftOf(slot)!.p; preview(slot, setVelocities(held, d.group, +(e.currentTarget as HTMLInputElement).value)); }}
          onChange={() => { if (held) settle(slot, held); held = null; }} />
        <b>{avg}</b>
      </label>
      <span class="ptn-strip-group" title="Высота всех выбранных нот, на полутон">
        <span class="ptn-vel-label">высота</span>
        <button class="icon-btn" onClick={() => transpose(-1)} aria-label="Ниже на полутон"><IconMinus /></button>
        <button class="icon-btn" onClick={() => transpose(1)} aria-label="Выше на полутон"><IconPlus /></button>
      </span>
      <span class="ptn-strip-group">
        <button class="btn ptn-mini" onClick={() => { clip = copyNotes(p, d.group); }} title="Копировать (Ctrl+C); вставка — Ctrl+V в клетку, по которой кликнули">копировать</button>
        <button class="btn ptn-mini" onClick={dup} title="Повторить сразу после выбранного (Ctrl+D)">дублировать</button>
      </span>
      <span class="muted small">←/→ сдвиг · ↑/↓ строка · Alt+↑/↓ сила</span>
      <button class="icon-btn insp-delete ptn-strip-del" onClick={() => edit(slot, removeNotes(p, d.group), { group: [], sel: null })} title="Убрать выбранные (Delete)" aria-label="Убрать выбранные"><IconTrash /></button>
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
  /** The note nearest the pointer on this row, within a step. */
  const nearest = (p: Pattern, t: number) => p.notes.filter((n) => n.pad === pad)
    .map((n) => ({ n, dist: t < n.tick ? n.tick - t : t > n.tick + n.gate ? t - n.tick - n.gate : 0 }))
    .filter((x) => x.dist < STEP).sort((a, b) => a.dist - b.dist)[0]?.n;
  const setAt = (e: PointerEvent) => {
    const lane = e.currentTarget as HTMLElement, r = lane.getBoundingClientRect(), cur = draftOf(slot)!;
    const v = 1 + clamp(1 - (e.clientY - r.top) / r.height, 0, 1) * 126;
    // Held on one bar: that bar follows the pointer up and down; moved sideways: paint every bar passed.
    if (velLock && Math.abs(e.clientX - velLock.x0) > 8) velLock = null;
    const seq = velLock?.seq ?? nearest(cur.p, from + ((e.clientX - r.left) / r.width) * pageTicks)?.seq;
    if (seq === undefined) return;
    const next = setVelocity(cur.p, seq, v);
    if (next !== cur.p) preview(slot, next, { sel: seq });
  };
  const start = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const lane = e.currentTarget as HTMLElement, r = lane.getBoundingClientRect();
    lane.setPointerCapture(e.pointerId);
    held = draftOf(slot)!.p;
    const n = nearest(held, from + ((e.clientX - r.left) / r.width) * pageTicks);
    velLock = n ? { seq: n.seq, x0: e.clientX } : null;
    setAt(e);
  };
  const end = () => { if (held) settle(slot, held); held = null; velLock = null; };
  return [
    <div key="vh" class="ptn-vel-head" title="Сила удара строки: тяните столбик вверх-вниз, или ведите вбок — задать силу всем по пути">сила <b>{padName(pad)}</b></div>,
    <div key="vl" class="ptn-vellane" role="group" aria-label={`Сила удара ${padName(pad)}`}
      onPointerDown={start} onPointerMove={(e) => { if (held) setAt(e); }} onPointerUp={end} onPointerCancel={end}>
      {mine.map((n) => (
        <i key={n.seq} class={d.sel === n.seq ? "picked" : ""}
          style={{ left: `${((Math.max(n.tick, from) - from) / pageTicks) * 100}%`, width: `max(3px, ${(Math.min(n.gate, STEP) / pageTicks) * 60}%)`, height: `${(n.velocity / 127) * 100}%` }}>
          {d.sel === n.seq && <span class={`ptn-vel-num ${n.velocity > 100 ? "in" : ""}`}>{n.velocity}</span>}
        </i>
      ))}
    </div>,
  ];
}

function EditBar({ slot, d, rows, onAddPads }: { slot: number; d: Draft; rows: number[]; onAddPads: (pads: number[]) => void }) {
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
      <div class="ptn-editbar-group" title="Сила удара новых нот: клик, протяжка, заполнение строки">
        <span class="muted small">сила</span>
        <div class="segmented" role="group" aria-label="Сила новых нот">
          {VELOCITY_PRESETS.map(([v, label]) => (
            <button key={v} class={newVelocity.value === v ? "on" : ""} aria-pressed={newVelocity.value === v} onClick={() => (newVelocity.value = v)} title={`${label}: ${v}`}>{label}</button>
          ))}
        </div>
        <input class="value-field ptn-vel-field" type="number" min={1} max={127} value={newVelocity.value} aria-label="Сила новых нот, 1–127"
          onChange={(e) => { const v = Math.round(+(e.currentTarget as HTMLInputElement).value); if (v >= 1 && v <= 127) newVelocity.value = v; else (e.currentTarget as HTMLInputElement).value = String(newVelocity.value); }} />
      </div>
      <div class="ptn-editbar-group">
        <span class="muted small">такты</span>
        <button class="icon-btn" disabled={bars <= 1} onClick={() => edit(slot, setBars(p, bars - 1))} title="Короче на такт: ноты за концом пропадут" aria-label="Короче на такт"><IconMinus /></button>
        <b class="ptn-bars">{bars}</b>
        <button class="icon-btn" disabled={bars >= MAX_BARS} onClick={() => edit(slot, setBars(p, bars + 1))} title="Длиннее на такт" aria-label="Длиннее на такт"><IconPlus /></button>
        <button class="btn ptn-mini" disabled={doublePattern(p) === p} onClick={() => edit(slot, doublePattern(p))} title="Удвоить: паттерн вдвое длиннее, вторая половина — копия первой">×2</button>
      </div>
      <select class="project-select ptn-addpad" value="" aria-label="Добавить строку" onChange={(e) => {
        const v = (e.currentTarget as HTMLSelectElement).value;
        (e.currentTarget as HTMLSelectElement).value = "";
        if (v.startsWith("bank")) onAddPads(byBank.get(+v.slice(4)) ?? []);
        else if (v) onAddPads([+v]);
      }} disabled={!options.length}>
        <option value="">+ строка…</option>
        {[...byBank].map(([bank, list]) => (
          <optgroup key={bank} label={`Банк ${"ABCDEFGHIJ"[bank]}`}>
            {list.length > 1 && <option value={`bank${bank}`}>все пады банка {"ABCDEFGHIJ"[bank]} ({list.length})</option>}
            {list.map((i) => <option key={i} value={i}>{padName(i)} {pads.value[i]?.name || "без имени"}</option>)}
          </optgroup>
        ))}
      </select>
      {isDirty(d) && <button class="btn btn-ghost ptn-revert" onClick={() => revert(slot)} title="Вернуть паттерн таким, как он на SP (можно отменить)">сбросить правки</button>}
      {midiState.value !== "ready" && <span class="muted small" title="Шаги слышны через SP по USB-MIDI. Откройте страницу в Chrome и подключите SP">звук: нет MIDI-порта SP</span>}
      <span class="ptn-save-slot"><SaveControl slot={slot} /></span>
    </div>
  );
}

/** Pitch, length and rolls of the picked note; velocity too, as a number. */
function NoteStrip({ slot, d, grid }: { slot: number; d: Draft; grid: number }) {
  const n = d.sel !== null ? findNote(d.p, d.sel) : undefined;
  if (!n) return <div class="ptn-readout idle">Пустая клетка — нота, протяните — ряд нот. Клик по ноте выбирает её, второй клик или правая кнопка убирает (с протяжкой правой — несколько; Delete). Alt+протяжка по ноте вверх-вниз — сила. Тяните ноту — сдвиг, за край — длина. Shift+протяжка — рамка, Shift+клик — добавить к выбору, Ctrl+A — все. Ctrl+C / Ctrl+V / Ctrl+D, стрелки — сдвиг выбранного; без выбора стрелки водят курсор, Enter ставит или убирает ноту. ⋯ у строки и номер такта — их действия.</div>;
  const p = d.p, bt = barTicks(p), inBar = n.tick % bt, off = inBar % STEP, st = semitonesOf(n);
  const lenSteps = (n.gate + 1) / STEP;
  const b = pads.value[n.pad];
  const roll = (k: number) => { const r = rollNote(p, n.seq, k, Math.max(grid, STEP)); if (r.seqs.length) edit(slot, r.pattern, { sel: r.seqs[0] }); };
  return (
    <div class="ptn-readout ptn-notestrip" role="group" aria-label="Выбранная нота">
      <b class="ptn-readout-pad">{padName(n.pad)}</b>
      <span class="ptn-readout-name">{b?.size ? b.name || "без имени" : "пусто"}</span>
      <span>такт {Math.floor(n.tick / bt) + 1}, шаг {Math.floor(inBar / STEP) + 1}{off ? ` +${off}` : ""}</span>
      <label class="ptn-vel" title="Сила удара, 1–127">
        <span class="ptn-vel-label">сила</span>
        <input type="range" min={1} max={127} value={n.velocity}
          onInput={(e) => { held ??= draftOf(slot)!.p; preview(slot, setVelocity(draftOf(slot)!.p, n.seq, +(e.currentTarget as HTMLInputElement).value)); }}
          onChange={() => { if (held) settle(slot, held); held = null; }} />
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

/** Save to the SP: the button, the first-time question for the project, and the stage while it runs. */
export function SaveControl({ slot }: { slot: number }) {
  const why = saveBlockReason(slot), busy = patternWriting.value;
  if (saveConfirm.value === slot) return (
    <span class="ptn-save-ask" role="alertdialog" aria-label="Сохранить паттерн на SP">
      Записать {padName(slot)} на SP в проект {project1.value}? SP на несколько секунд уйдёт в проект {reloadVia()} и вернётся, чтобы перечитать паттерны.
      <button class="btn btn-primary ptn-mini" onClick={() => confirmSave(true)}>Записать</button>
      <button class="btn ptn-mini" onClick={() => confirmSave(false)}>Отмена</button>
    </span>
  );
  if (busy) return <span class="muted small ptn-save-busy">{busy}…</span>;
  return (
    <button class="btn btn-primary ptn-save" disabled={!!why} onClick={() => requestSave(slot)}
      title={why ?? "Записать паттерн на SP (Ctrl+S). SP на несколько секунд уйдёт в другой проект и вернётся, чтобы перечитать паттерны"}>
      <IconUpload /> Сохранить на SP
    </button>
  );
}

export const startEditing = (slot: number): void => { editingSlot.value = slot; };
export const stopEditing = (): void => { editingSlot.value = null; };
