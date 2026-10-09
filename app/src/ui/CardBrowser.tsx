import { useEffect, useRef, useState } from "preact/hooks";
import {
  CARD_DRAG, CARD_MOVE, canUploadHere, uploadToCard, cardBusy, cardConfirm, cardEdit, cardMoving, cardNameError, cardSel, createCardFolder, deleteCardSelection,
  downloadCardFiles, inImport, moveCardEntries, renameCardEntry, cardDir, cardEntries, cardError, cardPath, cardPlaying, isAudio, openCardDir, previewCardFile, type CardEntry,
} from "./card";
import { conn } from "./store";
import { IconDownload, IconFile, IconFolder, IconFolderPlus, IconPencil, IconPlay, IconRefresh, IconStop, IconTrash, IconUpload } from "./icons";

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
  const pickedFiles = all.filter((e) => !e.dir && sel.has(e.name)).map((e) => e.name);
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
    setEditText(edit.kind === "rename" ? edit.name : "New folder");
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
      <input ref={editInput} value={editText} spellcheck={false} class={editError ? "invalid" : ""} aria-label={edit?.kind === "new" ? "New folder name" : "New name"}
        title={editError ?? "Enter to save, Esc to cancel"}
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
        <nav aria-label="Card path">
          <button class="crumb" disabled={!dir.length || !!busy} onClick={() => openCardDir([])}>Card</button>
          {dir.map((d, i) => (
            <span key={i}>
              <span class="sep">/</span>
              <button class={`crumb ${moveOver === `crumb:${i}` ? "move-over" : ""}`} disabled={i === dir.length - 1 || !!busy} onClick={() => openCardDir(dir.slice(0, i + 1))}
                {...moveTarget(`crumb:${i}`, dir.slice(0, i + 1))}>{d}</button>
            </span>
          ))}
        </nav>
        {pickedFiles.length > 0 && (
          <button class="icon-btn" disabled={!ready || !!busy} onClick={() => void downloadCardFiles(pickedFiles)}
            title={`Download to computer: ${pickedFiles.join(", ")}`} aria-label="Download selected files"><IconDownload /></button>
        )}
        {upload && sel.size > 0 && (
          <button class="btn insp-delete card-delete" disabled={!ready || !!busy} onClick={() => (cardConfirm.value = true)}
            title={`Delete selected items from card (${sel.size}) — Delete`} aria-label="Delete from card"><IconTrash /></button>
        )}
        {upload && sel.size === 1 && (
          <button class="icon-btn" disabled={!ready || !!busy} onClick={() => (cardEdit.value = { kind: "rename", name: [...sel][0] })}
            title="Rename (F2)" aria-label="Rename"><IconPencil /></button>
        )}
        {upload && (
          <button class="icon-btn" disabled={!ready || !!busy} onClick={() => (cardEdit.value = { kind: "new" })}
            title="New folder" aria-label="New folder"><IconFolderPlus /></button>
        )}
        {upload && (
          <button class="btn card-upload" disabled={!ready || !!busy} onClick={() => picker.current?.click()}
            title="Copy audio from the computer to this card folder — it will appear in IMPORT on SP">
            <IconUpload /> From computer…
          </button>
        )}
        <input ref={picker} type="file" multiple accept="audio/*,.wav,.aif,.aiff,.flac,.mp3" hidden
          onChange={(e) => { const f = (e.target as HTMLInputElement).files; if (f) void uploadToCard([...f]); (e.target as HTMLInputElement).value = ""; }} />
        <button class="icon-btn" disabled={!ready || !!busy} onClick={() => openCardDir(dir)} title="Refresh folder" aria-label="Refresh"><IconRefresh /></button>
      </div>
      {cardConfirm.value && upload && sel.size > 0 && (
        <div class="confirm-delete card-confirm" role="alertdialog" aria-label="Confirm deletion"
          onKeyDown={(e) => { if (e.key === "Escape") cardConfirm.value = false; }}>
          <span class="confirm-text">Delete from card {sel.size === 1 ? "this item" : `${sel.size} items`}? This cannot be undone.</span>
          <span class="group-names">
            {all.filter((e) => sel.has(e.name)).map((e) => (e.dir ? `${e.name}/ (folder and all its contents)` : e.name)).join(", ")}
          </span>
          <button ref={yes} class="btn btn-danger" onClick={() => void deleteCardSelection()}><IconTrash /> Delete</button>
          <button class="btn" onClick={() => (cardConfirm.value = false)}>Cancel</button>
        </div>
      )}
      {busy && (
        <div class="card-busy">
          <span>{busy.text}{busy.progress !== null && ` ${Math.round(busy.progress * 100)} %`}</span>
          {busy.progress !== null && <span class="bar"><span style={{ width: `${busy.progress * 100}%` }} /></span>}
        </div>
      )}
      {cardError.value && <span class="err">{cardError.value}</span>}
      {!ready ? <p class="muted">Connect SP to open the card.</p> : (
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
                  title={e.dir ? "Open folder" : au ? "Drag onto an empty pad; Ctrl/Shift to select multiple files" : "Not audio"}>
                  {e.dir ? <IconFolder /> : <IconFile />}
                  {edit?.kind === "rename" && edit.name === e.name ? editField : <span class="card-name">{e.name}</span>}
                  {e.dir && upload ? (
                    // Folders open with a click, so they get their own rename / delete (they are hard to pick).
                    <>
                      <button class="icon-btn card-row-act" disabled={!!busy} aria-label={`Rename ${e.name}`} title="Rename folder"
                        onClick={(ev) => { ev.stopPropagation(); cardEdit.value = { kind: "rename", name: e.name }; }}><IconPencil /></button>
                      <button class="icon-btn card-row-act danger" disabled={!!busy} aria-label={`Delete ${e.name}`} title="Delete folder and all its contents"
                        onClick={(ev) => { ev.stopPropagation(); cardSel.value = new Set([e.name]); cardConfirm.value = true; }}><IconTrash /></button>
                    </>
                  ) : (
                    <>
                      <span class="card-size">{fmtSize(e.size)}</span>
                      {!e.dir ? (
                        <button class="icon-btn card-row-act" disabled={!!busy} aria-label={`Download ${e.name}`} title="Download to computer"
                          onClick={(ev) => { ev.stopPropagation(); void downloadCardFiles([e.name]); }}><IconDownload /></button>
                      ) : <span />}
                    </>
                  )}
                  {au && (
                    <button class={`icon-btn card-play ${playing ? "on" : ""}`} disabled={!!busy && !playing} aria-label={playing ? "Stop" : "Preview"}
                      title={playing ? "Stop" : "Preview on computer"} onClick={(ev) => { ev.stopPropagation(); void previewCardFile(e.name); }}>
                      {playing ? <IconStop /> : <IconPlay />}
                    </button>
                  )}
                </li>
              );
            })}
            {entries && !entries.length && <li class="muted card-empty">{dir.length ? "Folder is empty" : "Empty. Is a card inserted in SP?"}</li>}
          </ul>
        </div>
      )}
      <p class="hint">Drag audio onto an empty pad — files fill that pad and the next empty pads in the bank. Ctrl/Shift-click to select multiple files. ▶ previews audio on the computer.
        {upload ? " Drop files from the computer here to upload them to this folder (existing files are kept). Ctrl-click to select a folder; drag selected items onto a folder, ‘..’ or the path above to move them. F2 to rename; Delete to delete." : " Files from the computer go into IMPORT; deletion is also limited to that folder."}</p>
    </aside>
  );
}
