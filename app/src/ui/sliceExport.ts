// Checked loops, one audible mix each; SD card, pads, or both. Current-loop export stays available.
import { computed, effect, signal } from "@preact/signals";
import { MAX_BARS, PAD_COUNT, loopFileName, loopPattern, trackName, writePattern, type Loop } from "../sp404";
import { exportCancelled, outputOf, slBusy, slCardBlock, slChosen, slCleaning, slGrid, slLoops, slMixFolder, slMixStartPad, slTrack, writeFiles, writePadFiles } from "./slice";
import { conn, createLoopPatterns, demo, importing, notice, pads, patterns, patternsLoading, patternTemplate, patternWriting, project, writeBlockReason } from "./store";
import { drafts } from "./patternDraft";

export type ExportTarget = "card" | "pads" | "both";
const PREFS = "nexus404.slicer.export";
const saved = (() => { try { return JSON.parse(localStorage.getItem(PREFS) ?? "null"); } catch { return null; } })();
export const exportTarget = signal<ExportTarget>(saved?.target === "pads" || saved?.target === "both" ? saved.target : "card");
export { slMixStartPad as exportStartPad, slMixFolder as exportFolder };
export const exportRunning = signal(false);
export const exportMakePatterns = signal(saved?.makePatterns === true);
effect(() => { try { localStorage.setItem(PREFS, JSON.stringify({ target: exportTarget.value, makePatterns: exportMakePatterns.value })); } catch { /* session only */ } });

export const exportLoops = computed(() => slChosen.value);
export const exportCount = computed(() => exportLoops.value.length);
export const exportBytes = computed(() => {
  const out = slTrack.value && outputOf(slTrack.value);
  return out ? exportLoops.value.reduce((n, loop) => n + loop.frames * out.channels * 2 + 44, 0) : 0;
});

function padCells(loops: readonly Loop[]): { pad: number; loop: number }[] | null {
  const start = slMixStartPad.value;
  if (!Number.isInteger(start) || start < 0 || start >= PAD_COUNT) return null;
  const free: number[] = [];
  for (let pad = start; pad < PAD_COUNT && free.length < loops.length; pad++)
    if (!pads.value[pad]?.size && !project.value?.banks[pad >> 4]?.protected &&
      (!exportMakePatterns.value || (!patterns.value?.has(pad) && !drafts.value.has(pad)))) free.push(pad);
  return free.length === loops.length ? free.map((pad, loop) => ({ pad, loop })) : null;
}
export const exportPadCells = computed(() => padCells(exportLoops.value));

export function exportFileName(loop: Loop, destination: "card" | "pads" = "card"): string {
  const index = slLoops.value.findIndex((item) => item.bar === loop.bar);
  return loopFileName(`${trackName(slMixFolder.value)}.wav`, index + 1, slLoops.value.length, slGrid.value!.x100, destination === "pads" ? `${loop.bars}bars` : "");
}

function blockFor(loops: readonly Loop[]): string | null {
  const t = slTrack.value;
  if (!t || !slGrid.value) return "Open a track and set its grid first";
  if (exportRunning.value || slBusy.value || importing.value) return "Writing — wait for it to finish";
  if (slCleaning.value) return "Cleaning the stems — a moment";
  if (!loops.length) return "No loops selected: tick a loop in the list";
  if (!outputOf(t)) return "No audible stems: check Mute / Solo";
  if (!slMixFolder.value.trim()) return "Enter an export name";
  if (exportTarget.value !== "pads" && slCardBlock.value) return slCardBlock.value;
  if (exportTarget.value !== "card") {
    if (conn.value !== "ready") return "SP is not connected";
    if (!demo.value && writeBlockReason.value) return writeBlockReason.value;
    if (patternWriting.value) return "Writing patterns — wait for it to finish";
    if (exportMakePatterns.value) {
      if (patternsLoading.value || patterns.value === null) return "Read the project's patterns first";
      if (!demo.value && !patternTemplate()) return "Record one reference pattern on SP, then refresh the project";
      if (loops.some((loop) => loop.bars > MAX_BARS)) return `Split loops longer than ${MAX_BARS} bars to create patterns`;
    }
    if (!padCells(loops)) return "Not enough free pads for selected loops: choose an earlier starting pad";
  }
  return null;
}
export const exportBlock = computed(() => blockFor(exportLoops.value));

async function executeExport(loops: Loop[]): Promise<void> {
  const t = slTrack.value, g = slGrid.value;
  if (!t || !g || blockFor(loops)) return;
  const out = outputOf(t)!;
  const target = exportTarget.value, folder = trackName(slMixFolder.value), cells = target !== "card" ? padCells(loops)! : [];
  const files = loops.map((loop) => ({ loop, name: exportFileName(loop) }));
  const makePatterns = target !== "card" && exportMakePatterns.value;
  // Capture the entire batch before imports or a project reload change the live state.
  const patternItems = makePatterns ? cells.map(({ pad, loop }) => ({ slot: pad,
    bytes: writePattern(loopPattern(pad, loops[loop]!.bars, g.beatsPerBar), patternTemplate()?.bytes, { fresh: true }) })) : [];
  const padFiles = cells.map(({ pad, loop }) => ({ loop: loops[loop]!, name: exportFileName(loops[loop]!, "pads"), out, pad }));
  exportRunning.value = true;
  try {
    if (target !== "pads") {
      const result = await writeFiles({ ...t, name: `${folder}.wav` }, [{ out: { ...out, label: "", tag: "" }, writtenLabel: "mix", files }], false, true);
      // A failed or stopped card write ends Both before pad assignment starts.
      if (result.failed || result.cancelled || result.done !== result.total) return;
    }
    if (target !== "card") {
      const result = await writePadFiles(t, padFiles, g.x100, { loopPlayback: true, keepBusy: makePatterns });
      if (result.failed || result.cancelled || result.done !== result.total) return;
      if (makePatterns) {
        const written = await createLoopPatterns(patternItems, (text) => (slBusy.value = { text, progress: 1 }), exportCancelled);
        notice.value = { kind: "info", text: `${files.length} loops exported${target === "both" ? " to SD card + pads" : " to pads"}; ${written.done} matching patterns created${written.cancelled ? " (stopped)" : ""}` };
      }
      if (target === "both" && !makePatterns)
        notice.value = { kind: "info", text: `${files.length} loop${files.length === 1 ? "" : "s"} exported to the SD card and assigned to pads` };
    }
  } catch (e) {
    notice.value = { kind: "error", text: `Loop export: ${(e as Error).message}` };
  } finally { slBusy.value = null; exportRunning.value = false; }
}

export async function runExport(): Promise<void> { await executeExport(exportLoops.value); }

/** Kept for the next current-loop UI; not exposed in the present export panel. */
export async function exportCurrentLoop(bar: number): Promise<void> {
  const loop = slLoops.value.find((item) => item.bar === bar);
  if (loop) await executeExport([loop]);
}
