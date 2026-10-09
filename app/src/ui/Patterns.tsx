// Patterns of the current project: the 160 slots, and a pattern as a step grid (pads as rows,
// 1/16 steps as columns). Notes off the grid (played live) are drawn where they are, not snapped to
// a step. "Править" opens the editor (PatternEditor.tsx) on a draft; nothing is written to the SP.

import { computed, effect, signal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import { BANKS, PPQ, decodeAudio, formatBpm, noteSemitones, padName, parsePattern, patternFileName, type Pattern, type PatternNote } from "../sp404";
import {
  bouncePattern, bouncing, conn, currentPatternFile, downloadPatternMidi, emptyPattern, log, notice, patternFiles, patterns, patternsLoading, patternsOf, pads, project1,
  refreshPatterns, selectPad, selectedBank, selectedPad, tempoFor, writeBlockReason,
} from "./store";
import { IconDownload, IconPencil, IconPlay, IconRefresh, IconStop, IconWave } from "./icons";
import { midiState } from "./midi";
import { playingSlot, stopPattern, togglePattern } from "./ptnPlayer";
import { RowSound, silentClass } from "./PatternRowSound";
import { PatternEditor, SaveControl } from "./PatternEditor";
import { Pager, pagingOf } from "./PatternPager";
import { NEW_SLOT, draftOf, dropDraft, drafts, editingSlot, fileSum, isDirty, pick, revert, startCopy, startDraft } from "./patternDraft";
import { TakeCard } from "./Recorder";
import { recTake, setTake } from "./rec";
import { saveFile } from "./download";
import { showSide } from "./card";

const VIEW_KEY = "nexus404.main.view";
type View = "pads" | "patterns" | "slicer";
function savedView(): View {
  try { const v = localStorage.getItem(VIEW_KEY); return v === "patterns" || v === "slicer" ? v : "pads"; } catch { return "pads"; }
}
/** What the left column shows: banks and pads, the patterns, or the track slicer. */
export const mainView = signal<View>(savedView());
// Playing stops when the patterns leave the screen or the SP goes away.
effect(() => { if (mainView.value !== "patterns" || (conn.value !== "ready" && conn.value !== "loading")) stopPattern(); });

export function showView(v: View): void {
  mainView.value = v;
  try { localStorage.setItem(VIEW_KEY, v); } catch { /* not kept: fine */ }
}

/** The slot picked in the matrix; the first pattern of the project when it has none there. */
const pickedSlot = signal<number | null>(null);
export const shownSlot = computed(() => {
  const m = patterns.value, s = pickedSlot.value;
  if (!m) return null;
  // An empty slot shows too when picked: a new pattern is made there.
  if (s !== null) return s;
  return m.size ? [...m.keys()][0] : null;
});
/** Back from a pattern to one of its pads: the pads screen, that pad in the inspector. */
export function openPad(pad: number): void {
  selectPad(pad);
  showSide("pad");
  showView("pads");
}

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
        <div class="panel-title">Patterns</div>
        <span class="muted small">{m ? `${m.size} of 160` : ""}</span>
        {c === "ready" && (
          <button class="btn btn-ghost" onClick={() => void refreshPatterns()} disabled={patternsLoading.value} title="Read patterns from SP again (after recording on SP)">
            <IconRefresh /> {patternsLoading.value ? "Reading…" : "Refresh"}
          </button>
        )}
      </div>
      {!m ? (
        <p class="muted ptn-empty">{c === "ready" || c === "loading" ? "Reading patterns…" : "Connect SP to view project patterns."}</p>
      ) : (
        <>
          <SlotMatrix />
          {shownSlot.value !== null ? <PatternView /> : <p class="muted ptn-empty">No patterns in this project. Select a slot above to create one, or record one on SP and click ‘Refresh’.</p>}
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
    <div class="ptn-matrix" role="grid" aria-label="Pattern slots">
      {[...BANKS].map((letter, b) => (
        <div class="ptn-mrow" role="row" key={letter}>
          <span class="ptn-mbank">{letter}</span>
          {Array.from({ length: 16 }, (_, i) => {
            const slot = b * 16 + i, p = m.get(slot);
            const edited = drafts.value.get(slot);
            const cls = ["ptn-slot", p !== undefined && (typeof p === "string" ? "bad" : "on"), slot === shown && "cur", ofSel.has(slot) && "uses", edited && isDirty(edited) && "edited"].filter(Boolean).join(" ");
            const title = p === undefined ? `${padName(slot)}: empty`
              : typeof p === "string" ? `${padName(slot)}: not read — ${p}`
              : `${padName(slot)}: ${p.bars} ${bars(p.bars)}, ${p.notes.length} notes${ofSel.has(slot) ? ` · playing ${padName(sel)}` : ""}${edited && isDirty(edited) ? " · edited" : ""}`;
            return <button key={slot} role="gridcell" class={`${cls} ${p === undefined ? "empty" : ""}`} title={p === undefined ? `${padName(slot)}: empty — create a pattern` : title} aria-label={title} onClick={() => (pickedSlot.value = slot)}>{i + 1}</button>;
          })}
        </div>
      ))}
    </div>
  );
}

const bars = (n: number) => (n === 1 ? "bar" : "bars");

function PatternView() {
  const slot = shownSlot.value!, read = patterns.value!.get(slot), d = draftOf(slot);
  if (typeof read === "string") return <p class="err ptn-empty">{padName(slot)}: pattern file could not be read — {read}</p>;
  if (!read && !d) return <NewPattern slot={slot} />;
  const base = read ?? d!.base, isNew = !read;
  const p = d?.p ?? base, dirty = !!d && isDirty(d), editing = editingSlot.value === slot;
  const t = tempoFor(slot >> 4);
  const rows = [...new Set(p.notes.map((n) => n.pad))].sort((a, b) => a - b);
  // TR-REC sub-steps sit between steps on purpose: only notes played live count as off the grid.
  const offGrid = p.notes.filter((n) => n.tick % STEP && noteSemitones(n) === null).length;
  const pitched = p.notes.some((n) => noteSemitones(n));
  // Space plays and stops (not while a field or a button has the focus: they use it themselves).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.ctrlKey || e.metaKey || e.altKey || mainView.value !== "patterns") return;
      if ((e.target as HTMLElement | null)?.closest?.("input, textarea, select, button, [contenteditable]")) return;
      e.preventDefault();
      void togglePattern(slot);
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); if (playingSlot.peek() === slot) stopPattern(); };
  }, [slot]);
  const playing = playingSlot.value === slot, midi = midiState.value === "ready";
  const toggleEdit = () => {
    if (editing) { editingSlot.value = null; if (d && !dirty) dropDraft(slot); return; }
    const f = patternFiles.value.get(slot);
    startDraft(slot, base, isNew ? NEW_SLOT : f ? fileSum(f.bytes) : undefined);
    editingSlot.value = slot;
  };
  return (
    <div class="ptn-view">
      <div class="ptn-info">
        <span class="chip chip-accent">{padName(slot)}</span>
        <button class={`btn ptn-play ${playing ? "card-toggle on" : ""}`} onClick={() => void togglePattern(slot)} aria-pressed={playing}
          title={`${playing ? "Stop" : "Loop playback"} (Space): notes are sent to SP over MIDI${dirty ? ", including your edits" : ""}${midi ? "" : ". No SP MIDI port is available — only the cursor will move"}. TR-REC note transposition is not played`}>
          {playing ? <IconStop /> : <IconPlay />} {playing ? "Stop" : "Play"}
        </button>
        <span>{p.bars} {bars(p.bars)} · {p.beatsPerBar}/4 · {p.notes.length} notes · {rows.length} pads{t ? ` · ${formatBpm(t.tempoX100)} BPM ${t.of}` : ""}</span>
        {offGrid > 0 && !editing && <span class="chip" title="Notes recorded live between 1/16 steps, shown at their actual positions. TR-REC sub-steps are not included">off the 1/16 grid: {offGrid}</span>}
        {isNew && <span class="chip chip-warn" title="This pattern is not on SP yet: it appears after saving">new</span>}
        {dirty && !isNew && <span class="chip chip-warn" title="Edits are stored in the browser: ‘Save to SP’ writes them to the device">edited</span>}
        <CopyButton slot={slot} />
        <button class={`btn ptn-edit-toggle ${editing ? "card-toggle on" : ""}`} onClick={toggleEdit} aria-pressed={editing}
          title={editing ? "Close editor: edits stay in the browser" : "Edit pattern: edits stay in the browser until saved to SP"}>
          <IconPencil /> {editing ? "Done" : "Edit"}
        </button>
        <button class="icon-btn insp-dl" onClick={() => downloadPatternMidi(slot)}
          title={`Download a MIDI file, as exported by SP: channel = bank, A13 = note 36${dirty ? "; including your edits" : ""}${t ? `; tempo ${formatBpm(t.tempoX100)} — the currently active tempo` : ""}`}><IconDownload /> MIDI</button>
        {patternFiles.value.has(slot) && (
          <button class="icon-btn insp-dl ptn-bin" title="Download the pattern file as stored on SP (.BIN, without edits)"
            onClick={() => saveFile(`Proj${project1.value}_${patternFileName(slot)}`, Uint8Array.from(patternFiles.value.get(slot)!.bytes), "application/octet-stream")}><IconDownload /> BIN</button>
        )}
      </div>
      {editing ? <PatternEditor slot={slot} /> : <StepGrid slot={slot} p={p} rows={rows} />}
      {dirty || isNew ? (
        <div class="ptn-dirty-row">
          {!editing && <SaveControl slot={slot} />}
          <span class="muted small">Bounce plays the pattern as stored on SP: edits are not heard until saved.</span>
          {!editing && <button class="btn btn-ghost ptn-revert" onClick={() => revert(slot)}>reset edits</button>}
        </div>
      ) : (
        <Bounce slot={slot} p={base} />
      )}
      {!editing && <p class="hint">Rows are the pads played by the pattern. Click a pad number (A1) to open its sample, or its name to select the pad: the matrix above shows its other patterns. Columns are 1/16 steps; note fill height shows velocity{pitched ? "; colored notes marked ‘+1’, ‘−2’ were transposed in TR-REC" : ""}. ‘Edit’ opens the editor.</p>}
    </div>
  );
}

