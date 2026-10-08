import { beforeAll, describe, expect, it } from "vitest";
import type { Pattern } from "../sp404";

// The tests run in node: a small localStorage for the drafts kept in the browser.
const mem = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
};

let D: typeof import("./patternDraft");
beforeAll(async () => { D = await import("./patternDraft"); });

const pattern = (ticks: number[]): Pattern => ({
  notes: ticks.map((tick, seq) => ({ tick, seq, pad: 0, velocity: 90, offVelocity: 64, gate: 119, pitch: 0x8d })),
  controls: [], length: 1920, bars: 1, beatsPerBar: 4, unknown: 0, records: ticks.length,
});
const FILE = Uint8Array.from([0, 0x2f, 0, 0x8d, 90, 64, 119, 0, 0, 0x8c, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0x80, 1, 1]);

describe("drafts kept in the browser", () => {
  it("tells files apart by checksum and length", () => {
    expect(D.fileSum(FILE)).toBe(D.fileSum(Uint8Array.from(FILE)));
    const other = Uint8Array.from(FILE); other[4] = 91;
    expect(D.fileSum(other)).not.toBe(D.fileSum(FILE));
  });

  it("keeps an edited draft, restores it over the same file, and drops it when the file changed", () => {
    const base = pattern([0]), sum = D.fileSum(FILE);
    D.draftsProject.value = 11;
    D.startDraft(0, base, sum);
    expect(mem.get("nexus404.drafts.11")).toBeUndefined(); // not edited yet: nothing kept
    D.edit(0, pattern([0, 480]));
    D.pick(0, { rows: [5] });
    expect(JSON.parse(mem.get("nexus404.drafts.11")!)["0"].p.notes).toHaveLength(2);

    const back = D.restoreDrafts(11, (slot) => (slot === 0 ? { p: base, sum } : null));
    expect(back.stale).toEqual([]);
    const d = back.map.get(0)!;
    expect(d.p.notes.map((n) => n.tick)).toEqual([0, 480]);
    expect([D.isDirty(d), d.rows, d.undo[0]]).toEqual([true, [5], base]); // can be undone back to the SP's version

    const changed = D.restoreDrafts(11, () => ({ p: base, sum: "24:deadbeef" }));
    expect([changed.map.size, changed.stale]).toEqual([0, [0]]);
    expect(D.restoreDrafts(11, () => null).stale).toEqual([0]); // the pattern is gone from the SP
  });

  it("forgets a draft once it is saved or reverted, and keeps nothing without a project", () => {
    D.dropDraft(0);
    expect(mem.has("nexus404.drafts.11")).toBe(false);
    D.draftsProject.value = null;
    D.startDraft(1, pattern([0]), D.fileSum(FILE));
    D.edit(1, pattern([0, 240]));
    expect([...mem.keys()]).toEqual([]);
  });

  it("keeps a new pattern while its slot is still empty on the SP", () => {
    D.drafts.value = new Map(); // the app sets the drafts and their project together; start clean here
    D.draftsProject.value = 11;
    const empty = pattern([]);
    D.startDraft(7, empty, D.NEW_SLOT);
    D.edit(7, pattern([0, 960]));
    expect(JSON.parse(mem.get("nexus404.drafts.11")!)["7"].base).toBe("new");
    const back = D.restoreDrafts(11, () => null, (slot) => slot === 7);
    const d = back.map.get(7)!;
    expect([d.p.notes.length, d.base.notes.length, D.isDirty(d), d.baseSum]).toEqual([2, 0, true, "new"]);
    expect(D.restoreDrafts(11, () => null, () => false).stale).toEqual([7]); // the slot has a pattern on the SP now
    D.dropDraft(7);
    D.draftsProject.value = null;
  });
});
