import { useEffect, useState } from "preact/hooks";
import {
  CARD_DRAG, cardBusy, cardDir, cardEntries, cardError, cardPath, cardPlaying, isAudio, openCardDir, previewCardFile, type CardEntry,
} from "./card";
import { conn } from "./store";
import { IconFile, IconFolder, IconPlay, IconRefresh, IconStop } from "./icons";

const fmtSize = (n: number | null) => (n === null ? "" : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);

/**
 * The SD card, read-only: folders open with a click, audio files are listened to on the computer
 * (▶) and dragged onto an empty pad to import them (several with Ctrl/Shift-click).
 */
export function CardBrowser() {
  const dir = cardDir.value, entries = cardEntries.value, busy = cardBusy.value;
  const ready = conn.value === "ready";
  const [sel, setSel] = useState<ReadonlySet<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const key = dir.join("/");
  useEffect(() => { if (ready && entries === null) void openCardDir(dir); }, [ready]);
  useEffect(() => { setSel(new Set()); setAnchor(null); }, [key]);

  const audio = (entries ?? []).filter(isAudio);
  const click = (e: MouseEvent, entry: CardEntry) => {
    if (entry.dir) return void openCardDir([...dir, entry.name]);
    if (!isAudio(entry)) return;
    if (e.shiftKey && anchor) {
      const a = audio.findIndex((x) => x.name === anchor), b = audio.findIndex((x) => x.name === entry.name);
      const n = new Set(sel);
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) n.add(audio[i].name);
      return setSel(n);
    }
    const n = new Set(e.ctrlKey || e.metaKey ? sel : []);
    if (n.has(entry.name) && (e.ctrlKey || e.metaKey)) n.delete(entry.name); else n.add(entry.name);
    setSel(n);
    setAnchor(entry.name);
  };
  const dragStart = (e: DragEvent, entry: CardEntry) => {
    // Dragging a picked file takes all picked ones, in list order.
    const names = sel.has(entry.name) ? audio.filter((x) => sel.has(x.name)).map((x) => x.name) : [entry.name];
    e.dataTransfer!.setData(CARD_DRAG, JSON.stringify(names.map((n) => cardPath(dir, n))));
    e.dataTransfer!.effectAllowed = "copy";
  };

  return (
    <aside class="inspector glass card-browser">
      <div class="card-path">
        <nav aria-label="Путь на карте">
          <button class="crumb" disabled={!dir.length || !!busy} onClick={() => openCardDir([])}>Карта</button>
          {dir.map((d, i) => (
            <span key={i}>
              <span class="sep">/</span>
              <button class="crumb" disabled={i === dir.length - 1 || !!busy} onClick={() => openCardDir(dir.slice(0, i + 1))}>{d}</button>
            </span>
          ))}
        </nav>
        <button class="icon-btn" disabled={!ready || !!busy} onClick={() => openCardDir(dir)} title="Перечитать папку" aria-label="Перечитать"><IconRefresh /></button>
      </div>
      {busy && (
        <div class="card-busy">
          <span>{busy.text}{busy.progress !== null && ` ${Math.round(busy.progress * 100)} %`}</span>
          {busy.progress !== null && <span class="bar"><span style={{ width: `${busy.progress * 100}%` }} /></span>}
        </div>
      )}
      {cardError.value && <span class="err">{cardError.value}</span>}
      {!ready ? <p class="muted">Подключите SP, чтобы открыть карту.</p> : (
        <div class="insp-scroll">
          <ul class="card-list">
            {dir.length > 0 && (
              <li class="card-row dir" onClick={() => !busy && openCardDir(dir.slice(0, -1))}>
                <IconFolder /><span class="card-name">..</span><span />
              </li>
            )}
            {entries?.map((e) => {
              const path = cardPath(dir, e.name), au = isAudio(e), playing = cardPlaying.value === path;
              return (
                <li key={e.name} class={`card-row ${e.dir ? "dir" : au ? "audio" : "other"} ${sel.has(e.name) ? "sel" : ""}`}
                  draggable={au} onDragStart={(ev) => dragStart(ev, e)} onClick={(ev) => !busy && click(ev, e)}
                  title={e.dir ? "Открыть папку" : au ? "Перетащите на пустой pad; Ctrl/Shift — несколько файлов" : "Не аудио"}>
                  {e.dir ? <IconFolder /> : <IconFile />}
                  <span class="card-name">{e.name}</span>
                  <span class="card-size">{fmtSize(e.size)}</span>
                  {au && (
                    <button class={`icon-btn card-play ${playing ? "on" : ""}`} disabled={!!busy && !playing} aria-label={playing ? "Стоп" : "Прослушать"}
                      title={playing ? "Остановить" : "Прослушать на компьютере"} onClick={(ev) => { ev.stopPropagation(); void previewCardFile(e.name); }}>
                      {playing ? <IconStop /> : <IconPlay />}
                    </button>
                  )}
                </li>
              );
            })}
            {entries && !entries.length && <li class="muted card-empty">{dir.length ? "Папка пуста" : "Пусто. Вставлена ли карта в SP?"}</li>}
          </ul>
        </div>
      )}
      <p class="hint">Перетащите аудио на пустой pad — файлы займут его и следующие пустые pad'ы банка. Ctrl/Shift-клик — несколько файлов. ▶ — прослушать на компьютере.</p>
    </aside>
  );
}