/** Copy a pattern into this slot of the open project: a draft there, opened in the editor, saved as usual. */
function copyHere(src: number, dst: number): boolean {
  const bytes = currentPatternFile(src), there = draftOf(dst);
  if (!bytes || src === dst) return false;
  if (there && isDirty(there)) {
    notice.value = { kind: "error", text: `In ${padName(dst)} has unsaved edits: save or reset them before copying` };
    return false;
  }
  const p = parsePattern(bytes), had = patterns.value?.get(dst), f = patternFiles.value.get(dst);
  const base = had && typeof had !== "string" ? had : { ...p, notes: [], controls: [] };
  startCopy(dst, base, had && f ? fileSum(f.bytes) : NEW_SLOT, p, bytes, [...new Set(p.notes.map((n) => n.pad))].sort((a, b) => a - b));
  pickedSlot.value = dst;
  editingSlot.value = dst;
  notice.value = { kind: "info", text: `${padName(src)} copied to ${padName(dst)} as a draft: edit it and save to SP` };
  return true;
}

const copyOpen = signal<number | null>(null);

/** “Копировать…”: into another slot of this project, as a draft there. */
function CopyButton({ slot }: { slot: number }) {
  const can = !!currentPatternFile(slot), open = copyOpen.value === slot;
  return (
    <span class="ptn-copy">
      <button class={`btn ptn-edit-toggle ${open ? "card-toggle on" : ""}`} disabled={!can} onClick={() => (copyOpen.value = open ? null : slot)} aria-expanded={open}
        title={can ? "Copy the pattern, including edits, to another slot" : "Only patterns read from SP can be copied"}>copy…</button>
      {open && <CopyPanel slot={slot} />}
    </span>
  );
}

