// The track slicer: a long track (or its stems) on a bar grid, cut into loops; the chosen loops go
// to a new folder of IMPORT/ on the SD card (logic in slice.ts).

import { useEffect, useRef, useState } from "preact/hooks";
import { BPM_RANGES, MODE_NAMES, barEdge, barFrames, camelot, formatBpm, keyName, loopFileName, noteName, padName, parseBpmInput } from "../sp404";
import { AUDIO_RE } from "./card";
import { mainView } from "./Patterns";
import {
  OVERVIEW_COLS, addStems, analyze, cancelWrite, folderPreview, removeStem, setGridStem, slGridStem, slMuted, slSilent, slStemBlock, toggleMute,
  outputOf, replay, resetLoopGain, setLoopGain, setStemGain, slGain, slLoopGain, slClean, slCleaning, slKey, slKeyStem, type Stem, cutEvery, joinNext, nudge, openTrack, play, playheadFrame, resetGrid, selLoop, selStep, setAllOff, setBar1, setPreRoll,
  setTempo, slBars, slBusy, slChosen, slCuts, slDetected, slEvery, slFadeMs, slGrid, slLoops, slMetronome, slOff, slPickBar1, slPlay, slPreRollMs, slSel,
  slCardBlock, slState, slTrack, slWriteBlock, writeOne, splitSel, stopPlay, toggleCut, toggleOff, togglePlay, writeLoops, type Track,
  slRestored, startOver, writtenAs,
} from "./slice";
import { bpmRange } from "./store";
import { columns } from "./Waveform";
import { IconPlay, IconPlus, IconScissors, IconStop, IconUpload, IconX } from "./icons";

