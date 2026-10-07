import { useState } from "preact/hooks";
import { BANKS, formatBpm, padName } from "../sp404";
import {
  PAD_DRAG, conn, dragOverBank, draggedPad, endPadDrag, moveSpeedChange, connect, hasGrant, importFiles, jobs, movePad, pads, project, reconnect, reload, selectPad, selectedBank, selectedPad, setBankTempo, status,
  waveforms, writeBlockReason,
} from "./store";
import { IconLock, IconRefresh } from "./icons";
import { TempoField } from "./TempoField";

const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes("Files");
export const hasPad = (e: DragEvent) => !!e.dataTransfer?.types.includes(PAD_DRAG);

export function PadGrid() {
  const b = selectedBank.value;
  const bank = project.value?.banks[b];
  const all = pads.value;
  const filled = all.slice(b * 16, b * 16 + 16).filter((p) => p?.size).length;
  const c = conn.value;
  return (
    <section class="pad-area glass">
      <div class="pad-head">
        <div>
          <span class="bank-big">{BANKS[b]}</span>
          {bank && (
            <span class="tempo-group">
              <TempoField value={bank.tempoX100} label={`Темп банка ${BANKS[b]}`} onSave={(x) => setBankTempo(b, x)} dim={project.value?.useProjectTempo}
                hint={project.value?.useProjectTempo ? "Сейчас действует темп проекта" : undefined} />
              <span class="muted">BPM ·</span>
            </span>
          )}
          <span class="muted">{filled} / 16 занято</span>
          <DragSpeed />
          {bank?.protected && <span class="chip chip-warn"><IconLock /> защищён</span>}
        </div>
        {c === "ready" && <button class="btn btn-ghost" onClick={reload} title="Перечитать проект с SP"><IconRefresh /> Обновить</button>}
      </div>

      <div class="pad-grid">
        {Array.from({ length: 16 }, (_, i) => <PadCard key={i} index={b * 16 + i} />)}
        {c !== "ready" && c !== "loading" && <ConnectOverlay />}
      </div>
      <p class="hint">Перетащите файлы на пустой pad — они займут его и следующие пустые pad'ы банка. Pad на pad: на пустой — перенос, на занятый — обмен; на плитку банка — на его первый пустой pad; задержите над банком, чтобы перейти в него.</p>
    </section>
  );
}

/** While a pad is dragged over another bank: how fast it will play there (bank tempos differ). */
function DragSpeed() {
  const src = draggedPad.value, bank = dragOverBank.value;
  const s = src !== null && bank !== null ? moveSpeedChange(src, bank) : null;
  return s && <span class="chip chip-warn drag-speed">{s.text}</span>;
}

function ConnectOverlay() {
  const c = conn.value;
  if (c === "unsupported")
    return <div class="overlay"><b>Нужен Chrome или Edge на компьютере</b><span>Web Serial недоступен в этом браузере или странице нужен https://.</span></div>;
  return (
    <div class="overlay">
      <b>{c === "lost" ? "SP отключился" : "Подключите SP-404MKII по USB"}</b>
      <span>{c === "lost" ? "Как только он появится снова, переподключусь сам." : "Закройте официальное приложение Roland: порт может открыть только одна программа."}</span>
      {c !== "lost" && (
        <div class="row">
          {hasGrant.value && <button class="btn" onClick={() => reconnect()}>Переподключить</button>}
          <button class="btn btn-primary" onClick={connect} disabled={c === "connecting"}>Connect SP-404MKII</button>
        </div>
      )}
    </div>
  );
}

function PadCard({ index }: { index: number }) {
  const [over, setOver] = useState<false | "files" | "move" | "swap">(false);
  const p = pads.value[index];
  const job = jobs.value.find((j) => j.pad === index && (j.state !== "done" && j.state !== "error"));
  const selected = selectedPad.value === index;
  const onDevice = status.value && status.value.bank * 16 + status.value.pad === index;
  const wave = waveforms.value.get(index);
  const secs = p?.size && wave ? (p.endByte - p.startByte) / (2 * wave.channels) / 48000 : null;
  const canMove = !!p?.size && !job && !writeBlockReason.value;
  const cls = ["pad", p?.size ? "full" : "empty", selected && "selected", over && "drop", over === "swap" && "drop-swap", job && "busy"].filter(Boolean).join(" ");
  return (
    <button
      class={cls}
      draggable={canMove}
      title={canMove ? "Перетащите на другой pad: на пустой — перенос, на занятый — обмен местами" : undefined}
      onClick={() => selectPad(index)}
      onDragStart={(e) => {
        if (!canMove || !e.dataTransfer) return;
        e.dataTransfer.setData(PAD_DRAG, String(index));
        e.dataTransfer.effectAllowed = "move";
        draggedPad.value = index;
      }}
      onDragEnd={endPadDrag}
      onDragOver={(e) => {
        if (hasFiles(e)) { e.preventDefault(); setOver("files"); }
        else if (hasPad(e) && !job && draggedPad.value !== index) {
          dragOverBank.value = index >> 4; e.preventDefault(); e.dataTransfer!.dropEffect = "move"; setOver(p?.size ? "swap" : "move"); }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const src = e.dataTransfer?.getData(PAD_DRAG);
        if (src) return void movePad(+src, index);
        selectPad(index);
        importFiles([...(e.dataTransfer?.files ?? [])], index);
      }}
    >
      <span class="pad-label">{padName(index)}{onDevice && <span class="here" title="Выбран на SP" />}</span>
      {p?.size ? (
        <>
          <span class="pad-name">{p.name || "без имени"}</span>
          <span class="pad-meta">
            <span>{formatBpm(p.bpmX100)}</span>
            <span>{secs !== null ? `${secs < 10 ? secs.toFixed(2) : secs.toFixed(1)} s` : `${(p.size / 1048576).toFixed(1)} MB`}</span>
          </span>
        </>
      ) : (
        <span class="pad-empty">{job ? "" : "+"}</span>
      )}
      {job && (
        <span class="pad-progress">
          <span style={{ width: `${Math.round(job.progress * 100)}%` }} />
          <em>{job.state === "decoding" ? "декодирование" : job.state === "queued" ? "в очереди" : `${Math.round(job.progress * 100)} %`}</em>
        </span>
      )}
    </button>
  );
}