function CopyPanel({ slot }: { slot: number }) {
  const dst = copyTo.value.src === slot ? copyTo.value.dst : firstEmpty(slot), taken = patterns.value?.has(dst);
  return (
    <div class="ptn-menu ptn-copy-panel" role="dialog" aria-label="Copy pattern">
      <div class="ptn-menu-title">copy {padName(slot)}{draftOf(slot) && isDirty(draftOf(slot)!) ? " (including edits)" : ""} to slot</div>
      <div class="ptn-menu-row">
        <select class="project-select" value={dst} onChange={(e) => (copyTo.value = { src: slot, dst: +(e.currentTarget as HTMLSelectElement).value })} aria-label="Slot">
          {[...BANKS].map((letter, b) => (
            <optgroup key={letter} label={`Bank ${letter}`}>
              {Array.from({ length: 16 }, (_, i) => b * 16 + i).filter((s) => s !== slot).map((s) => (
                <option key={s} value={s}>{padName(s)}{patterns.value?.has(s) ? " · occupied" : " · empty"}</option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>
      <p class="muted small ptn-copy-note">The copy becomes a draft in {padName(dst)}{taken ? " replacing the existing pattern" : ""}: edit it and click ‘Save to SP’.</p>
      <div class="ptn-menu-row">
        <button class="btn btn-primary ptn-mini" onClick={() => { if (copyHere(slot, dst)) copyOpen.value = null; }}>Copy</button>
        <button class="btn ptn-mini" onClick={() => (copyOpen.value = null)}>Cancel</button>
      </div>
    </div>
  );
}

/** The copy target being chosen for a pattern. */
const copyTo = signal<{ src: number; dst: number }>({ src: -1, dst: 0 });
/** The next empty slot after `slot` in the open project (or the one after it). */
function firstEmpty(slot: number): number {
  for (let i = 1; i < 160; i++) { const s = (slot + i) % 160; if (!patterns.value?.has(s) && !drafts.value.has(s)) return s; }
  return (slot + 1) % 160;
}

/** An empty slot: make a new pattern there, 1, 2 or 4 bars long, and open the editor on it. */
function NewPattern({ slot }: { slot: number }) {
  const create = (bars: number) => {
    startDraft(slot, emptyPattern(bars), NEW_SLOT);
    // Rows to start with: the loaded pads of the slot's own bank (A5 → bank A), else of the bank open now.
    const of = (bank: number) => Array.from({ length: 16 }, (_, i) => bank * 16 + i).filter((i) => pads.value[i]?.size);
    const rows = of(slot >> 4).length ? of(slot >> 4) : of(selectedBank.value);
    pick(slot, { rows, active: rows[0] ?? null });
    editingSlot.value = slot;
  };
  return (
    <div class="ptn-view">
      <div class="ptn-info">
        <span class="chip chip-accent">{padName(slot)}</span>
        <span>empty — create a pattern:</span>
        {[1, 2, 4].map((b) => <button key={b} class="btn ptn-mini" onClick={() => create(b)}>{b} {bars(b)}</button>)}
      </div>
      <p class="hint">A new pattern is built in the browser and appears on SP after ‘Save to SP’. Its time signature comes from this project's patterns.</p>
    </div>
  );
}

/** The last bounce: its WAV as the SP wrote it, for saving to the computer. */
const lastBounce = signal<{ slot: number; project1: number; wav: Uint8Array<ArrayBuffer> } | null>(null);

/**
 * Bounce: the SP plays the pattern in real time and sends the WAV back. It becomes the take
 * (listen, put on an empty pad with the tempo it played at) and can be saved as a file.
 */
function Bounce({ slot, p }: { slot: number; p: Pattern }) {
  const b = bouncing.value, t = tempoFor(slot >> 4), blocked = writeBlockReason.value;
  const secs = t ? (p.length / PPQ) * (6000 / t.tempoX100) : null;
  const last = lastBounce.value, mine = last?.slot === slot && last.project1 === project1.value;
  const take = recTake.value;
  const run = async () => {
    const wav = await bouncePattern(slot);
    if (!wav) return;
    const bytes = Uint8Array.from(wav);
    lastBounce.value = { slot, project1: project1.value, wav: bytes };
    try {
      const a = await decodeAudio(new Blob([bytes]));
      setTake(a.samples, a.channels, `ptn_${padName(slot)}_bounce`, { bpmX100: t?.tempoX100 ?? null });
      if (secs) log("info", `Bounce ${padName(slot)}: ${(a.frames / 48000).toFixed(2)} s, expected ${secs.toFixed(2)} s (${a.note})`);
    } catch (e) {
      notice.value = { kind: "error", text: `Bounce ${padName(slot)}: could not parse WAV — ${(e as Error).message}. Download it to inspect it` };
    }
  };
  return (
    <div class="ptn-bounce">
      <div class="ptn-bounce-row">
        <button class="btn" disabled={!!blocked || !!b} onClick={() => void run()}
          title={blocked ?? `SP plays the pattern in real time${secs ? ` (~${Math.ceil(secs)} s)` : ""} and sends a WAV. Nothing is written to SP`}>
          <IconWave /> Bounce to WAV
        </button>
        {b?.slot === slot ? (
          <span class="ptn-bounce-prog"><span class="bar"><span style={{ width: `${Math.round(b.progress * 100)}%` }} /></span>SP is playing the pattern… {Math.round(b.progress * 100)} %</span>
        ) : mine ? (
          <button class="icon-btn insp-dl" onClick={() => saveFile(`Proj${last.project1}_${padName(slot)}_BOUNCE.WAV`, last.wav, "audio/wav")}
            title="Save the WAV exactly as received from SP"><IconDownload /> WAV</button>
        ) : (
          <span class="muted small">SP plays the pattern and sends the audio{secs ? ` — about ${Math.ceil(secs)} s` : ""}</span>
        )}
      </div>
      {mine && take?.name === `ptn_${padName(slot)}_bounce` && <TakeCard />}
    </div>
  );
}

/** A note under the pointer or focus (`pinned` false), or kept with a click (`pinned` true). */
const noteFocus = signal<{ slot: number; idx: number; pinned: boolean } | null>(null);

/** What the readout and the note's aria-label say about one note. */
function noteFacts(n: PatternNote, p: Pattern) {
  const barTicks = p.beatsPerBar * PPQ, inBar = n.tick % barTicks, off = n.tick % STEP;
  const st = noteSemitones(n);
  return {
    where: `bar ${Math.floor(n.tick / barTicks) + 1}, step ${Math.floor(inBar / STEP) + 1}${off ? ` +${off} ticks` : ""}`,
    len: `${+(n.gate / STEP).toFixed(2)} steps`,
    pitch: st === null ? (n.pitch ? `byte 3 = 0x${n.pitch.toString(16)}` : "") : st ? `pitch ${signed(st)} st` : "",
    origin: st === null ? "recorded live" : "from TR-REC",
  };
}

function StepGrid({ slot, p, rows }: { slot: number; p: Pattern; rows: number[] }) {
  const pg = pagingOf(slot, p), { barSteps, steps, pageTicks, from, pageBars, used } = pg;
  const sel = selectedPad.value;
  const byPad = new Map<number, { n: PatternNote; idx: number }[]>();
  p.notes.forEach((n, idx) => byPad.set(n.pad, [...(byPad.get(n.pad) ?? []), { n, idx }]));
  const f = noteFocus.value?.slot === slot ? noteFocus.value : null;
  return (
    <>
      {pg.pages > 1 && <Pager page={pg.page} pages={pg.pages} barsPerPage={pg.barsPerPage} totalBars={pg.totalBars} onPage={pg.setPage} />}
      <div class="ptn-scroll" onClick={(e) => { if (f?.pinned && !(e.target as Element).closest(".ptn-note")) noteFocus.value = null; }}>
        <div class="ptn-grid" style={{ "--steps": steps, "--bar": barSteps }} data-slot={slot} data-from={from} data-span={pageTicks}>
          <div class="ptn-playhead" aria-hidden="true" />
          <div class="ptn-ruler-head" />
          <div class="ptn-ruler">
            {Array.from({ length: pageBars }, (_, bar) => (
              <span key={bar} style={{ gridColumn: `span ${Math.min(barSteps, steps - bar * barSteps)}` }}>{pg.page * pg.barsPerPage + bar + 1}</span>
            ))}
          </div>
          {rows.map((pad) => {
            const b = pads.value[pad];
            return [
              <div key={`h${pad}`} class="ptn-row-cell">
                <button class="ptn-row-pad" onClick={() => openPad(pad)} title={`Open ${padName(pad)} in the pad view to edit the sample`}>{padName(pad)}</button>
                <button class={`ptn-row-head ${pad === sel ? "cur" : ""} ${b?.size ? "" : "missing"}`} onClick={() => selectPad(pad)}
                  title={b?.size ? `${padName(pad)} “${b.name}” — select it to highlight the patterns where it plays` : `${padName(pad)} is empty: the pattern plays silence`}>
                  <span>{b?.size ? b.name || "untitled" : "empty"}</span>
                </button>
                <RowSound pad={pad} />
              </div>,
              <div key={`l${pad}`} class={`ptn-lane ${pad === sel ? "cur" : ""} ${used < 100 ? "short" : ""} ${silentClass(pad)}`} style={{ "--used": `${used}%` }}>
                {byPad.get(pad)!.map(({ n, idx }) => <Note key={idx} slot={slot} idx={idx} n={n} p={p} from={from} pageTicks={pageTicks} />)}
              </div>,
            ];
          })}
        </div>
      </div>
      <NoteReadout slot={slot} p={p} />
    </>
  );
}

/** One line under the grid for the note under the pointer: velocity as a number and a meter, and the rest. A click keeps it. */
function NoteReadout({ slot, p }: { slot: number; p: Pattern }) {
  const f = noteFocus.value, n = f?.slot === slot ? p.notes[f.idx] : undefined;
  if (!f || !n) return <div class="ptn-readout idle">Hover over a note to see velocity, length and position. Click to pin the details.</div>;
  const k = noteFacts(n, p), b = pads.value[n.pad];
  return (
    <div class={`ptn-readout ${f.pinned ? "pinned" : ""}`} aria-live="polite">
      <b class="ptn-readout-pad">{padName(n.pad)}</b>
      <span class="ptn-readout-name">{b?.size ? b.name || "untitled" : "empty"}</span>
      <span class="ptn-vel" title="Velocity, 1–127">
        <span class="ptn-vel-label">velocity</span>
        <span class="ptn-vel-meter"><span style={{ width: `${(n.velocity / 127) * 100}%` }} /></span>
        <b>{n.velocity}</b>
      </span>
      <span>{k.where}</span>
      <span>length {k.len}</span>
      {k.pitch && <span>{k.pitch}</span>}
      <span class="muted">{k.origin}</span>
    </div>
  );
}

function Note({ slot, idx, n, p, from, pageTicks }: { slot: number; idx: number; n: PatternNote; p: Pattern; from: number; pageTicks: number }) {
  const end = Math.min(n.tick + Math.max(n.gate, 1), p.length), to = from + pageTicks;
  if (n.tick >= to || end <= from) return null;
  const start = Math.max(n.tick, from), stop = Math.min(end, to);
  const pct = (t: number) => `${((t - from) / pageTicks) * 100}%`;
  const off = n.tick % STEP, st = noteSemitones(n), k = noteFacts(n, p), f = noteFocus.value;
  const here = f?.slot === slot && f.idx === idx;
  const aria = `${padName(n.pad)} · ${k.where} · velocity ${n.velocity} · length ${k.len}${k.pitch ? ` · ${k.pitch}` : ""} · ${k.origin}`;
  const hover = (on: boolean) => { if (!noteFocus.value?.pinned || noteFocus.value.slot !== slot) noteFocus.value = on ? { slot, idx, pinned: false } : null; };
  const pin = () => { noteFocus.value = here && f!.pinned ? null : { slot, idx, pinned: true }; };
  return (
    <span class={`ptn-note ${off ? "off" : ""} ${st ? "pitched" : ""} ${n.tick < from ? "cont-in" : ""} ${end > to ? "cont-out" : ""} ${here ? "focus" : ""}`}
      role="button" tabIndex={0} aria-label={aria} aria-pressed={here && f!.pinned}
      onPointerEnter={() => hover(true)} onPointerLeave={() => hover(false)} onFocus={() => hover(true)} onBlur={() => hover(false)}
      onClick={pin} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pin(); } }}
      style={{ left: pct(start), width: `max(4px, ${((stop - start) / pageTicks) * 100}%)`, "--vel": `${(n.velocity / 127) * 100}%` }}>
      {st ? signed(st) : ""}
    </span>
  );
}
