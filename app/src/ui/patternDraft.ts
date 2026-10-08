// Drafts: patterns being edited. A draft holds the pattern as the SP has it (`base`), the edited
// one (`p`) and a history of earlier ones. Nothing here touches the unit: until writing patterns is
// checked, a draft lives in memory and leaves as a MIDI file. One draft per slot, kept while the
// project stays open, so switching to another pattern does not lose the edits.

import { signal } from "@preact/signals";
import type { Pattern } from "../sp404";

export interface Draft {
  slot: number;
  /** As read from the SP. */
  base: Pattern;
  p: Pattern;
  undo: Pattern[];
  redo: Pattern[];
  /** The picked note (its seq). */
  sel: number | null;
  /** The pad whose velocities show under the grid. */
  active: number | null;
  /** Pads added by hand: their rows show even without notes. */
  rows: number[];
}

const HISTORY = 200;

export const drafts = signal<ReadonlyMap<number, Draft>>(new Map());
/** The slot being edited (one at a time). While it is set and the patterns are on screen, keys such as Delete belong to the editor and not to the pads. */
export const editingSlot = signal<number | null>(null);

export const draftOf = (slot: number): Draft | undefined => drafts.value.get(slot);
export const isDirty = (d: Draft): boolean => d.p !== d.base;

function put(d: Draft): void {
  const m = new Map(drafts.value);
  m.set(d.slot, d);
  drafts.value = m;
}

export function startDraft(slot: number, base: Pattern): void {
  if (!drafts.value.has(slot)) put({ slot, base, p: base, undo: [], redo: [], sel: null, active: null, rows: [] });
}

export function dropDraft(slot: number): void {
  if (!drafts.value.has(slot)) return;
  const m = new Map(drafts.value);
  m.delete(slot);
  drafts.value = m;
}

type Ui = Partial<Pick<Draft, "sel" | "active" | "rows">>;

/** Change what is picked or shown, not the pattern. */
export function pick(slot: number, ui: Ui): void {
  const d = draftOf(slot);
  if (d) put({ ...d, ...ui });
}

const alive = (p: Pattern, sel: number | null): number | null => (sel !== null && p.notes.some((n) => n.seq === sel) ? sel : null);

/** Make an edit as one step of the history. */
export function edit(slot: number, next: Pattern, ui: Ui = {}): void {
  const d = draftOf(slot);
  if (!d || next === d.p) { if (d) pick(slot, ui); return; }
  const merged = { ...d, ...ui };
  put({ ...merged, p: next, undo: [...d.undo, d.p].slice(-HISTORY), redo: [], sel: alive(next, merged.sel) });
}

/** Show an edit without recording it: for the frames of a drag. End the gesture with `settle`. */
export function preview(slot: number, next: Pattern, ui: Ui = {}): void {
  const d = draftOf(slot);
  if (d) put({ ...d, ...ui, p: next, sel: alive(next, ui.sel === undefined ? d.sel : ui.sel) });
}

/** End of a gesture that began from `before`: record it as one step if it changed anything. */
export function settle(slot: number, before: Pattern): void {
  const d = draftOf(slot);
  if (!d || d.p === before) return;
  put({ ...d, undo: [...d.undo, before].slice(-HISTORY), redo: [] });
}

export function undo(slot: number): void {
  const d = draftOf(slot);
  if (!d?.undo.length) return;
  const p = d.undo[d.undo.length - 1];
  put({ ...d, p, undo: d.undo.slice(0, -1), redo: [...d.redo, d.p], sel: alive(p, d.sel) });
}

export function redo(slot: number): void {
  const d = draftOf(slot);
  if (!d?.redo.length) return;
  const p = d.redo[d.redo.length - 1];
  put({ ...d, p, redo: d.redo.slice(0, -1), undo: [...d.undo, d.p], sel: alive(p, d.sel) });
}

/** Back to the pattern as the SP has it (can still be undone). */
export const revert = (slot: number): void => {
  const d = draftOf(slot);
  if (d) edit(slot, d.base, { sel: null });
};
