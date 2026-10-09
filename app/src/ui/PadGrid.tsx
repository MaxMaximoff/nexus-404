import { useEffect, useRef, useState } from "preact/hooks";
import { BANKS, formatBpm, padName } from "../sp404";
import {
  PAD_DRAG, copyPad, copying, dragCopy, dragGroup, dropGroup, groupDrop, groupTargets, clearPicked, confirmGroupDelete, deletePicked, groupProgress, pickPad, picked, pickedList, conn, dragOverBank, draggedPad, endPadDrag, patternsOf, moveSpeedChange, connect, hasGrant, importFiles, startDemo, jobs, movePad, pads, project, reconnect, reload, selectPad, selectedBank, selectedPad, setBankTempo, status,
  waveforms, writeBlockReason,
} from "./store";
import { IconLock, IconRefresh, IconTrash } from "./icons";
import { TempoField } from "./TempoField";
import { CARD_DRAG, importFromCard } from "./card";
import { TAKE_DRAG, takeToPad } from "./rec";

const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes("Files");
const hasTake = (e: DragEvent) => !!e.dataTransfer?.types.includes(TAKE_DRAG);
const hasCard = (e: DragEvent) => !!e.dataTransfer?.types.includes(CARD_DRAG);
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

      <GroupBar />
      <div class={`pad-grid ${c !== "ready" && c !== "loading" ? "offline" : ""}`}>
        {Array.from({ length: 16 }, (_, i) => <PadCard key={i} index={b * 16 + i} />)}
        {c !== "ready" && c !== "loading" && <ConnectOverlay />}
      </div>
      <p class="hint">Ctrl-клик, Shift-клик или Ctrl+A выделяют pad'ы для группового удаления. Перетащите файлы на пустой pad — они займут его и следующие пустые pad'ы банка. Pad на pad: на пустой — перенос, на занятый — обмен; на плитку банка — на его первый пустой pad; с Ctrl — копия на пустой pad; задержите над банком, чтобы перейти в него.</p>
    </section>
  );
}

const padsWord = (n: number) => (n % 10 === 1 && n % 100 !== 11 ? "pad" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? "pad'а" : "pad'ов");

/** Picked pads: what is picked and the group delete, with one confirmation listing every pad. */
function GroupBar() {
  const list = pickedList.value, prog = groupProgress.value;
  const yes = useRef<HTMLButtonElement>(null);
  const confirming = confirmGroupDelete.value;
  useEffect(() => { if (confirming) yes.current?.focus(); }, [confirming]);
  if (prog) {
    return (
      <div class="group-bar">
        <span>{prog.verb} {Math.min(prog.done + 1, prog.total)} из {prog.total}…</span>
        <span class="bar"><span style={{ width: `${(prog.done / prog.total) * 100}%` }} /></span>
      </div>
    );
  }
  if (!list.length) return null;
  const names = list.map((i) => `${padName(i)} «${pads.value[i]!.name || "без имени"}»`);
  const inPatterns = [...new Set(list.flatMap(patternsOf))].sort((a, b) => a - b);
  if (confirming) {
    return (
      <div class="group-bar confirm-delete" role="alertdialog" aria-label="Подтверждение удаления"
        onKeyDown={(e) => { if (e.key === "Escape") confirmGroupDelete.value = false; }}>
        <span class="confirm-text">Удалить {list.length} {padsWord(list.length)} с SP? Вернуть будет нельзя.</span>
        <span class="group-names">{names.join(", ")}</span>
        {inPatterns.length > 0 && <span class="confirm-ptn">Они звучат в паттернах {inPatterns.map(padName).join(", ")} — там станет тишина.</span>}
        <button ref={yes} class="btn btn-danger" onClick={deletePicked}><IconTrash /> Удалить {list.length}</button>
        <button class="btn" onClick={() => (confirmGroupDelete.value = false)}>Отмена</button>
      </div>
    );
  }
  // It covers the bank header: step aside while a pad is dragged, so the header's speed and pattern chips show.
  if (draggedPad.value !== null) return null;
  return (
    <div class="group-bar">
      <span class="group-count">Выбрано {list.length}</span>
      <span class="group-names muted" title={names.join(", ")}>{list.map(padName).join(", ")}</span>
      <button class="btn insp-delete" disabled={!!writeBlockReason.value} onClick={() => (confirmGroupDelete.value = true)}
        title={writeBlockReason.value ?? `Удалить выбранные (${list.length}) с SP (Delete)`} aria-label="Удалить выбранные"><IconTrash /></button>
      <button class="btn" onClick={clearPicked} title="Esc">Снять выделение</button>
    </div>
  );
}

/** While a pad is dragged over another bank: how fast it will play there (bank tempos differ). */
function DragSpeed() {
  const src = draggedPad.value, bank = dragOverBank.value;
  const s = src !== null && bank !== null ? moveSpeedChange(src, bank) : null;
  const inPatterns = src !== null ? patternsOf(src) : [];
  return (
    <>
      {s && <span class="chip chip-warn drag-speed">{s.text}</span>}
      {inPatterns.length > 0 && <span class="chip drag-speed" title="После переноса паттерны перечитаются, и в журнале будет видно, перевёл ли SP их ноты">{padName(src!)} в паттернах {inPatterns.map(padName).join(", ")}</span>}
    </>
  );
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
          <button class="btn" onClick={startDemo} disabled={c === "connecting"} title="Выдуманный проект без SP — чтобы посмотреть интерфейс">Демо</button>
          <button class="btn btn-primary" onClick={connect} disabled={c === "connecting"}>Connect SP-404MKII</button>
        </div>
      )}
    </div>
  );
}

