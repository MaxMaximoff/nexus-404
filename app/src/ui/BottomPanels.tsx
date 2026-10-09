import { useEffect, useRef } from "preact/hooks";
import { BPM_RANGES, formatBpm, padName } from "../sp404";
import { bpmRange, clearFinishedJobs, defaultBpm, detectOnImport, jobs, logLines, showDebug } from "./store";

const BPM_FROM = { name: "from filename", detected: "detected", field: "from field", source: "from source pad" } as const;

export function ImportPanel() {
  const list = jobs.value;
  return (
    <section class="import-panel glass">
      <div class="panel-row">
        <div class="panel-title">Import</div>
        <label class="default-bpm detect-bpm" title="Detect tempo from audio when the filename has no BPM, such as ‘120bpm’">
          <input type="checkbox" checked={detectOnImport.value} onChange={(e) => (detectOnImport.value = (e.target as HTMLInputElement).checked)} />
          Detect BPM
          <select value={bpmRange.value} disabled={!detectOnImport.value} title="Fold the tempo into this range, as on SP"
            onChange={(e) => (bpmRange.value = +(e.target as HTMLSelectElement).value)}>
            {BPM_RANGES.map(([a, b], i) => <option value={i}>{a}–{b}</option>)}
          </select>
        </label>
        <label class="default-bpm" title={detectOnImport.value ? "Used when BPM is missing from the filename and cannot be detected from audio" : "For files with no BPM in the filename, such as ‘120bpm’"}>
          {detectOnImport.value ? "Fallback BPM" : "New sample BPM"}
          <input type="text" inputMode="decimal" placeholder="—" value={defaultBpm.value}
            onInput={(e) => (defaultBpm.value = (e.target as HTMLInputElement).value)} />
        </label>
        {list.some((j) => j.state === "done" || j.state === "error") && <button class="btn btn-ghost" onClick={clearFinishedJobs}>Clear</button>}
      </div>
      {list.length === 0 ? (
        <p class="muted small">Queue is empty. BPM comes from the filename (‘loop_96bpm.wav’){detectOnImport.value ? ", then from audio detection" : ""}, then from the field above, otherwise it stays at 90.</p>
      ) : (
        <ul class="jobs">
          {list.map((j) => (
            <li key={j.id} class={`job job-${j.state}`}>
              <span class="job-name" title={j.file.name}>{j.file.name}</span>
              <span class="chip">{padName(j.pad)}</span>
              <span class="muted" title={j.bpmFrom ? `BPM ${BPM_FROM[j.bpmFrom]}` : undefined}>
                {j.bpmX100 !== null ? `${formatBpm(j.bpmX100)} BPM${j.bpmFrom === "detected" ? " ✓" : ""}` : j.detect && j.state !== "done" && j.state !== "error" ? "BPM?" : ""}
              </span>
              <span class="bar"><span style={{ width: `${Math.round(j.progress * 100)}%` }} /></span>
              <span class="job-msg" title={j.message}>{j.message}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function LogPanel() {
  const box = useRef<HTMLDivElement>(null);
  const lines = logLines.value;
  useEffect(() => { if (box.current) box.current.scrollTop = box.current.scrollHeight; }, [lines.length]);
  return (
    <details class="log-panel glass">
      <summary>
        <span class="panel-title">Log</span>
        <span class="muted small">{lines.length ? lines[lines.length - 1].text : "empty"}</span>
      </summary>
      <label class="small"><input type="checkbox" checked={showDebug.value} onChange={(e) => (showDebug.value = (e.target as HTMLInputElement).checked)} /> Show USB frames</label>
      <div class="log" ref={box}>
        {lines.map((l, i) => <div key={i} class={`log-${l.level}`}><span>{l.t}</span> {l.text}</div>)}
      </div>
    </details>
  );
}
