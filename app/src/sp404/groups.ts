// Stems put together in groups (vocal, drums, bass, others), each written as one sound per loop,
// and laid out on pads: a group is a column of a bank, a loop a row (vocal on A1, A5, A9, A13,
// drums on A2, A6…). A bank holds four loops; the fifth and on go on in the next bank.

import { BANKS, PAD_COUNT, padName } from "./control";
import type { StemFamily } from "./stems";

/** Groups there are: one per column of a bank. */
export const GROUP_COUNT = 4;
/** Loops a bank holds: one per row. */
export const ROWS = 4;
export const DEFAULT_GROUP_NAMES: readonly string[] = ["vocal", "drums", "bass", "others"];
const COLUMN: Record<StemFamily, number> = { vocal: 0, drums: 1, bass: 2, others: 3 };
const PAD_NAME_MAX = 23;
/** Longest group name in sample names: room for "_A13". */
const SLUG_MAX = PAD_NAME_MAX - 4;

/** Each stem's group (its column) by what the stem is. */
export const defaultGroups = (families: StemFamily[]): number[] => families.map((f) => COLUMN[f]);

/** The pad of loop `loop` (0-based, among those written) of group `group`, from bank `startBank`. */
export const cellPad = (startBank: number, loop: number, group: number): number =>
  (startBank + Math.floor(loop / ROWS)) * 16 + (loop % ROWS) * 4 + group;

/** Banks `loops` loops take. */
export const banksFor = (loops: number): number => Math.ceil(loops / ROWS);

export interface Cell {
  pad: number;
  /** The group's column. */
  group: number;
  /** The loop's place among the loops written (0-based). */
  loop: number;
}

/**
 * Where every loop of every group goes, row by row (all groups of loop 1, then of loop 2…), so a
 * write stopped halfway leaves whole rows. Null when the loops run past the last bank.
 */
export function padLayout(groups: number[], loops: number, startBank: number): Cell[] | null {
  if (startBank < 0 || (startBank + banksFor(loops)) * 16 > PAD_COUNT) return null;
  const cols = [...new Set(groups)].sort((a, b) => a - b);
  const out: Cell[] = [];
  for (let loop = 0; loop < loops; loop++) for (const group of cols) out.push({ pad: cellPad(startBank, loop, group), group, loop });
  return out;
}

/** The banks a layout lies in, as letters: "A", "A–C". */
export function banksText(startBank: number, loops: number): string {
  const last = startBank + Math.max(1, banksFor(loops)) - 1;
  return last === startBank ? BANKS[startBank]! : `${BANKS[startBank]}–${BANKS[last]}`;
}

/**
 * The groups' names as they go into file, folder and pad names: ASCII letters, digits, "-" and
 * "_", short enough for "_A13" after them; an empty one is "group1"…; a name met before gets the
 * column's number ("drums", "drums2").
 */
export function groupSlugs(names: readonly string[]): string[] {
  const seen = new Set<string>();
  return names.map((n, i) => {
    const ascii = n.normalize("NFKD").replace(/[^\x20-\x7e]/g, "").replace(/[^A-Za-z0-9_-]+/g, " ").trim().replace(/ +/g, "_");
    let s = ascii.slice(0, SLUG_MAX) || `group${i + 1}`;
    if (seen.has(s.toLowerCase())) s = `${s.slice(0, SLUG_MAX - 1)}${i + 1}`;
    seen.add(s.toLowerCase());
    return s;
  });
}

/** A loop's sample name on the pad (and its file name without ".wav"): "drums_A1". */
export const groupSampleName = (slug: string, pad: number): string => `${slug}_${padName(pad)}`;