const RATE = 48000;
const fmtTime = (frames: number) => { const s = frames / RATE; return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`; };
const mb = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MB`;

export function SlicerPane() {
  const t = slTrack.value, st = slState.value;
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (mainView.value !== "slicer" || !slGrid.value || e.ctrlKey || e.metaKey || e.altKey) return;
      if ((e.target as HTMLElement | null)?.closest?.("input, textarea, select, button, [contenteditable], .card-browser")) return;
      const k = e.key;
      if (k === " ") togglePlay();
      else if (k === "ArrowLeft" || k === "ArrowRight") {
        selStep(k === "ArrowLeft" ? -1 : 1);
        if (slPlay.value && slSel.value !== null) play(slSel.value);
      } else if (k.toLowerCase() === "s") splitSel();
      else if (k.toLowerCase() === "j") joinNext();
      else if (k === "Enter" && slSel.value !== null) toggleOff(slSel.value);
      else if (k === "Escape") { slPickBar1.value = false; stopPlay(); }
      else return;
      e.preventDefault();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  /** One file: a track; several: stems of one track. */
  const take = (files: FileList | null | undefined) => {
    const audio = [...(files ?? [])].filter((x) => AUDIO_RE.test(x.name) || x.type.startsWith("audio/"));
    if (audio.length) void openTrack(audio);
  };

  return (
    <section class={`ptn-area glass slicer ${over ? "drop" : ""}`}
      onDragOver={(e) => { if (e.dataTransfer?.types.includes("Files")) { e.preventDefault(); setOver(true); } }}
      onDragLeave={(e) => { if (!(e.currentTarget as Element).contains(e.relatedTarget as Node)) setOver(false); }}
      onDrop={(e) => { e.preventDefault(); setOver(false); take(e.dataTransfer?.files); }}>
      <div class="ptn-head">
        <div class="panel-title">Slicer</div>
        {t && <span class="muted small sl-file" title={t.name}>{t.pad !== undefined ? `pad ${padName(t.pad)} · ${t.name.replace(/\.wav$/, "")}` : t.stems.length > 1 ? `${t.name.replace(/\.wav$/, "")} · ${t.stems.length} stems` : t.name} · {fmtTime(t.frames)}{t.stems.length === 1 ? ` · ${t.stems[0]!.channels === 1 ? "mono" : "stereo"}` : ""}</span>}
        <button class="btn btn-ghost" disabled={!!slBusy.value || st === "decoding"} onClick={() => input.current?.click()}
          title="One file: a track. Several files at once: stems of one track (vocals, instrumental…)">Open track or stems…</button>
        <input ref={input} type="file" accept="audio/*,.wav,.aif,.aiff,.flac,.mp3,.ogg,.m4a" multiple hidden
          onChange={(e) => { take((e.target as HTMLInputElement).files); (e.target as HTMLInputElement).value = ""; }} />
      </div>
      {st === "decoding" || (!t && st === "analyzing") ? <p class="muted ptn-empty">Decoding…</p>
        : !t ? (
          <div class={`dropzone ${over ? "drop" : ""}`}>
            <IconScissors />
            <b>Drop a long track or its stems here, or open them</b>
            <span class="muted">WAV, AIFF, FLAC, MP3… up to 15 minutes. Tempo and bars are found here; the loops are written to a new folder of IMPORT on the SD card, and from there you put them on pads.</span>
            <span class="muted">Stems of one track (vocals and instrumental from UVR, the four of Demucs…): drop them together. They share one grid and the same cuts; each stem's loops go to its own subfolder with matching numbers.</span>
          </div>
        ) : (
          <>
            <GridBar />
            <CutBar />
            <StemBar track={t} />
            {st === "analyzing" ? <div class="sl-wave sl-wave-wait muted">Finding tempo and bars…</div> : slGrid.value && <SliceWave track={t} />}
            {slGrid.value && st === "ready" && <><LoopMix track={t} /><LoopList /><WriteBar track={t} /></>}
          </>
        )}
    </section>
  );
}

const fmtDb = (v: number) => (v === 0 ? "0 dB" : `${v > 0 ? "+" : "−"}${Math.abs(v)} dB`);

/** A small volume slider in dB: dragging is heard on release, a double click goes back to 0 dB. */
function Gain({ value, min, max, label, onSet }: { value: number; min: number; max: number; label: string; onSet: (db: number) => void }) {
  return (
    <span class="sl-gain" title={`${label}: ${fmtDb(value)} (double-click: 0 dB)`}>
      <input type="range" min={min} max={max} step={0.5} value={value} aria-label={label}
        onInput={(e) => onSet(+(e.target as HTMLInputElement).value)} onChange={replay}
        onDblClick={() => { onSet(0); replay(); }} />
      <span class={`sl-gain-v ${value ? "set" : ""}`}>{fmtDb(value)}</span>
    </span>
  );
}

/** The picked loop's own balance of the stems, on top of each stem's volume. */
function LoopMix({ track }: { track: Track }) {
  const l = selLoop();
  if (!l || track.stems.length < 2) return null;
  const m = slLoopGain.value.get(l.bar), n = slChosen.value.findIndex((x) => x.bar === l.bar);
  return (
    <div class="sl-bar sl-loopmix">
      <span class="muted">Loop {n >= 0 ? String(n + 1).padStart(2, "0") : "—"} · bars {l.bar}–{l.bar + l.bars - 1} · volume</span>
      {track.stems.map((x, i) => (
        <span key={`${i}:${x.name}`} class={`sl-loopmix-stem ${slMuted.value.has(i) ? "muted" : ""}`}>
          {x.label}
          <Gain value={m?.get(i) ?? 0} min={-12} max={12} label={`${x.label} in this loop, on top of its own volume`} onSet={(v) => setLoopGain(l.bar, i, v)} />
        </span>
      ))}
      {m ? <button type="button" class="btn btn-ghost" onClick={() => { resetLoopGain(l.bar); replay(); }} title="This loop back to the stems' own volumes">Reset</button>
        : <span class="muted small">on top of each stem's own volume</span>}
    </div>
  );
}

/** The track's stems as a whole: the clean-up, add more (each stem's own controls sit at its lane). */
function StemBar({ track }: { track: Track }) {
  const busy = slState.value !== "ready" || !!slBusy.value, multi = track.stems.length > 1;
  const input = useRef<HTMLInputElement>(null);
  return (
    <div class="sl-bar sl-stems">
      <span class="muted">{multi ? "Stems" : "Track"}</span>
      {!multi && <span class="small sl-stem-one" title={track.stems[0]!.name}>{track.stems[0]!.name}</span>}
      {multi && (
        <label class="sl-field sl-clean" title={"Clean-up of separation leftovers, heard and written (the stems on disk stay as they are):\n• vocals: low cut, de-esser on the \u2018s\u2019 band, a soft cut of the top;\n• instrumental, drums, other: the \u2018s\u2019 band ducked only while the vocals have an \u2018s\u2019 (their leftovers), the same soft top cut;\n• bass: as it is."}>
          <span class="muted">Clean-up</span>
          <select value={slClean.value} disabled={busy} onChange={(e) => (slClean.value = (e.target as HTMLSelectElement).value as typeof slClean.value)}>
            {(["off", "light", "medium", "strong"] as const).map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
          {slCleaning.value && <span class="muted small">cleaning…</span>}
        </label>
      )}
      <button type="button" class="btn" disabled={busy} onClick={() => input.current?.click()}
        title="Add stems of this track (the same length): each gets its own subfolder on the card"><IconPlus /> Add stem…</button>
      <input ref={input} type="file" accept="audio/*,.wav,.aif,.aiff,.flac,.mp3,.ogg,.m4a" multiple hidden
        onChange={(e) => { void addStems([...((e.target as HTMLInputElement).files ?? [])]); (e.target as HTMLInputElement).value = ""; }} />
    </div>
  );
}

/** Tempo, the tempo range, bar 1 and moving the grid. */
function GridBar() {
  const g = slGrid.value, det = slDetected.value, busy = slState.value === "analyzing" || !!slBusy.value;
  const [text, setText] = useState("");
  const shown = g ? formatBpm(g.x100) : "";
  useEffect(() => setText(shown), [shown]);
  const parsed = parseBpmInput(text);
  const apply = () => { if (parsed && "x100" in parsed) setTempo(parsed.x100); else setText(shown); };
  const changed = !!g && !!det && (g.x100 !== det.x100 || g.origin !== det.origin);
  return (
    <div class="sl-bar">
      <label class="sl-field">
        <span class="muted">Tempo</span>
        <input class={`value-field ${parsed && "error" in parsed ? "invalid" : ""}`} style={{ width: "64px" }} type="text" inputMode="decimal" spellcheck={false}
          disabled={!g || busy} value={text} aria-label="Track tempo, BPM" title={parsed && "error" in parsed ? parsed.error : "Track tempo: Enter to apply (the cuts are laid out again)"}
          onInput={(e) => setText((e.target as HTMLInputElement).value)} onBlur={apply}
          onKeyDown={(e) => { if (e.key === "Enter") apply(); if (e.key === "Escape") { setText(shown); (e.target as HTMLInputElement).blur(); } }} />
        <span class="muted">BPM</span>
      </label>
      <span class="segmented" role="group" aria-label="Double or halve the tempo">
        <button type="button" disabled={!g || busy} onClick={() => g && setTempo(g.x100 * 2)} title="Double the tempo">×2</button>
        <button type="button" disabled={!g || busy} onClick={() => g && setTempo(Math.round(g.x100 / 2))} title="Halve the tempo">÷2</button>
      </span>
      <select class="sl-range" value={bpmRange.value} disabled={busy} aria-label="Tempo range for detection" title="Tempo range for detection: the tempo is looked for in this octave"
        onChange={(e) => { bpmRange.value = +(e.target as HTMLSelectElement).value; void analyze(); }}>
        {BPM_RANGES.map(([a, b], i) => <option key={i} value={i}>{a}–{b}</option>)}
      </select>
      <span class="sl-sep" />
      <button type="button" class={`btn ${slPickBar1.value ? "btn-primary" : ""}`} disabled={!g || busy} aria-pressed={slPickBar1.value}
        onClick={() => (slPickBar1.value = !slPickBar1.value)} title="Then click the beat on the wave where a bar starts (snaps to the nearest beat)">
        {slPickBar1.value ? "Click a beat…" : "Set bar 1"}
      </button>
      <span class="segmented dense" role="group" aria-label="Move the grid">
        <button type="button" disabled={!g || busy} onClick={() => nudge(-10)} title="Grid 10 ms earlier">−10</button>
        <button type="button" disabled={!g || busy} onClick={() => nudge(-1)} title="Grid 1 ms earlier">−1</button>
        <button type="button" disabled={!g || busy} onClick={() => nudge(1)} title="Grid 1 ms later">+1</button>
        <button type="button" disabled={!g || busy} onClick={() => nudge(10)} title="Grid 10 ms later">+10</button>
      </span>
      <span class="muted small">ms</span>
      {changed && <button type="button" class="btn btn-ghost" disabled={busy} onClick={resetGrid} title={`Back to the detected grid: ${formatBpm(det!.x100)} BPM`}>Reset grid</button>}
      <span class="muted small sl-detected">
        {slState.value === "analyzing" ? "Analysing…" : <>
          {slRestored.value && <span class="sl-restored" title="This track was opened before: its grid, cuts and choices are as you left them">From last time · </span>}
          {det ? `Detected ${formatBpm(det.x100)} BPM · pulse ${Math.round(det.clarity * 100)} %` : g ? "No clear beat: set by hand" : ""}
        </>}
      </span>
      {slRestored.value && slState.value === "ready" && (
        <button type="button" class="btn btn-ghost" disabled={busy} onClick={startOver}
          title="Forget the grid, the cuts and the choices kept from last time, and find the tempo and bars anew (the marks of loops already on the card stay)">Start over</button>
      )}
      {slState.value === "ready" && <KeyChip />}
    </div>
  );
}

/** The detected key: name and Camelot code; the next best when it is nearly as likely. */
function KeyChip() {
  const k = slKey.value, t = slTrack.value;
  if (k === undefined) return <span class="sl-key muted small">Key…</span>;
  if (!k) return <span class="sl-key muted small" title="No held tones to go by (drums only, speech, noise)">No clear key</span>;
  const close = k.altLead < KEY_CLOSE;
  const from = t && t.stems.length > 1 ? ` from ${t.stems[slKeyStem.value]?.label}` : "";
  // Plain major and minor go without a word; any other mode is named, with "?" when barely ahead.
  const plain = k.mode === "ionian" || k.mode === "aeolian", unsure = k.modeLead < MODE_SURE;
  return (
    <span class="sl-key small" title={`Key${from}: ${keyName(k)} ${MODE_NAMES[k.mode]} (Camelot ${camelot(k)}); next mode on this tonic: ${MODE_NAMES[k.modeAlt]}, ${k.modeLead.toFixed(3)} behind. Next home note: ${keyName(k.alt)} ${MODE_NAMES[k.alt.mode]}, ${k.altLead.toFixed(3)} behind. Tuning ${k.cents >= 0 ? "+" : ""}${k.cents} cents from A = 440.
Notes from the tonic up, % of all: ${profile(k)}.
A guess: relative keys (Am / C), keys a fifth apart and neighbouring modes are easy to mix up.`}>
      <b>{keyName(k)}</b>
      {(!plain || unsure) && <span class="sl-mode"> {plain ? "" : MODE_NAMES[k.mode]}{unsure ? (plain ? `${MODE_NAMES[k.mode]}?` : "?") : ""}</span>}
      {" "}<span class="muted">{camelot(k)}</span>
      {close && <span class="muted"> · or {keyName(k.alt)}{k.alt.mode === "ionian" || k.alt.mode === "aeolian" ? "" : ` ${MODE_NAMES[k.alt.mode]}`} {camelot(k.alt)}</span>}
    </span>
  );
}

/** How much each note sounds, from the tonic up: "F 23 · Gb 9 · G 2 …" (percent). */
function profile(k: { tonic: number; minor: boolean; chroma: number[] }): string {
  return Array.from({ length: 12 }, (_, i) => `${noteName(k.tonic + i, k.minor)} ${Math.round(k.chroma[(k.tonic + i) % 12]! * 100)}`).join(" · ");
}

/** The next best home note is shown when it is this close behind (joint search score). */
const KEY_CLOSE = 0.08;
/** A mode less than this ahead of the next one on the same tonic is shown with "?". */
const MODE_SURE = 0.03;

/** How the track is cut, and how the loops sound. */
function CutBar() {
  const g = slGrid.value, l = selLoop(), busy = !!slBusy.value;
  const next = l && slLoops.value.some((x) => x.bar === l.bar + l.bars);
  return (
    <div class="sl-bar">
      <span class="muted">Cut every</span>
      <span class="segmented" role="group" aria-label="Cut every N bars">
        {[1, 2, 4, 8, 16].map((n) => (
          <button key={n} type="button" class={slEvery.value === n ? "on" : ""} aria-pressed={slEvery.value === n} disabled={!g || busy}
            onClick={() => cutEvery(n)} title={`Cut the whole track into loops of ${n} bar${n > 1 ? "s" : ""} (manual cuts are reset)`}>{n}</button>
        ))}
      </span>
      <span class="muted">bars</span>
      <button type="button" class="btn" disabled={!l || l.bars < 2 || busy} onClick={splitSel} title="Split the picked loop in two (S)">Split</button>
      <button type="button" class="btn" disabled={!next || busy} onClick={joinNext} title="Join the picked loop with the next one (J)">Join →</button>
      <span class="sl-sep" />
      <label class="sl-field" title="Every cut this much before the bar line, for hits that come a little early">
        <span class="muted">Pre-roll</span>
        <select value={slPreRollMs.value} disabled={busy} onChange={(e) => setPreRoll(+(e.target as HTMLSelectElement).value)}>
          {[0, 2, 5, 10, 20].map((v) => <option key={v} value={v}>{v} ms</option>)}
        </select>
      </label>
      <label class="sl-field" title="Short fade at both ends of each loop, against clicks">
        <span class="muted">Fades</span>
        <select value={slFadeMs.value} disabled={busy} onChange={(e) => (slFadeMs.value = +(e.target as HTMLSelectElement).value)}>
          {[0, 1, 3, 5].map((v) => <option key={v} value={v}>{v ? `${v} ms` : "off"}</option>)}
        </select>
      </label>
      <button type="button" class={`btn ${slMetronome.value ? "btn-primary" : ""}`} aria-pressed={slMetronome.value}
        onClick={() => { slMetronome.value = !slMetronome.value; if (slPlay.value) play(slPlay.value.bar, !slPlay.value.loop); }}
        title="Clicks on the beats while listening, to check the grid (not written to the files)">Metronome</button>
    </div>
  );
}

interface View { from: number; to: number }

/** Min/max per column from the overview peaks, for columns wider than one overview column. */
function aggregate(peaks: Float32Array[], a: number, b: number, cols: number): Float32Array[] {
  return peaks.map((p) => {
    const out = new Float32Array(cols * 2);
    for (let i = 0; i < cols; i++) {
      const from = Math.floor(a + ((b - a) * i) / cols), to = Math.max(from + 1, Math.floor(a + ((b - a) * (i + 1)) / cols));
      let lo = 0, hi = 0;
      for (let j = Math.max(0, from); j < Math.min(to, p.length / 2); j++) { lo = Math.min(lo, p[j * 2]!); hi = Math.max(hi, p[j * 2 + 1]!); }
      out[i * 2] = lo; out[i * 2 + 1] = hi;
    }
    return out;
  });
}

/** Min/max per column of a stem over frames [a, b), per channel: from the overview peaks when coarse enough, else from the samples. */
function stemColumns(stem: Stem, a: number, b: number, cols: number): Float32Array[] {
  const perCol = ((b - a) / stem.frames) * OVERVIEW_COLS / cols;
  return perCol >= 1
    ? aggregate(stem.peaks, (a / stem.frames) * OVERVIEW_COLS, (b / stem.frames) * OVERVIEW_COLS, cols)
    : columns(stem.samples, stem.channels, a, b, cols);
}

/** One lane from several channels: the lowest min and the highest max per column. */
function mergeChannels(chans: Float32Array[]): Float32Array {
  const out = new Float32Array(chans[0]!.length);
  for (let i = 0; i < out.length; i += 2) {
    let lo = 0, hi = 0;
    for (const c of chans) { lo = Math.min(lo, c[i]!); hi = Math.max(hi, c[i + 1]!); }
    out[i] = lo; out[i + 1] = hi;
  }
  return out;
}

/** The column at the left of the wave, a header per stem lane: mute, the grid's stem, volume, take it out. */
function StemLanes({ track }: { track: Track }) {
  const busy = slState.value !== "ready" || !!slBusy.value;
  return (
    <div class="sl-lanes">
      <div class="sl-lanes-top" />
      {track.stems.map((x, i) => {
        const muted = slMuted.value.has(i), grid = slGridStem.value === i;
        return (
          <div key={`${i}:${x.name}`} class={`sl-lane ${muted ? "muted" : ""}`}>
            <div class="sl-lane-row">
              <span class="sl-lane-name" title={x.name}>{x.label}</span>
              <button type="button" class={`sl-lane-grid ${grid ? "on" : ""}`} aria-pressed={grid} disabled={busy || grid}
                onClick={() => setGridStem(i)} title={grid ? "The grid is built from this stem" : "Build the grid from this stem"}>◆</button>
              <button type="button" class="sl-lane-x" disabled={busy} onClick={() => removeStem(i)} aria-label={`Remove ${x.label}`} title="Take this stem out"><IconX /></button>
            </div>
            <div class="sl-lane-row">
              <button type="button" class={`sl-lane-mute ${muted ? "on" : ""}`} aria-pressed={muted} onClick={() => toggleMute(i)}
                title={muted ? `${x.label} is muted: not heard, not written; click to bring it back` : `Mute ${x.label} (several heard: written as one mix)`}>M</button>
              <Gain value={slGain.value.get(i) ?? 0} min={-24} max={6} label={`${x.label} volume, every loop`} onSet={(v) => setStemGain(i, v)} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

const LINE_GRAB_PX = 8;

/** The track's wave with the bar grid, the cuts and the loops; click a bar line to cut, a loop to hear it. */
function SliceWave({ track }: { track: Track }) {
  const base = useRef<HTMLCanvasElement>(null), top = useRef<HTMLCanvasElement>(null), head = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ from: 0, to: track.frames });
  const [size, setSize] = useState({ w: 600, h: 200 });
  const [hover, setHover] = useState<{ frame: number; x: number } | null>(null);
  const drag = useRef<{ x: number; view: View; moved: boolean } | null>(null);
  const g = slGrid.value!, bars = slBars.value, loops = slLoops.value, cuts = slCuts.value, off = slOff.value, sel = slSel.value;
  const pre = Math.round((slPreRollMs.value * RATE) / 1000);
  const span = view.to - view.from;
  const X = (f: number) => ((f - view.from) / span) * size.w;
  const frameAt = (x: number) => view.from + (x / size.w) * span;

  useEffect(() => setView({ from: 0, to: track.frames }), [track]);
  // The track may be moved half a view past either end, so its start or end can sit mid-view.
  const clamp = (from: number, s: number): View => {
    const sp = Math.min(track.frames, Math.max(size.w, s));
    const f = Math.min(Math.max(-sp / 2, from), track.frames - sp / 2);
    return { from: f, to: f + sp };
  };

  // Keep the picked loop in sight when it changes from the keyboard or the list.
  useEffect(() => {
    const l = loops.find((x) => x.bar === sel);
    if (!l || (l.start >= view.from && l.start + l.frames <= view.to)) return;
    setView((v) => clamp(l.start + l.frames / 2 - (v.to - v.from) / 2, v.to - v.from));
  }, [sel]);

  useEffect(() => {
    const c = base.current!;
    const ro = new ResizeObserver(() => setSize({ w: c.clientWidth, h: c.clientHeight }));
    ro.observe(c);
    return () => ro.disconnect();
  }, []);

  const prep = (c: HTMLCanvasElement) => {
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(size.w * dpr); c.height = Math.round(size.h * dpr);
    const x = c.getContext("2d")!;
    x.scale(dpr, dpr);
    x.clearRect(0, 0, size.w, size.h);
    return x;
  };
  const hue = () => getComputedStyle(base.current!).getPropertyValue("--ah").trim() || "180";

  // The wave: only when the view, the size or the stems change. One stem: a lane per channel;
  // several: a lane per stem (channels together), dimmer when muted; its header is in the column at the left.
  const muted = slMuted.value, multi = track.stems.length > 1;
  useEffect(() => {
    const x = prep(base.current!), ah = hue(), h = size.h;
    const lanes: { p: Float32Array; x0: number; cols: number; stem: number }[] = [];
    track.stems.forEach((stem, si) => {
      // Only the part of the view that has audio (the view may reach past the stem's ends).
      const a = Math.max(0, view.from), b = Math.min(stem.frames, view.to);
      if (b <= a) return;
      const x0 = Math.round(X(a)), cols = Math.max(1, Math.round(X(b)) - x0);
      const chans = stemColumns(stem, a, b, cols);
      if (multi) lanes.push({ p: mergeChannels(chans), x0, cols, stem: si });
      else chans.forEach((p) => lanes.push({ p, x0, cols, stem: si }));
    });
    const n = multi ? track.stems.length : lanes.length, laneH = (h - 18) / Math.max(1, n);
    lanes.forEach(({ p, x0, cols, stem }, li) => {
      const lane = multi ? stem : li, mid = 18 + laneH * lane + laneH / 2, amp = laneH * 0.46, dim = muted.has(stem);
      x.fillStyle = `hsl(${ah} 90% 55% / ${dim ? 0.12 : 0.42})`;
      x.strokeStyle = `hsl(${ah} 85% 56% / ${dim ? 0.3 : 0.9})`;
      x.lineWidth = 1;
      x.beginPath();
      for (let i = 0; i < cols; i++) x.lineTo(x0 + i, mid - Math.max(p[i * 2 + 1]!, 0.004) * amp);
      for (let i = cols - 1; i >= 0; i--) x.lineTo(x0 + i, mid - Math.min(p[i * 2]!, -0.004) * amp);
      x.closePath(); x.fill(); x.stroke();
    });
    if (!multi) return;
    x.fillStyle = "rgba(255, 255, 255, 0.08)";
    for (let i = 1; i < track.stems.length; i++) x.fillRect(0, Math.round(18 + laneH * i), size.w, 1);
  }, [track, view.from, view.to, size.w, size.h, muted]);

  // The grid, the cuts and the loops on top.
  useEffect(() => {
    const x = prep(top.current!), ah = hue(), w = size.w, h = size.h;
    const barPx = (barFrames(g) / span) * w;
    const labelTop = 13;
    // Outside the loops: dimmed.
    x.fillStyle = "rgba(6, 10, 14, 0.5)";
    let cursor = view.from;
    for (const l of loops) {
      if (l.start > cursor) x.fillRect(X(cursor), 0, X(l.start) - X(cursor), h);
      cursor = Math.max(cursor, l.start + l.frames);
    }
    if (cursor < view.to) x.fillRect(X(cursor), 0, w - X(cursor), h);
    // The loops: alternate washes, left-out ones dimmed, the picked one outlined; their numbers.
    let n = 0;
    x.font = "600 11px 'Inter Variable', system-ui, sans-serif";
    loops.forEach((l, i) => {
      const on = !off.has(l.bar);
      if (on) n++;
      const x0 = X(l.start), x1 = X(l.start + l.frames);
      if (x1 < 0 || x0 > w) return;
      x.fillStyle = !on ? "rgba(6, 10, 14, 0.62)" : `hsl(${ah} 90% 50% / ${l.bar === sel ? 0.16 : i % 2 ? 0.03 : 0.08})`;
      x.fillRect(x0, 18, x1 - x0, h - 18);
      if (l.bar === sel) {
        x.strokeStyle = `hsl(${ah} 90% 62%)`;
        x.lineWidth = 1.5;
        x.strokeRect(x0 + 0.75, 18.75, x1 - x0 - 1.5, h - 19.5);
      }
      const label = on ? `${String(n).padStart(2, "0")}${x1 - x0 > 60 ? ` · ${l.bars} bar${l.bars > 1 ? "s" : ""}` : ""}` : x1 - x0 > 40 ? "off" : "";
      if (x1 - x0 > 26 && label) {
        x.fillStyle = on ? `hsl(${ah} 90% 78%)` : "rgba(160, 175, 190, 0.6)";
        x.fillText(label, Math.max(x0, 0) + 5, h - 7);
      }
    });
    if (!bars) return;
    // Bar lines (and beats when there is room), cuts brighter; bar numbers along the top.
    const step = [1, 2, 4, 8, 16, 32, 64, 128].find((s) => s * barPx >= 34) ?? 256;
    const firstBar = Math.max(bars.first, Math.floor((view.from + pre - g.origin) / barFrames(g)) + 1);
    const lastBar = Math.min(bars.last + 1, Math.ceil((view.to + pre - g.origin) / barFrames(g)) + 1);
    for (let b = firstBar; b <= lastBar; b++) {
      const bx = Math.round(X(barEdge(g, b, pre))) + 0.5, cut = cuts.has(b);
      if (cut) {
        x.strokeStyle = `hsl(${ah} 90% 60%)`; x.lineWidth = 1.5;
        x.shadowColor = `hsl(${ah} 90% 50% / 0.8)`; x.shadowBlur = 4;
      } else {
        x.strokeStyle = barPx >= 5 ? "rgba(255, 255, 255, 0.13)" : "rgba(255, 255, 255, 0.05)"; x.lineWidth = 1;
      }
      x.beginPath(); x.moveTo(bx, cut ? 0 : 18); x.lineTo(bx, h); x.stroke();
      x.shadowBlur = 0;
      if (barPx >= 48) {
        x.strokeStyle = "rgba(255, 255, 255, 0.07)";
        for (let k = 1; k < g.beatsPerBar; k++) {
          const tx = Math.round(X(barEdge(g, b, pre) + (k * barFrames(g)) / g.beatsPerBar)) + 0.5;
          x.beginPath(); x.moveTo(tx, 18); x.lineTo(tx, 26); x.stroke();
        }
      }
      if ((((b - 1) % step) + step) % step === 0) {
        x.fillStyle = b === 1 ? `hsl(${ah} 100% 74%)` : cut ? `hsl(${ah} 80% 70%)` : "rgba(170, 185, 200, 0.75)";
        x.fillText(String(b), bx + 3, labelTop);
      }
    }
    // Picking bar 1: the beat it would snap to.
    if (slPickBar1.value && hover) {
      const beat = barFrames(g) / g.beatsPerBar;
      const f = g.origin + Math.round((hover.frame - g.origin) / beat) * beat;
      const hx = Math.round(X(f)) + 0.5;
      x.strokeStyle = "#fff"; x.setLineDash([4, 3]); x.lineWidth = 1;
      x.beginPath(); x.moveTo(hx, 0); x.lineTo(hx, h); x.stroke();
      x.setLineDash([]);
    }
  }, [g, loops, cuts, off, sel, bars, view.from, view.to, size.w, size.h, slPickBar1.value, hover, pre]);

  // The playhead follows the sound.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const f = playheadFrame(), el = head.current;
      if (el) {
        const px = f === null ? -1 : ((f - view.from) / span) * size.w;
        el.style.display = px >= 0 && px <= size.w ? "block" : "none";
        el.style.transform = `translateX(${px}px)`;
      }
      if (slPlay.value) raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [slPlay.value, view.from, view.to, size.w]);

  /** The bar line within reach of pixel `px`, or null. */
  const lineAt = (px: number): number | null => {
    if (!bars) return null;
    const b = Math.round((frameAt(px) + pre - g.origin) / barFrames(g)) + 1;
    if (b < bars.first || b > bars.last + 1) return null;
    return Math.abs(X(barEdge(g, b, pre)) - px) <= LINE_GRAB_PX ? b : null;
  };
  const click = (px: number) => {
    const f = frameAt(px);
    if (slPickBar1.value) return setBar1(f);
    const line = lineAt(px);
    if (line !== null) return toggleCut(line);
    const l = loops.find((x) => f >= x.start && f < x.start + x.frames);
    if (!l) return;
    if (slSel.value === l.bar && slPlay.value?.bar === l.bar) return stopPlay();
    slSel.value = l.bar;
    play(l.bar);
  };
  const pos = (e: MouseEvent) => e.clientX - base.current!.getBoundingClientRect().left;
  const zoom = (at: number, factor: number) => {
    const s = Math.min(track.frames, Math.max(size.w, span * factor));
    setView(clamp(at - ((at - view.from) * s) / span, s));
  };
  const cursor = drag.current?.moved ? "grabbing" : slPickBar1.value ? "crosshair" : hover && lineAt(hover.x) !== null ? "col-resize" : "pointer";
  const l = selLoop();

  return (
    <div class="wave sl-wave-wrap">
      <div class="sl-wave" style={multi ? { height: `${Math.max(210, 18 + track.stems.length * 64)}px` } : undefined}>
        {multi && <StemLanes track={track} />}
        <div class="sl-wave-area">
          <canvas ref={base} class="sl-canvas" />
          <canvas ref={top} class="sl-canvas" style={{ cursor }} role="img"
            aria-label="Track waveform with bars: click a bar line to add or remove a cut, click a loop to hear it; wheel to zoom, drag to move"
            onPointerDown={(e) => {
              drag.current = { x: e.clientX, view, moved: false };
              try { (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId); } catch { /* gone */ }
            }}
            onPointerMove={(e) => {
              const d = drag.current;
              if (d) {
                if (!d.moved && Math.abs(e.clientX - d.x) < 4) return;
                d.moved = true;
                const s = d.view.to - d.view.from;
                setView(clamp(d.view.from - ((e.clientX - d.x) / size.w) * s, s));
                return;
              }
              const px = pos(e);
              setHover({ frame: frameAt(px), x: px });
            }}
            onPointerUp={(e) => {
              const d = drag.current;
              drag.current = null;
              if (d && !d.moved) click(pos(e));
            }}
            onPointerCancel={() => (drag.current = null)}
            onPointerLeave={() => setHover(null)}
            onWheel={(e) => {
              e.preventDefault();
              if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
                const d = e.shiftKey ? e.deltaY || e.deltaX : e.deltaX;
                return setView(clamp(view.from + (d / size.w) * span, span));
              }
              zoom(frameAt(pos(e)), Math.exp(e.deltaY * 0.0015));
            }} />
          <div ref={head} class="sl-head" />
        </div>
      </div>
      <div class="wave-tools">
        <button class="btn btn-ghost" title="Zoom out" disabled={span >= track.frames} onClick={() => zoom(view.from + span / 2, 2)}>−</button>
        <button class="btn btn-ghost" title="Zoom in (or the mouse wheel over the wave)" disabled={span <= size.w} onClick={() => zoom(view.from + span / 2, 0.5)}>+</button>
        <button class="btn btn-ghost" disabled={view.from === 0 && view.to === track.frames} onClick={() => setView({ from: 0, to: track.frames })}>Full</button>
        <button class="btn btn-ghost" disabled={!l} title="Zoom to the picked loop"
          onClick={() => l && setView(clamp(l.start - l.frames * 0.1, l.frames * 1.2))}>Loop</button>
        <span class="wave-view">
          {slPickBar1.value ? "Click the beat where a bar starts" : "Click a bar line to cut · click a loop to hear it · Space, ←/→, S, J, Enter"}
          {" · "}{fmtTime(Math.max(0, view.from))}–{fmtTime(Math.min(track.frames, view.to))}
        </span>
      </div>
    </div>
  );
}

/** Every loop: in or out of the write, listen, the joint with the next one. */
function LoopList() {
  const loops = slLoops.value, off = slOff.value, sel = slSel.value, t = slTrack.value!, playing = slPlay.value;
  const chosen = slChosen.value;
  const out = outputOf(t);
  const bytes = out ? chosen.reduce((s, l) => s + l.frames * out.channels * 2 + 44, 0) : 0;
  const silent = slSilent.value, multi = t.stems.length > 1;
  const onCard = loops.filter((l) => writtenAs(l).length).length;
  let n = 0;
  return (
    <div class="sl-list-wrap">
      <div class="sl-list-head">
        <span>
          <b>{chosen.length}</b> of {loops.length} loops chosen
          {multi && !out ? " · every stem muted" : <>{multi ? ` · ${outputText(out!)}` : ""} · {mb(bytes)}</>}
          {onCard > 0 && <span class="sl-done"> · {onCard} already on card</span>}
        </span>
        <button class="btn btn-ghost" disabled={!!slBusy.value || chosen.length === loops.length} onClick={() => setAllOff(false)}>All</button>
        <button class="btn btn-ghost" disabled={!!slBusy.value || !chosen.length} onClick={() => setAllOff(true)}>None</button>
      </div>
      {!loops.length ? <p class="muted ptn-empty">No whole loops: add cuts on the bar lines, or cut every fewer bars.</p> : (
        <ol class="sl-list">
          {loops.map((l, i) => {
            const on = !off.has(l.bar);
            if (on) n++;
            const next = loops[i + 1];
            const joint = !!next && next.start === l.start + l.frames;
            return (
              <li key={l.bar} class={`sl-row ${l.bar === sel ? "sel" : ""} ${on ? "" : "off"}`} onClick={() => (slSel.value = l.bar)}>
                <input type="checkbox" checked={on} disabled={!!slBusy.value} aria-label={`Write loop of bars ${l.bar}–${l.bar + l.bars - 1}`}
                  onClick={(e) => e.stopPropagation()} onChange={() => toggleOff(l.bar)} />
                <span class="sl-num">{on ? String(n).padStart(2, "0") : "—"}</span>
                <span>bars {l.bar}–{l.bar + l.bars - 1}</span>
                <span class="muted">
                  {l.bars} bar{l.bars > 1 ? "s" : ""} · {(l.frames / RATE).toFixed(2)} s
                  {slLoopGain.value.has(l.bar) && (
                    <span class="sl-mixmark" title={`Own balance: ${[...slLoopGain.value.get(l.bar)!].map(([i, v]) => `${t.stems[i]?.label} ${fmtDb(v)}`).join(", ")}`}> · own mix</span>
                  )}
                  {silent.has(l.bar) && <span class="sl-quiet" title="These stems are silent in this loop (their files are written anyway)"> · silent: {silent.get(l.bar)!.join(", ")}</span>}
                  {(() => {
                    const w = writtenAs(l);
                    return w.length > 0 && <span class="sl-done" title={`Already written to the SD card${multi ? `: ${w.map((x) => x || "track").join(", ")}` : ""}`}> · on card{multi ? `: ${w.join(", ")}` : ""}</span>;
                  })()}
                </span>
                <span class="sl-row-actions">
                  <button class="icon-btn" title="Listen round and round (Space)" aria-label="Listen"
                    onClick={(e) => { e.stopPropagation(); slSel.value = l.bar; if (playing?.bar === l.bar && playing.loop) stopPlay(); else play(l.bar); }}>
                    {playing?.bar === l.bar && playing.loop ? <IconStop /> : <IconPlay />}
                  </button>
                  <button class="icon-btn" disabled={!!(slCardBlock.value ?? slStemBlock.value)} aria-label="Write this loop to the SD card"
                    title={slCardBlock.value ?? slStemBlock.value ?? `Write only this loop${multi && out ? ` (${outputText(out)})` : ""} to the SD card, into this track's folder`}
                    onClick={(e) => { e.stopPropagation(); slSel.value = l.bar; void writeOne(l.bar); }}>
                    <IconUpload />
                  </button>
                  <button class="btn btn-ghost sl-joint" disabled={!joint} title="This loop and the next one once, to hear the joint"
                    onClick={(e) => { e.stopPropagation(); slSel.value = l.bar; if (playing?.bar === l.bar && !playing.loop) stopPlay(); else play(l.bar, true); }}>
                    {playing?.bar === l.bar && !playing.loop ? "■" : "→ next"}
                  </button>
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

/** What is written: "inst only", "vocals + inst mixed". */
function outputText(out: { stems: Stem[] }): string {
  return out.stems.length === 1 ? `${out.stems[0]!.label} only` : `${out.stems.map((x) => x.label).join(" + ")} mixed`;
}

/** " (inst)", " (mix)" or nothing: what the write button writes. */
function stemsNote(t: Track): string {
  const out = outputOf(t);
  return t.stems.length < 2 || !out ? "" : ` (${out.stems.length === 1 ? out.label : "mix"})`;
}

/** Where the loops go, the write button and its progress. */
function WriteBar({ track }: { track: Track }) {
  const busy = slBusy.value, block = slWriteBlock.value, n = slChosen.value.length;
  return (
    <div class="sl-write">
      {busy ? (
        <>
          <div class="sl-progress" role="progressbar" aria-valuenow={Math.round(busy.progress * 100)} aria-valuemin={0} aria-valuemax={100}>
            <span style={{ width: `${busy.progress * 100}%` }} />
          </div>
          <span class="small sl-write-text">{busy.text}</span>
          <button class="btn btn-stop" onClick={cancelWrite} title="Stop after the file being written">Stop</button>
        </>
      ) : (
        <>
          <span class="muted small sl-write-text">
            {slStemBlock.value ? "Every stem is muted: unmute one to write its loops"
              : <>To the SD card, {track.stems.length > 1 ? "the track's folder, a new subfolder" : "a new folder"} <b>{folderPreview(track)}</b> · files like {loopFileName(track.name, 1, Math.max(n, 1), slGrid.value!.x100, outputOf(track)?.tag ?? "")}</>}
          </span>
          <button class="btn btn-primary" disabled={!!block} title={block ?? "Write the chosen loops to the card"} onClick={() => void writeLoops()}>
            <IconUpload /> Write {n} loop{n === 1 ? "" : "s"}{stemsNote(track)} to SD card
          </button>
        </>
      )}
    </div>
  );
}
