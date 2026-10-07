import { useEffect, useRef, useState } from "preact/hooks";
import {
  CARD_DRAG, CARD_MOVE, canUploadHere, uploadToCard, cardBusy, cardConfirm, cardEdit, cardMoving, cardNameError, cardSel, createCardFolder, deleteCardSelection,
  inImport, moveCardEntries, renameCardEntry, cardDir, cardEntries, cardError, cardPath, cardPlaying, isAudio, openCardDir, previewCardFile, type CardEntry,
} from "./card";
import { conn } from "./store";
import { IconFile, IconFolder, IconFolderPlus, IconPencil, IconPlay, IconRefresh, IconStop, IconTrash, IconUpload } from "./icons";

const fmtSize = (n: number | null) => (n === null ? "" : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);

/**
 * The SD card, read-only: folders open with a click, audio files are listened to on the computer
 * (▶) and dragged onto an empty pad to import them (several with Ctrl/Shift-click).
 */
export function CardBrowser() {
  const dir = cardDir.value, entries = cardEntries.value, busy = cardBusy.value;
  const ready = conn.value === "ready";
  const sel = cardSel.value;
  const setSel = (n: ReadonlySet<string>) => { cardSel.value = n; cardConfirm.value = false; };
  const [anchor, setAnchor] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const upload = canUploadHere.value;
  const fromComputer = (e: DragEvent) => !!e.dataTransfer?.types.includes("Files");
  const key = dir.join("/");
  useEffect(() => { if (ready && entries === null) void openCardDir(dir); }, [ready]);
  useEffect(() => setAnchor(null), [key]);
  const yes = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (cardConfirm.value) yes.current?.focus(); }, [cardConfirm.value]);

  const all = entries ?? [];
  const audio = all.filter(isAudio);
  // A plain click opens a folder; Ctrl/Shift-click picks it like a file (to delete it).
  const click = (e: MouseEvent, entry: CardEntry) => {
    const mod = e.ctrlKey || e.metaKey || e.shiftKey;
    if (entry.dir && !mod) return void openCardDir([...dir, entry.name]);
    if (e.shiftKey && anchor) {
      const a = all.findIndex((x) => x.name === anchor), b = all.findIndex((x) => x.name === entry.name);
      const n = new Set(sel);
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) n.add(all[i].name);
      return setSel(n);
    }
    const n = new Set(e.ctrlKey || e.metaKey ? sel : []);
    if (n.has(entry.name) && (e.ctrlKey || e.metaKey)) n.delete(entry.name); else n.add(entry.name);
    setSel(n);
    setAnchor(entry.name);
  };
  const dragStart = (e: DragEvent, entry: CardEntry) => {
    // Dragging a picked entry takes all picked ones, in list order: the audio among them for pads,
    // all of them for a move into another folder (inside IMPORT/).
    const names = sel.has(entry.name) ? all.filter((x) => sel.has(x.name)).map((x) => x.name) : [entry.name];
    const sounds = names.filter((n) => audio.some((x) => x.name === n));
    if (sounds.length) e.dataTransfer!.setData(CARD_DRAG, JSON.stringify(sounds.map((n) => cardPath(dir, n))));
    if (upload) { e.dataTransfer!.setData(CARD_MOVE, JSON.stringify(names)); cardMoving.value = names; }
    e.dataTransfer!.effectAllowed = upload ? "copyMove" : "copy";
  };
  // Folders, ".." and the path above take a move, when they are inside IMPORT/ and not what is moved.
  const [moveOver, setMoveOver] = useState<string | null>(null);
  const moveTarget = (key: string, target: string[]) => ({
    onDragOver: (e: DragEvent) => {
      const m = cardMoving.value;
      if (!m || !e.dataTransfer?.types.includes(CARD_MOVE) || !inImport(target)) return;
      if (target.length === dir.length + 1 && m.includes(target[target.length - 1])) return; // a folder into itself
      if (target.join("/") === dir.join("/")) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "move";
      setMoveOver(key);
    },
    onDragLeave: (e: DragEvent) => { if (!(e.currentTarget as Node).contains(e.relatedTarget as Node | null)) setMoveOver(null); },
    onDrop: (e: DragEvent) => {
      const raw = e.dataTransfer?.getData(CARD_MOVE);
      setMoveOver(null);
      if (!raw) return;
      e.preventDefault();
      e.stopPropagation();
      void moveCardEntries(JSON.parse(raw) as string[], target);
    },
  });
  const edit = cardEdit.value;
  const [editText, setEditText] = useState("");
  const editInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!edit) return;
    setEditText(edit.kind === "rename" ? edit.name : "Новая папка");
    setTimeout(() => editInput.current?.select(), 0);
  }, [edit]);
  useEffect(() => { cardEdit.value = null; }, [key]);
  const editError = edit ? cardNameError(editText) : null;
  const commitEdit = async () => {
    if (!edit || editError) return;
    const ok = edit.kind === "new" ? await createCardFolder(editText) : await renameCardEntry(edit.name, editText);
    if (ok) cardEdit.value = null;
  };
  const editField = (
    <span class="card-edit">
      <input ref={editInput} value={editText} spellcheck={false} class={editError ? "invalid" : ""} aria-label={edit?.kind === "new" ? "Имя новой папки" : "Новое имя"}
        title={editError ?? "Enter — сохранить, Esc — отменить"}
        onInput={(e) => setEditText((e.target as HTMLInputElement).value)}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Enter") void commitEdit();
          if (e.key === "Escape") cardEdit.value = null;
        }} />
    </span>
  );

  return (
    <aside class={`inspector glass card-browser ${dropping ? "drop" : ""}`}
      onDragOver={(e) => { if (!fromComputer(e)) return; e.preventDefault(); e.dataTransfer!.dropEffect = upload ? "copy" : "none"; setDropping(upload); }}
      onDragLeave={(e) => { if (!(e.currentTarget as Node).contains(e.relatedTarget as Node | null)) setDropping(false); }}
      onDrop={(e) => {
        if (!fromComputer(e)) return;
        e.preventDefault();
        setDropping(false);
        void uploadToCard([...(e.dataTransfer?.files ?? [])]);
      }}>
      <div class="card-path">
        <nav aria-label="Путь на карте">
          <button class="crumb" disabled={!dir.length || !!busy} onClick={() => openCardDir([])}>Карта</button>
          {dir.map((d, i) => (
            <span key={i}>
              <span class="sep">/</span>
              <button class={`crumb ${moveOver === `crumb:${i}` ? "move-over" : ""}`} disabled={i === dir.length - 1 || !!busy} onClick={() => openCardDir(dir.slice(0, i + 1))}
                {...moveTarget(`crumb:${i}`, dir.slice(0, i + 1))}>{d}</button>
            </span>
          ))}
        </nav>
        {upload && sel.size > 0 && (
          <button class="btn insp-delete card-delete" disabled={!ready || !!busy} onClick={() => (cardConfirm.value = true)}
            title={`Удалить с карты выбранное (${sel.size}) — Delete`} aria-label="Удалить с карты"><IconTrash /></button>
        )}
        {upload && sel.size === 1 && (
          <button class="icon-btn" disabled={!ready || !!busy} onClick={() => (cardEdit.value = { kind: "rename", name: [...sel][0] })}
            title="Переименовать (F2)" aria-label="Переименовать"><IconPencil /></button>
        )}
        {upload && (
          <button class="icon-btn" disabled={!ready || !!busy} onClick={() => (cardEdit.value = { kind: "new" })}
            title="Новая папка" aria-label="Новая папка"><IconFolderPlus /></button>
        )}
        {upload && (
          <button class="btn card-upload" disabled={!ready || !!busy} onClick={() => picker.current?.click()}
            title="Скопировать аудио с компьютера в эту папку на карте — потом его видно в IMPORT на самом SP">
            <IconUpload /> С компьютера…
          </button>
        )}
        <input ref={picker} type="file" multiple accept="audio/*,.wav,.aif,.aiff,.flac,.mp3" hidden
          onChange={(e) => { const f = (e.target as HTMLInputElement).files; if (f) void uploadToCard([...f]); (e.target as HTMLInputElement).value = ""; }} />
        <button class="icon-btn" disabled={!ready || !!busy} onClick={() => openCardDir(dir)} title="Перечитать папку" aria-label="Перечитать"><IconRefresh /></button>
      </div>
      {cardConfirm.value && upload && sel.size > 0 && (
        <div class="confirm-delete card-confirm" role="alertdialog" aria-label="Подтверждение удаления"
          onKeyDown={(e) => { if (e.key === "Escape") cardConfirm.value = false; }}>
          <span class="confirm-text">Удалить с карты {sel.size === 1 ? "это" : `${sel.size} шт.`}? Вернуть будет нельзя.</span>
          <span class="group-names">
            {all.filter((e) => sel.has(e.name)).map((e) => (e.dir ? `${e.name}/ (папка со всем содержимым)` : e.name)).join(", ")}
          </span>
          <button ref={yes} class="btn btn-danger" onClick={() => void deleteCardSelection()}><IconTrash /> Удалить</button>
          <button class="btn" onClick={() => (cardConfirm.value = false)}>Отмена</button>
        </div>
      )}
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
              <li class={`card-row dir ${moveOver === ".." ? "move-over" : ""}`} onClick={() => !busy && openCardDir(dir.slice(0, -1))}
                {...moveTarget("..", dir.slice(0, -1))}>
                <IconFolder /><span class="card-name">..</span><span />
              </li>
            )}
            {edit?.kind === "new" && (
              <li class="card-row dir editing"><IconFolderPlus />{editField}<span class="card-size">{editError ?? "Enter"}</span></li>
            )}
            {entries?.map((e) => {
              const path = cardPath(dir, e.name), au = isAudio(e), playing = cardPlaying.value === path;
              return (
                <li key={e.name} class={`card-row ${e.dir ? "dir" : au ? "audio" : "other"} ${sel.has(e.name) ? "sel" : ""} ${moveOver === `dir:${e.name}` ? "move-over" : ""}`}
                  draggable={(au || upload) && !(edit?.kind === "rename" && edit.name === e.name)}
                  onDragStart={(ev) => dragStart(ev, e)} onDragEnd={() => { cardMoving.value = null; setMoveOver(null); }}
                  onClick={(ev) => !busy && click(ev, e)}
                  {...(e.dir ? moveTarget(`dir:${e.name}`, [...dir, e.name]) : {})}
                  title={e.dir ? "Открыть папку" : au ? "Перетащите на пустой pad; Ctrl/Shift — несколько файлов" : "Не аудио"}>
                  {e.dir ? <IconFolder /> : <IconFile />}
                  {edit?.kind === "rename" && edit.name === e.name ? editField : <span class="card-name">{e.name}</span>}
                  {e.dir && upload ? (
                    // Folders open with a click, so they get their own rename / delete (they are hard to pick).
                    <>
                      <button class="icon-btn card-row-act" disabled={!!busy} aria-label={`Переименовать ${e.name}`} title="Переименовать папку"
                        onClick={(ev) => { ev.stopPropagation(); cardEdit.value = { kind: "rename", name: e.name }; }}><IconPencil /></button>
                      <button class="icon-btn card-row-act danger" disabled={!!busy} aria-label={`Удалить ${e.name}`} title="Удалить папку со всем содержимым"
                        onClick={(ev) => { ev.stopPropagation(); cardSel.value = new Set([e.name]); cardConfirm.value = true; }}><IconTrash /></button>
                    </>
                  ) : <span class="card-size">{fmtSize(e.size)}</span>}
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
      <p class="hint">Перетащите аудио на пустой pad — файлы займут его и следующие пустые pad'ы банка. Ctrl/Shift-клик — несколько файлов. ▶ — прослушать на компьютере.
        {upload ? " Файлы с компьютера можно бросить сюда — они лягут в эту папку (существующие не заменяются). Ctrl-клик по папке выбирает её; перетащите выбранное на папку, «..» или путь сверху — перенос; F2 — переименовать; Delete — удалить." : " Файлы с компьютера кладутся в папку IMPORT; удалять можно тоже только там."}</p>
    </aside>
  );
}
