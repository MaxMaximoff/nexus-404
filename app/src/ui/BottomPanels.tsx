import { useEffect, useRef } from "preact/hooks";
import { BPM_RANGES, formatBpm, padName } from "../sp404";
import { bpmRange, clearFinishedJobs, defaultBpm, detectOnImport, jobs, logLines, showDebug } from "./store";

const BPM_FROM = { name: "из имени", detected: "определён", field: "из поля" } as const;

export function ImportPanel() {
  const list = jobs.value;
  return (
    <section class="import-panel glass">
      <div class="panel-row">
        <div class="panel-title">Импорт</div>
        <label class="default-bpm detect-bpm" title="Для файлов, в имени которых нет «120bpm» и т.п.: темп определяется по звуку">
          <input type="checkbox" checked={detectOnImport.value} onChange={(e) => (detectOnImport.value = (e.target as HTMLInputElement).checked)} />
          определять BPM
          <select value={bpmRange.value} disabled={!detectOnImport.value} title="Темп сворачивается в этот диапазон, как на SP"
            onChange={(e) => (bpmRange.value = +(e.target as HTMLSelectElement).value)}>
            {BPM_RANGES.map(([a, b], i) => <option value={i}>{a}–{b}</option>)}
          </select>
        </label>
        <label class="default-bpm" title={detectOnImport.value ? "Если в имени файла нет BPM и по звуку он не определился" : "Для файлов, в имени которых нет «120bpm» и т.п."}>
          {detectOnImport.value ? "иначе BPM" : "BPM новых сэмплов"}
          <input type="text" inputMode="decimal" placeholder="—" value={defaultBpm.value}
            onInput={(e) => (defaultBpm.value = (e.target as HTMLInputElement).value)} />
        </label>
        {list.some((j) => j.state === "done" || j.state === "error") && <button class="btn btn-ghost" onClick={clearFinishedJobs}>Очистить</button>}
      </div>
      {list.length === 0 ? (
        <p class="muted small">Очередь пуста. BPM берётся из имени файла («loop_96bpm.wav»){detectOnImport.value ? ", иначе определяется по звуку" : ""}, иначе из поля выше, иначе остаётся 90.</p>
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
        <span class="panel-title">Журнал</span>
        <span class="muted small">{lines.length ? lines[lines.length - 1].text : "пусто"}</span>
      </summary>
      <label class="small"><input type="checkbox" checked={showDebug.value} onChange={(e) => (showDebug.value = (e.target as HTMLInputElement).checked)} /> показывать USB-кадры</label>
      <div class="log" ref={box}>
        {lines.map((l, i) => <div key={i} class={`log-${l.level}`}><span>{l.t}</span> {l.text}</div>)}
      </div>
    </details>
  );
}