function PadCard({ index }: { index: number }) {
  const [over, setOver] = useState<false | "files" | "move" | "swap" | "copy">(false);
  const p = pads.value[index];
  const job = jobs.value.find((j) => j.pad === index && (j.state !== "done" && j.state !== "error"));
  const selected = selectedPad.value === index;
  const onDevice = status.value && status.value.bank * 16 + status.value.pad === index;
  const wave = waveforms.value.get(index);
  const secs = p?.size && wave ? (p.endByte - p.startByte) / (2 * wave.channels) / 48000 : null;
  const copy = copying.value;
  const copyHere = copy?.dst === index ? copy : null;
  const canMove = !!p?.size && !job && !copyHere && !writeBlockReason.value;
  const groupHere = !!groupDrop.value?.includes(index);
  const cls = ["pad", p?.size ? "full" : "empty", selected && "selected", picked.value.has(index) && "picked", (over || groupHere) && "drop", over === "swap" && "drop-swap",
    (over === "copy" || (groupHere && dragCopy.value)) && "drop-copy", (job || copyHere) && "busy"].filter(Boolean).join(" ");
  return (
    <button
      class={cls}
      data-pad={padName(index)}
      draggable={canMove}
      title={canMove ? "Перетащите на другой pad: на пустой — перенос, на занятый — обмен местами; с Ctrl — копия на пустой" : undefined}
      onClick={(e) => {
        if (e.ctrlKey || e.metaKey) return pickPad(index, "toggle");
        if (e.shiftKey) return pickPad(index, "range");
        clearPicked();
        selectPad(index);
      }}
      onDragStart={(e) => {
        if (!canMove || !e.dataTransfer) return;
        e.dataTransfer.setData(PAD_DRAG, String(index));
        e.dataTransfer.effectAllowed = "copyMove";
        draggedPad.value = index;
      }}
      onDragEnd={endPadDrag}
      onDragOver={(e) => {
        if (hasFiles(e) || ((hasCard(e) || hasTake(e)) && !p?.size && !job)) { e.preventDefault(); e.dataTransfer!.dropEffect = "copy"; setOver("files"); }
        else if (hasPad(e) && dragGroup.value) {
          // A group lands on this pad and the empty ones after it; no swaps for groups.
          const g = dragGroup.value;
          dragOverBank.value = index >> 4;
          const t = g.includes(index) || p?.size || job || copyHere ? null : groupTargets(index >> 4, index, g.length);
          groupDrop.value = t;
          if (!t) return setOver(false);
          e.preventDefault();
          e.dataTransfer!.dropEffect = e.ctrlKey ? "copy" : "move";
          setOver(e.ctrlKey ? "copy" : "move");
        }
        else if (hasPad(e) && !job && !copyHere && draggedPad.value !== index) {
          dragOverBank.value = index >> 4;
          if (e.ctrlKey && p?.size) return setOver(false); // a copy goes onto an empty pad only
          e.preventDefault();
          e.dataTransfer!.dropEffect = e.ctrlKey ? "copy" : "move";
          setOver(e.ctrlKey ? "copy" : p?.size ? "swap" : "move");
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (e.dataTransfer?.types.includes(TAKE_DRAG)) return void (!p?.size && takeToPad(index));
        const card = e.dataTransfer?.getData(CARD_DRAG);
        if (card) return void importFromCard(JSON.parse(card) as string[], index);
        const src = e.dataTransfer?.getData(PAD_DRAG);
        const g = dragGroup.value;
        if (src && g) {
          const t = groupTargets(index >> 4, index, g.length);
          return void (t && dropGroup(t, e.ctrlKey));
        }
        if (src && e.ctrlKey && p?.size) return; // a copy goes onto an empty pad only
        if (src) return void (e.ctrlKey ? copyPad(+src, index) : movePad(+src, index));
        selectPad(index);
        importFiles([...(e.dataTransfer?.files ?? [])], index);
      }}
    >
      <span class="pad-label">
        {padName(index)}{onDevice && <span class="here" title="Выбран на SP" />}
      </span>
      <span class="pad-tags">
        {!!p?.size && p.muteGroup > 0 && <span class="pad-tag tag-mute" title={`Mute Group ${BANKS[p.muteGroup - 1]}: pad'ы группы глушат друг друга`}>M {BANKS[p.muteGroup - 1] ?? p.muteGroup}</span>}
        {!!p?.size && patternsOf(index).length > 0 && <span class="pad-tag tag-ptn" title={`Звучит в паттернах ${patternsOf(index).map(padName).join(", ")}`}>P {patternsOf(index).length}</span>}
        {!!p?.size && p.padLink > 0 && <span class="pad-tag tag-link" title={`PAD Link ${BANKS[p.padLink - 1]}: pad'ы группы звучат вместе`}>L {BANKS[p.padLink - 1] ?? p.padLink}</span>}
      </span>
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
      {copyHere && (
        <span class="pad-progress">
          <span style={{ width: `${Math.round(copyHere.progress * 100)}%` }} />
          <em>копия {Math.round(copyHere.progress * 100)} %</em>
        </span>
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
