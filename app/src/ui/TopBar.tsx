import { conn, connect, disconnect, freeKb, hasGrant, loadProgress, project, reconnect, status } from "./store";
import { formatBpm } from "../sp404";
import { IconPlug, IconUnplug } from "./icons";

const LABEL: Record<string, string> = {
  unsupported: "Браузер не поддерживает Web Serial",
  idle: "Не подключено",
  connecting: "Подключение…",
  loading: "Чтение pad'ов",
  ready: "Подключено",
  lost: "Связь потеряна — ждём SP",
};

export function TopBar() {
  const c = conn.value;
  const ps = project.value;
  const st = status.value;
  const connected = c === "ready" || c === "loading";
  return (
    <header class="topbar glass">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true"><i /><i /><i /><i /></span>
        <span class="brand-name">Nexus<b>-404</b></span>
        <span class="brand-sub">для SP-404MKII</span>
      </div>

      <div class={`conn conn-${c}`}>
        <span class="dot" />
        <span>{LABEL[c]}{c === "loading" ? ` ${Math.round(loadProgress.value * 100)} %` : ""}</span>
      </div>

      {connected && ps && st && (
        <div class="project-info">
          <span class="chip">Проект {st.project + 1}</span>
          <span class="project-name">{ps.name || ps.names[st.project] || "без имени"}</span>
          <span class="muted">{formatBpm(ps.projectTempoX100)} BPM · темп {ps.useProjectTempo ? "проекта" : "банка"}</span>
          {freeKb.value !== null && <span class="muted">· свободно {(freeKb.value / 1048576).toFixed(1)} GB</span>}
        </div>
      )}

      <div class="topbar-actions">
        {!connected && c !== "unsupported" && (
          <>
            {hasGrant.value && <button class="btn" onClick={() => reconnect()} disabled={c === "connecting"}>Переподключить</button>}
            <button class="btn btn-primary" onClick={connect} disabled={c === "connecting"}><IconPlug /> Connect SP-404MKII</button>
          </>
        )}
        {connected && <button class="btn" onClick={disconnect}><IconUnplug /> Отключить</button>}
      </div>
    </header>
  );
}
