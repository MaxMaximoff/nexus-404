import { useEffect, useRef } from "preact/hooks";
import { formatBpm, padName } from "../sp404";
import { clearFinishedJobs, defaultBpm, jobs, logLines, showDebug } from "./store";

export function ImportPanel() {
  const list = jobs.value;
  return (
    <section class="import-panel glass">
      <div class="panel-row">
        <div class="panel-title">Импорт</div>
        <label class="default-bpm" title="Для файлов, в имени которых нет «120bpm» и т.п.">
          BPM новых сэмплов
          <input type="text" inputMode="decimal" placeholder="из имени файла" value={defaultBpm.value}
            onInput={(e) => (defaultBpm.value = (e.target as HTMLInputElement).value)} />
        </label>
        {list.some((j) => j.state === "done" || j.state === "error") && <button class="btn btn-ghost" onClick={clearFinishedJobs}>Очистить</button>}
      </div>
      {list.length === 0 ? (
        <p class="muted small">Очередь пуста. BPM берётся из имени файла («loop_96bpm.wav»), иначе из поля выше, иначе остаётся 90.</p>
      ) : (
        <ul class="jobs">
          {list.map((j) => (
            <li key={j.id} class={`job job-${j.state}`}>
              <span class="job-name" title={j.file.name}>{j.file.name}</span>
              <span class="chip">{padName(j.pad)}</span>
              <span class="muted">{j.bpmX100 !== null ? `${formatBpm(j.bpmX100)} BPM` : ""}</span>
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
