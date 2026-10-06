import { useEffect, useRef, useState } from "preact/hooks";
import type { Waveform as Wave } from "./store";

/** Start/End as fractions of the whole sample (0..1). */
export interface Range { start: number; end: number }
/** The visible part of the sample, fractions 0..1. */
interface View { from: number; to: number }

const RATE = 48000;
const FULL: View = { from: 0, to: 1 };
const GRAB_PX = 10; // how close to a marker a press has to land to pick it up
const MIN_GAP_PX = 2;
const MARKER_WINDOW_FRAMES = 4800; // "→ Start" / "→ End" show 100 ms around the marker

type Drag = { kind: "start" | "end" } | { kind: "pan"; x: number; view: View };

/** Per channel [min, max] pairs, one per column, for frames [a, b); like computePeaks, but for a slice. */
function columns(samples: Int16Array, channels: number, a: number, b: number, cols: number): Float32Array[] {
  const frames = samples.length / channels;
  return Array.from({ length: channels }, (_, ch) => {
    const out = new Float32Array(cols * 2);
    for (let i = 0; i < cols; i++) {
      const from = Math.floor(a + ((b - a) * i) / cols);
      const to = Math.max(from + 1, Math.floor(a + ((b - a) * (i + 1)) / cols));
      let lo = 0, hi = 0;
      for (let f = from; f < to && f < frames; f++) {
        const v = samples[f * channels + ch];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      out[i * 2] = lo / 32768;
      out[i * 2 + 1] = hi / 32767;
    }
    return out;
  });
}

const clampView = (from: number, span: number): View => {
  const s = Math.min(1, span);
  const f = Math.min(Math.max(0, from), 1 - s);
  return { from: f, to: f + s };
};

const fmt = (f: number, frames: number) => ((f * frames) / RATE).toFixed(3);

/**
 * Glowing min/max waveform, one lane per channel, with zoom (wheel, buttons) and pan (drag on
 * an empty spot, Shift+wheel). With `range` it dims what lies outside Start–End; with
 * `onCommit` as well, the markers can be dragged and the new range is committed on release
 * (the markers stay where they were dropped until `range` catches up).
 */
export function Waveform({ wave, range, onCommit }: { wave: Wave; range?: Range; onCommit?: (r: Range) => Promise<unknown> }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const widthRef = useRef(300);
  const [view, setView] = useState<View>(FULL);
  const [draft, setDraft] = useState<Range | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [hover, setHover] = useState<"marker" | "empty" | null>(null);
  const shown = draft ?? range;
  const rs = shown?.start ?? 0, re = shown?.end ?? 1;
  const span = view.to - view.from;
  const zoomed = span < 1;
  const canZoom = !!wave.samples && wave.frames > widthRef.current;
  const minSpan = () => Math.min(1, widthRef.current / wave.frames); // at least one frame per pixel

  // A new saved range (or a new sample) replaces whatever was dropped; a new sample resets the zoom.
  useEffect(() => setDraft(null), [range?.start, range?.end, wave]);
  useEffect(() => setView(FULL), [wave]);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth, h = canvas.clientHeight;
      widthRef.current = w;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      const g = canvas.getContext("2d")!;
      g.scale(dpr, dpr);
      g.clearRect(0, 0, w, h);
      const X = (f: number) => ((f - view.from) / (view.to - view.from)) * w;

      // grid
      g.strokeStyle = "rgba(60, 110, 170, 0.12)";
      g.lineWidth = 1;
      for (let i = 1; i < 8; i++) {
        const x = Math.round((w * i) / 8) + 0.5;
        g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
      }

      const lanesData = zoomed && wave.samples
        ? columns(wave.samples, wave.channels, view.from * wave.frames, view.to * wave.frames, Math.max(1, Math.round(w)))
        : wave.peaks;
      const laneH = h / lanesData.length;
      lanesData.forEach((peaks, ch) => {
        const mid = laneH * ch + laneH / 2;
        const amp = laneH * 0.44;
        const n = peaks.length / 2;
        const grad = g.createLinearGradient(0, mid - amp, 0, mid + amp);
        grad.addColorStop(0, "#7cc8ff");
        grad.addColorStop(0.5, "#1e8fff");
        grad.addColorStop(1, "#7cc8ff");
        g.fillStyle = grad;
        g.shadowColor = "rgba(30, 143, 255, 0.55)";
        g.shadowBlur = zoomed ? 4 : 8;
        g.beginPath();
        for (let i = 0; i < n; i++) g.lineTo((i / n) * w, mid - Math.max(peaks[i * 2 + 1], 0.004) * amp);
        for (let i = n - 1; i >= 0; i--) g.lineTo((i / n) * w, mid - Math.min(peaks[i * 2], -0.004) * amp);
        g.closePath();
        g.fill();
        g.shadowBlur = 0;
        g.strokeStyle = "rgba(255, 255, 255, 0.7)";
        g.beginPath(); g.moveTo(0, mid + 0.5); g.lineTo(w, mid + 0.5); g.stroke();
      });

      if (!shown) return;
      // Start/End: veil outside the played region, a glowing marker with a grab tab at each edge
      const x0 = X(rs), x1 = X(re);
      g.fillStyle = "rgba(232, 239, 247, 0.72)";
      if (x0 > 0) g.fillRect(0, 0, Math.min(x0, w), h);
      if (x1 < w) g.fillRect(Math.max(x1, 0), 0, w - Math.max(x1, 0), h);
      g.strokeStyle = g.fillStyle = "#1e8fff";
      g.lineWidth = 2;
      g.shadowColor = "rgba(30, 143, 255, 0.7)";
      g.shadowBlur = 6;
      for (const [x, side] of [[Math.max(1, x0), 1], [Math.min(w - 1, x1), -1]] as const) {
        if (x < 0 || x > w) continue;
        g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
        if (onCommit) {
          g.beginPath(); g.moveTo(x, 0); g.lineTo(x + side * 9, 0); g.lineTo(x + side * 9, 9); g.lineTo(x, 15); g.closePath(); g.fill();
        }
      }
      g.shadowBlur = 0;
      if (drag && drag.kind !== "pan") {
        const f = drag.kind === "start" ? rs : re;
        const label = `${fmt(f, wave.frames)} s`;
        g.font = "600 11px system-ui, sans-serif";
        const tw = g.measureText(label).width + 10;
        const lx = Math.min(Math.max(X(f) - tw / 2, 2), w - tw - 2);
        g.fillStyle = "rgba(255, 255, 255, 0.92)";
        g.fillRect(lx, h - 22, tw, 18);
        g.fillStyle = "#1e8fff";
        g.fillText(label, lx + 5, h - 9);
      }
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [wave, rs, re, !!shown, drag, !!onCommit, view.from, view.to]);

  /** Pointer position as a fraction of the whole sample (clamped to the visible part). */
  const fractionAt = (e: MouseEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    return { f: view.from + x * span, w: r.width };
  };
  const nearMarker = (e: MouseEvent): "start" | "end" | null => {
    if (!shown || !onCommit) return null;
    const { f, w } = fractionAt(e);
    const ds = (Math.abs(f - rs) / span) * w, de = (Math.abs(f - re) / span) * w;
    if (Math.min(ds, de) > GRAB_PX) return null;
    return ds < de || (ds === de && f < rs) ? "start" : "end";
  };
  const zoomAround = (f: number, factor: number) => {
    const s = Math.min(1, Math.max(minSpan(), span * factor));
    setView(clampView(f - ((f - view.from) * s) / span, s));
  };
  const focus = (f: number) => {
    const s = Math.min(1, Math.max(minSpan(), MARKER_WINDOW_FRAMES / wave.frames));
    setView(clampView(f - s / 2, s));
  };

  const cursor = drag?.kind === "pan" ? "grabbing" : drag || hover === "marker" ? "ew-resize" : zoomed && hover === "empty" ? "grab" : "";
  return (
    <div class="wave">
      <div class="wave-box">
        <canvas
          ref={ref}
          class="wave-canvas"
          style={{ cursor }}
          role="img"
          aria-label={onCommit ? "Форма волны сэмпла; маркеры Start и End можно перетаскивать" : "Форма волны сэмпла"}
          onPointerDown={(e) => {
            const which = nearMarker(e);
            if (!which && !zoomed) return;
            e.preventDefault();
            try { (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
            if (which) {
              setDrag({ kind: which });
              setDraft({ start: rs, end: re });
            } else setDrag({ kind: "pan", x: e.clientX, view });
          }}
          onPointerMove={(e) => {
            if (!drag) return setHover(nearMarker(e) ? "marker" : "empty");
            if (drag.kind === "pan") {
              const dx = ((e.clientX - drag.x) / widthRef.current) * (drag.view.to - drag.view.from);
              return setView(clampView(drag.view.from - dx, drag.view.to - drag.view.from));
            }
            const { f, w } = fractionAt(e);
            const gap = (MIN_GAP_PX / w) * span;
            setDraft((d) => {
              const cur = d ?? { start: rs, end: re };
              return drag.kind === "start" ? { ...cur, start: Math.max(0, Math.min(f, cur.end - gap)) } : { ...cur, end: Math.min(1, Math.max(f, cur.start + gap)) };
            });
          }}
          onPointerUp={async () => {
            if (!drag) return;
            setDrag(null);
            if (drag.kind === "pan") return;
            const d = draft;
            if (!d || !range || (d.start === range.start && d.end === range.end)) return setDraft(null);
            await onCommit!(d);
            setDraft(null);
          }}
          onPointerCancel={() => { setDrag(null); setDraft(null); }}
          onPointerLeave={() => setHover(null)}
          onWheel={(e) => {
            if (!canZoom) return;
            e.preventDefault();
            if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
              const d = e.shiftKey ? e.deltaY || e.deltaX : e.deltaX; // Shift+wheel arrives as deltaX on some systems
              return setView(clampView(view.from + (d / widthRef.current) * span, span));
            }
            zoomAround(fractionAt(e).f, Math.exp(e.deltaY * 0.0015));
          }}
        />
      </div>
      {canZoom && (
        <div class="wave-tools">
          <button class="btn btn-ghost" title="Отдалить" disabled={!zoomed} onClick={() => zoomAround(view.from + span / 2, 2)}>−</button>
          <button class="btn btn-ghost" title="Приблизить (или колесо мыши над волной)" disabled={span <= minSpan()} onClick={() => zoomAround(view.from + span / 2, 0.5)}>+</button>
          <button class="btn btn-ghost" disabled={!zoomed} onClick={() => setView(FULL)}>Весь</button>
          {shown && <>
            <button class="btn btn-ghost" title="Приблизить к маркеру Start" onClick={() => focus(rs)}>→ Start</button>
            <button class="btn btn-ghost" title="Приблизить к маркеру End" onClick={() => focus(re)}>→ End</button>
          </>}
          <span class="wave-view">{zoomed ? `${fmt(view.from, wave.frames)}–${fmt(view.to, wave.frames)} s · ×${Math.round(1 / span)}` : "колесо — зум"}</span>
        </div>
      )}
    </div>
  );
}
