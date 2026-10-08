// Drafts: patterns being edited. A draft holds the pattern as the SP has it (`base`), the edited
// one (`p`) and a history of earlier ones. One draft per slot, so switching to another pattern does
// not lose the edits. Edited drafts are kept in the browser per project (not their history) and
// come back when the project is read again, if the SP's file is still the one they started from.

import { effect, signal } from "@preact/signals";
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
  /** Notes picked together (seq), for moving, copying, deleting several at once; empty for none. */
  group: number[];
  /** The pad whose velocities show under the grid. */
  active: number | null;
  /** Pads added by hand: their rows show even without notes. */
  rows: number[];
  /** Checksum of the SP file the draft started from (fileSum), or NEW_SLOT for a new pattern: without it the draft is not kept in the browser. */
  baseSum?: string;
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

export function startDraft(slot: number, base: Pattern, baseSum?: string): void {
  if (!drafts.value.has(slot)) put({ slot, base, p: base, undo: [], redo: [], sel: null, group: [], active: null, rows: [], baseSum });
}

/** `baseSum` of a draft for a slot that was empty on the SP. */
export const NEW_SLOT = "new";

/** FNV-1a of a file, with its length: tells whether the SP's file is still the one a draft started from. */
export function fileSum(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (const b of bytes) h = Math.imul(h ^ b, 0x01000193) >>> 0;
  return `${bytes.length}:${h.toString(16)}`;
}

/** The project (1-based) the drafts belong to, set when its patterns are read; null: not kept in the browser. */
export const draftsProject = signal<number | null>(null);
const storeKey = (p1: number) => `nexus404.drafts.${p1}`;
interface Kept { p: Pattern; rows: number[]; base: string }

// Keep the edited drafts of the project in the browser, on every change.
effect(() => {
  const p1 = draftsProject.value, m = drafts.value;
  if (p1 === null) return;
  try {
    const keep: Record<number, Kept> = {};
    for (const [slot, d] of m) if (isDirty(d) && d.baseSum) keep[slot] = { p: d.p, rows: d.rows, base: d.baseSum };
    if (Object.keys(keep).length) localStorage.setItem(storeKey(p1), JSON.stringify(keep));
    else localStorage.removeItem(storeKey(p1));
  } catch { /* storage blocked or full: the drafts stay in memory */ }
});

/**
 * The drafts the browser kept for project `p1`, over the patterns just read (`baseOf`: the pattern
 * and its file's sum). A draft whose SP file changed since is dropped and its slot returned in
 * `stale`. A restored draft can be undone back to the SP's version.
 */
export function restoreDrafts(p1: number, baseOf: (slot: number) => { p: Pattern; sum: string } | null, emptyOnSp: (slot: number) => boolean = () => false): { map: Map<number, Draft>; stale: number[] } {
  const map = new Map<number, Draft>(), stale: number[] = [];
  let kept: Record<string, Kept> = {};
  try { kept = JSON.parse(localStorage.getItem(storeKey(p1)) ?? "{}") ?? {}; } catch { /* nothing kept */ }
  for (const [k, v] of Object.entries(kept)) {
    const slot = Number(k), b = baseOf(slot);
    if (v?.base === NEW_SLOT && v.p?.notes) {
      // A new pattern comes back while its slot is still empty on the SP; its base is the empty pattern it began as.
      if (!emptyOnSp(slot)) { stale.push(slot); continue; }
      const base: Pattern = { ...v.p, notes: [], controls: [] };
      map.set(slot, { slot, base, p: v.p, undo: [base], redo: [], sel: null, group: [], active: null, rows: Array.isArray(v.rows) ? v.rows : [], baseSum: NEW_SLOT });
      continue;
    }
    if (!b || !v?.p?.notes || b.sum !== v.base) { stale.push(slot); continue; }
    map.set(slot, { slot, base: b.p, p: v.p, undo: [b.p], redo: [], sel: null, group: [], active: null, rows: Array.isArray(v.rows) ? v.rows : [], baseSum: v.base });
  }
  return { map, stale };
}

export function dropDraft(slot: number): void {
  if (!drafts.value.has(slot)) return;
  const m = new Map(drafts.value);
  m.delete(slot);
  drafts.value = m;
}

type Ui = Partial<Pick<Draft, "sel" | "group" | "active" | "rows">>;

/** Change what is picked or shown, not the pattern. */
export function pick(slot: number, ui: Ui): void {
  const d = draftOf(slot);
  if (d) put({ ...d, ...ui });
}

const alive = (p: Pattern, sel: number | null): number | null => (sel !== null && p.notes.some((n) => n.seq === sel) ? sel : null);
/** The picked notes that still exist in `p`. */
const aliveAll = (p: Pattern, seqs: number[]): number[] => (seqs.length ? seqs.filter((s) => p.notes.some((n) => n.seq === s)) : seqs);

/** Make an edit as one step of the history. */
export function edit(slot: number, next: Pattern, ui: Ui = {}): void {
  const d = draftOf(slot);
  if (!d || next === d.p) { if (d) pick(slot, ui); return; }
  const merged = { ...d, ...ui };
  put({ ...merged, p: next, undo: [...d.undo, d.p].slice(-HISTORY), redo: [], sel: alive(next, merged.sel), group: aliveAll(next, merged.group) });
}

/** Show an edit without recording it: for the frames of a drag. End the gesture with `settle`. */
export function preview(slot: number, next: Pattern, ui: Ui = {}): void {
  const d = draftOf(slot);
  if (d) put({ ...d, ...ui, p: next, sel: alive(next, ui.sel === undefined ? d.sel : ui.sel), group: aliveAll(next, ui.group ?? d.group) });
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
  put({ ...d, p, undo: d.undo.slice(0, -1), redo: [...d.redo, d.p], sel: alive(p, d.sel), group: aliveAll(p, d.group) });
}

export function redo(slot: number): void {
  const d = draftOf(slot);
  if (!d?.redo.length) return;
  const p = d.redo[d.redo.length - 1];
  put({ ...d, p, redo: d.redo.slice(0, -1), undo: [...d.undo, d.p], sel: alive(p, d.sel), group: aliveAll(p, d.group) });
}

/** Back to the pattern as the SP has it (can still be undone). */
export const revert = (slot: number): void => {
  const d = draftOf(slot);
  if (d) edit(slot, d.base, { sel: null });
};
