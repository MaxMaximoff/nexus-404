// Paging of the step grid, shared by the read-only view and the editor: a page shows whole bars,
// at most MAX_PAGE_STEPS steps, and a longer pattern is paged, not squeezed.

import { signal } from "@preact/signals";
import { PPQ, type Pattern } from "../sp404";
import { IconChevronLeft, IconChevronRight } from "./icons";

const MAX_PAGE_STEPS = 32;
/** One step of the grid: a sixteenth note. */
export const STEP_TICKS = PPQ / 4;

/** The page shown. It belongs to a slot and starts over when another opens. */
const pageOf = signal({ slot: -1, page: 0 });

export interface Paging {
  barSteps: number;
  barTicks: number;
  totalBars: number;
  barsPerPage: number;
  pages: number;
  page: number;
  /** Columns on the page. */
  steps: number;
  pageTicks: number;
  /** First tick of the page, and where the pattern's part of it ends. */
  from: number;
  to: number;
  /** Bars the page shows, and the share of its width the pattern fills (%). */
  pageBars: number;
  used: number;
  setPage: (v: number) => void;
}

export function pagingOf(slot: number, p: Pattern): Paging {
  const barSteps = p.beatsPerBar * 4, barTicks = p.beatsPerBar * PPQ;
  const totalBars = Math.max(1, Math.ceil(p.length / barTicks));
  const barsPerPage = Math.max(1, Math.floor(MAX_PAGE_STEPS / barSteps));
  const pages = Math.ceil(totalBars / barsPerPage);
  const page = Math.min(pageOf.value.slot === slot ? pageOf.value.page : 0, pages - 1);
  // One page keeps the pattern's own length; with several, every page is as wide as a full one.
  const steps = pages > 1 ? barsPerPage * barSteps : Math.max(1, Math.ceil(p.length / STEP_TICKS));
  const pageTicks = steps * STEP_TICKS, from = page * pageTicks, to = Math.min(from + pageTicks, p.length);
  return {
    barSteps, barTicks, totalBars, barsPerPage, pages, page, steps, pageTicks, from, to,
    pageBars: Math.max(1, Math.ceil((to - from) / barTicks)),
    used: ((to - from) / pageTicks) * 100,
    setPage: (v) => { pageOf.value = { slot, page: Math.max(0, Math.min(pages - 1, v)) }; },
  };
}

/** Pages of the step grid: arrows and, while there are few, a button per page. */
export function Pager({ page, pages, barsPerPage, totalBars, onPage }: { page: number; pages: number; barsPerPage: number; totalBars: number; onPage: (p: number) => void }) {
  const range = (i: number) => {
    const a = i * barsPerPage + 1, b = Math.min(totalBars, (i + 1) * barsPerPage);
    return a === b ? `${a}` : `${a}–${b}`;
  };
  return (
    <div class="ptn-pager" role="group" aria-label="Pattern pages">
      <button class="icon-btn" disabled={page === 0} onClick={() => onPage(page - 1)} title="Previous bars" aria-label="Previous bars"><IconChevronLeft /></button>
      {pages <= 8 ? (
        <div class="segmented">
          {Array.from({ length: pages }, (_, i) => (
            <button key={i} class={i === page ? "on" : ""} aria-pressed={i === page} onClick={() => onPage(i)} title={`Bars ${range(i)}`}>{range(i)}</button>
          ))}
        </div>
      ) : (
        <span class="ptn-pager-label">bars {range(page)} <span class="muted">of {totalBars}</span></span>
      )}
      <button class="icon-btn" disabled={page === pages - 1} onClick={() => onPage(page + 1)} title="Next bars" aria-label="Next bars"><IconChevronRight /></button>
      {pages <= 8 && <span class="muted small">bars, total {totalBars}</span>}
    </div>
  );
}

/** Show the page that holds `tick` (the playhead), when the pattern has several. */
export function followTick(slot: number, p: Pattern, tick: number): void {
  const pg = pagingOf(slot, p);
  if (pg.pages < 2) return;
  const want = Math.min(pg.pages - 1, Math.floor(tick / pg.pageTicks));
  if (want !== pg.page) pg.setPage(want);
}

