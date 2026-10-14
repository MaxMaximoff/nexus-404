import { GROUP_COUNT } from "../sp404/groups";

export type StemLane =
  | { kind: "group"; group: number; stems: number[]; top: number; height: number }
  | { kind: "stem"; group: number; stem: number; top: number; height: number };

/** Group buses and their children share exactly the same rows in the headers and waveform. */
export function stemLanes(groups: readonly number[], count: number, collapsed: ReadonlySet<number>): StemLane[] {
  const rows: StemLane[] = [];
  let top = 18;
  for (let group = 0; group < GROUP_COUNT; group++) {
    const stems = Array.from({ length: count }, (_, i) => i).filter((i) => groups[i] === group);
    rows.push({ kind: "group", group, stems, top, height: 40 });
    top += 40;
    if (collapsed.has(group)) continue;
    for (const stem of stems) {
      rows.push({ kind: "stem", group, stem, top, height: 64 });
      top += 64;
    }
  }
  for (let stem = 0; stem < count; stem++) {
    if (groups[stem] !== undefined && groups[stem]! >= 0 && groups[stem]! < GROUP_COUNT) continue;
    rows.push({ kind: "stem", group: -1, stem, top, height: 64 });
    top += 64;
  }
  return rows;
}
