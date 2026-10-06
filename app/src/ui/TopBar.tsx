import { useState } from "preact/hooks";
import {
  conn, connect, disconnect, freeKb, hasGrant, loadProgress, project, reconnect, selectedBank, setBankTempo, setProjectTempo, setTempoSelect,
  status, writeBlockReason,
} from "./store";
import { TempoField } from "./TempoField";
import { IconPlug, IconUnplug } from "./icons";

const LABEL: Record<string, string> = {
  unsupported: "Браузер не поддерживает Web Serial",
  idle: "Не подключено",
  connecting: "Подключение…",
  loading: "Чтение pad'ов",
  ready: "Подключено",
  lost: "Связь потеряна — ждём SP",
};

/** Which tempo plays: the project's, or each bank's own. */
function TempoSelect({ useProject }: { useProject: boolean }) {
  const [busy, setBusy] = useState(false);
  const blocked = writeBlockReason.value;
  const pick = async (v: boolean) => {
    if (v === useProject || busy) return;
    setBusy(true);
    await setTempoSelect(v);
    setBusy(false);
  };
  return (
    <span class="segmented" role="group" aria-label="Какой темп действует" title={blocked ?? "Какой темп действует на SP"}>
      <button type="button" aria-pressed={useProject} class={useProject ? "on" : ""} disabled={!!blocked || busy} onClick={() => pick(true)}>Проект</button>
      <button type="button" aria-pressed={!useProject} class={useProject ? "" : "on"} disabled={!!blocked || busy} onClick={() => pick(false)}>Банки</button>
    </span>
  );
}

/**
 * The tempo that plays: the project's when Tempo Select is Project, otherwise that of the bank
 * open in the app. Whichever is shown is the one the field edits.
 */
function TempoControl() {
  const ps = project.value!;
  const b = selectedBank.value;
  const bank = ps.banks[b];
  return (
    <span class="tempo-group">
      {ps.useProjectTempo || !bank
        ? <TempoField key="project" value={ps.projectTempoX100} label="Темп проекта" onSave={setProjectTempo} />
        : <>
          <span class="muted">банк {bank.letter}</span>
          <TempoField key={`bank-${b}`} value={bank.tempoX100} label={`Темп банка ${bank.letter}`} onSave={(x) => setBankTempo(b, x)} />
        </>}
      <span class="muted">BPM</span>
      <TempoSelect useProject={ps.useProjectTempo} />
    </span>
  );
}

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
          <TempoControl />
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
