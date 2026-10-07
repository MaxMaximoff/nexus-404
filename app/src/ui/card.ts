// The SD card in the SP's slot, read-only for now: browse it, listen to audio in the browser, and
// drop audio files from it onto pads (the same import as files from the computer). The card is
// its own filesystem at "/" (IMPORT/, EXPORT/SAMPLE/, BKUP/); projects live in the device's own
// storage, not here (SparkyMK2 spec 01-transport.md).

import { computed, signal } from "@preact/signals";
import { CARD, padName } from "../sp404";
import { importFiles, log, notice, pads, project, writeBlockReason, withDevice } from "./store";

export interface CardEntry { name: string; dir: boolean; size: number | null }

/** Drag data for card files dropped on a pad: JSON array of card paths. */
export const CARD_DRAG = "application/x-nexus-card";
/** Drag data for entries moved to another folder inside IMPORT/: JSON array of names in the open folder. */
export const CARD_MOVE = "application/x-nexus-card-move";
/** Names being dragged within the card browser (drag data cannot be read before the drop). */
export const cardMoving = signal<string[] | null>(null);
/** A name being typed in the list: a new folder, or a new name for an entry. */
export const cardEdit = signal<{ kind: "new" } | { kind: "rename"; name: string } | null>(null);
export const AUDIO_RE = /\.(wav|aiff?|flac|mp3|ogg|m4a|aac)$/i;
export const isAudio = (e: CardEntry) => !e.dir && AUDIO_RE.test(e.name);

const PATH_KEY = "nexus404.card.path";
function savedPath(): string[] {
  try { const v = JSON.parse(localStorage.getItem(PATH_KEY) ?? "[]"); return Array.isArray(v) ? v.filter((x) => typeof x === "string") : []; } catch { return []; }
}

const TAB_KEY = "nexus404.side.tab";
type Side = "pad" | "card" | "rec";
function savedTab(): Side { // the recorder is not restored: it would open an input on load
  try { return localStorage.getItem(TAB_KEY) === "card" ? "card" : "pad"; } catch { return "pad"; }
}
/** What the right column shows: the pad inspector, the SD card browser or the recorder. */
export const sideTab = signal<Side>(savedTab());
export function showSide(tab: Side): void {
  sideTab.value = tab;
  try { localStorage.setItem(TAB_KEY, tab); } catch { /* private mode */ }
}

/** Picked entries of the open folder (names), and whether their deletion waits for confirmation. */
export const cardSel = signal<ReadonlySet<string>>(new Set());
export const cardConfirm = signal(false);

/** Folders from the card root. */
export const cardDir = signal<string[]>(savedPath());
export const cardEntries = signal<CardEntry[] | null>(null);
export const cardError = signal<string | null>(null);
/** What the card is busy with: listing, reading for import, reading to listen. */
export const cardBusy = signal<{ text: string; progress: number | null } | null>(null);
/** File playing in the browser (not on the SP). */
export const cardPlaying = signal<string | null>(null);

export const cardPath = (dir: string[], name?: string) => `${CARD}/${[...dir, ...(name ? [name] : [])].join("/")}`;

/** Windows' own folder on the card and dot files: nothing to do with samples. */
const HIDDEN = /^(\.|System Volume Information$)/i;

const collator = new Intl.Collator("ru", { numeric: true, sensitivity: "base" });

/** List a folder: folders first, then files, in natural order; sizes from stat. */
export async function openCardDir(dir: string[]): Promise<void> {
  if (cardBusy.value) return;
  cardBusy.value = { text: "Читаю папку…", progress: null };
  cardError.value = null;
  try {
    const path = cardPath(dir);
    const entries = await withDevice(async (d) => {
      const list = (await d.listDir(path)).filter((e) => !HIDDEN.test(e.name));
      const out: CardEntry[] = [];
      for (const e of list) out.push({ ...e, size: e.dir ? null : (await d.stat(cardPath(dir, e.name)))?.size ?? null });
      return out;
    });
    entries.sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : collator.compare(a.name, b.name)));
    if (dir.join("/") !== cardDir.value.join("/")) cardSel.value = new Set();
    else cardSel.value = new Set([...cardSel.value].filter((n) => entries.some((e) => e.name === n)));
    cardConfirm.value = false;
    cardDir.value = dir;
    cardEntries.value = entries;
    try { localStorage.setItem(PATH_KEY, JSON.stringify(dir)); } catch { /* private mode */ }
  } catch (e) {
    cardError.value = (e as Error).message;
    if (!cardEntries.value) cardEntries.value = [];
  } finally {
    cardBusy.value = null;
  }
}

// Recently read files, so listening first and importing after does not read them twice.
const cache = new Map<string, Uint8Array>();
const CACHE_BYTES = 64 * 1024 * 1024;

async function readCardFile(path: string, what: string): Promise<Uint8Array> {
  const hit = cache.get(path);
  if (hit) return hit;
  const data = await withDevice((d) => d.readFile(path, Infinity, (a, b) => (cardBusy.value = { text: what, progress: a / b })));
  if (!data) throw new Error(`на карте нет ${path}`);
  cache.set(path, data);
  let total = 0;
  for (const [k, v] of [...cache].reverse()) if ((total += v.length) > CACHE_BYTES && k !== path) cache.delete(k);
  return data;
}

let ctx: AudioContext | null = null;
let source: AudioBufferSourceNode | null = null;

export function stopCardPreview(): void {
  try { source?.stop(); } catch { /* already stopped */ }
  source = null;
  cardPlaying.value = null;
}

/** Listen to a card file in the browser, through the computer's speakers. */
export async function previewCardFile(name: string): Promise<void> {
  const path = cardPath(cardDir.value, name);
  if (cardPlaying.value === path) return stopCardPreview();
  stopCardPreview();
  if (cardBusy.value) return;
  try {
    cardBusy.value = { text: `Читаю ${name}…`, progress: 0 };
    const data = await readCardFile(path, `Читаю ${name}…`);
    cardBusy.value = null;
    ctx ??= new AudioContext();
    const buf = await ctx.decodeAudioData(data.slice().buffer);
    const s = ctx.createBufferSource();
    s.buffer = buf;
    s.connect(ctx.destination);
    s.onended = () => { if (source === s) { source = null; cardPlaying.value = null; } };
    source = s;
    cardPlaying.value = path;
    s.start();
  } catch (e) {
    cardBusy.value = null;
    notice.value = { kind: "error", text: `Не удалось прослушать ${name}: ${(e as Error).message}` };
  }
}

/** Files from the computer may go into IMPORT/ and its folders only (what the SP's own IMPORT browser reads). */
export const canUploadHere = computed(() => cardDir.value[0]?.toUpperCase() === "IMPORT");

/**
 * Copy audio files from the computer into the open IMPORT/ folder, one by one with progress. Names
 * already in the folder are skipped: nothing on the card is replaced.
 */
export async function uploadToCard(files: File[]): Promise<void> {
  if (!canUploadHere.value) return void (notice.value = { kind: "error", text: "Файлы с компьютера кладутся только в папку IMPORT (и её подпапки)" });
  if (cardBusy.value) return void (notice.value = { kind: "error", text: "Карта занята — дождитесь конца" });
  const dir = cardDir.value;
  const audio = files.filter((f) => AUDIO_RE.test(f.name));
  const have = new Set((cardEntries.value ?? []).map((e) => e.name.toLowerCase()));
  const skipped = audio.filter((f) => have.has(f.name.toLowerCase())).map((f) => f.name);
  const todo = audio.filter((f) => !have.has(f.name.toLowerCase()));
  const notAudio = files.length - audio.length;
  let done = 0;
  try {
    for (const [i, f] of todo.entries()) {
      const what = `Записываю на карту${todo.length > 1 ? ` ${i + 1} из ${todo.length}` : ""}: ${f.name}`;
      cardBusy.value = { text: what, progress: 0 };
      const data = new Uint8Array(await f.arrayBuffer());
      await withDevice((d) => d.writeCardFile(cardPath(dir, f.name), data, (a, b) => (cardBusy.value = { text: what, progress: a / b })));
      done++;
    }
  } catch (e) {
    notice.value = { kind: "error", text: `Запись на карту: ${(e as Error).message}` };
  } finally {
    cardBusy.value = null;
  }
  if (done) log("info", `На карту в ${cardPath(dir).slice(CARD.length)}: ${todo.slice(0, done).map((f) => f.name).join(", ")}`);
  const notes = [skipped.length && `уже есть на карте: ${skipped.join(", ")}`, notAudio && `не аудио: ${notAudio}`].filter(Boolean);
  if (notes.length && !notice.value) notice.value = { kind: "info", text: `Пропущено — ${notes.join("; ")}` };
  await openCardDir(dir);
}

/**
 * Delete the picked files and folders (folders with everything in them) from the open folder,
 * inside IMPORT/ only; the user has confirmed it. Stops at the first error.
 */
export async function deleteCardSelection(): Promise<void> {
  cardConfirm.value = false;
  if (!canUploadHere.value || cardBusy.value) return;
  const dir = cardDir.value;
  const names = (cardEntries.value ?? []).filter((e) => cardSel.value.has(e.name)).map((e) => e.name);
  if (!names.length) return;
  let n = 0;
  try {
    for (const name of names) {
      cardBusy.value = { text: `Удаляю ${name}…`, progress: null };
      n += await withDevice((d) => d.deleteCardPath(cardPath(dir, name), (wire) => {
        cache.delete(CARD + wire);
        if (cardPlaying.value === CARD + wire) stopCardPreview();
        cardBusy.value = { text: `Удаляю ${wire}`, progress: null };
      }));
    }
  } catch (e) {
    notice.value = { kind: "error", text: `Удаление с карты: ${(e as Error).message}` };
  } finally {
    cardBusy.value = null;
  }
  if (n) log("info", `С карты удалено (${n}): ${names.map((x) => `${cardPath(dir, x).slice(CARD.length)}`).join(", ")}`);
  cardSel.value = new Set();
  await openCardDir(dir);
}

export const inImport = (dir: string[]) => dir[0]?.toUpperCase() === "IMPORT";

/** Why the card would not take this file or folder name (FAT rules), or null. */
export function cardNameError(name: string): string | null {
  const n = name.trim();
  if (!n) return "пустое имя";
  if (n === "." || n === ".." || n.endsWith(".")) return "имя не может быть «.», «..» или кончаться точкой";
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(n)) return "нельзя символы \\ / : * ? \" < > |";
  return null;
}

/** After a change on the card: re-read the folder, then pick `names` there. */
async function refreshPicking(dir: string[], names: string[]): Promise<void> {
  cache.clear(); // paths have changed
  await openCardDir(dir);
  cardSel.value = new Set(names.filter((n) => cardEntries.value?.some((e) => e.name === n)));
}

/** New folder in the open IMPORT/ folder. */
export async function createCardFolder(name: string): Promise<boolean> {
  const n = name.trim(), dir = cardDir.value, err = cardNameError(n);
  if (err) { notice.value = { kind: "error", text: `Имя папки: ${err}` }; return false; }
  if (!inImport(dir) || cardBusy.value) return false;
  cardBusy.value = { text: `Создаю папку ${n}…`, progress: null };
  try {
    await withDevice((d) => d.mkdirCard(cardPath(dir, n)));
    log("info", `Папка на карте: ${cardPath(dir, n).slice(CARD.length)}`);
  } catch (e) {
    notice.value = { kind: "error", text: `Новая папка: ${(e as Error).message}` };
    return false;
  } finally {
    cardBusy.value = null;
  }
  await refreshPicking(dir, [n]);
  return true;
}

/** Rename a file or folder in the open IMPORT/ folder. */
export async function renameCardEntry(old: string, name: string): Promise<boolean> {
  const n = name.trim(), dir = cardDir.value, err = cardNameError(n);
  if (n === old) return true;
  if (err) { notice.value = { kind: "error", text: `Новое имя: ${err}` }; return false; }
  if (!inImport(dir) || cardBusy.value) return false;
  if (cardPlaying.value === cardPath(dir, old)) stopCardPreview();
  cardBusy.value = { text: `Переименовываю ${old}…`, progress: null };
  try {
    await withDevice((d) => d.renameCard(cardPath(dir, old), cardPath(dir, n)));
    log("info", `На карте: ${old} → ${n}`);
  } catch (e) {
    notice.value = { kind: "error", text: `Переименование: ${(e as Error).message}` };
    return false;
  } finally {
    cardBusy.value = null;
  }
  await refreshPicking(dir, [n]);
  return true;
}

/**
 * Move entries of the open folder into `target` (inside IMPORT/), one by one; names already in
 * the target are skipped, nothing is replaced. Stops at any other error.
 */
export async function moveCardEntries(names: string[], target: string[]): Promise<void> {
  const dir = cardDir.value;
  if (!inImport(dir) || !inImport(target) || cardBusy.value || !names.length) return;
  if (target.join("/") === dir.join("/")) return;
  stopCardPreview();
  const moved: string[] = [], skipped: string[] = [];
  try {
    for (const [i, name] of names.entries()) {
      cardBusy.value = { text: `Переношу${names.length > 1 ? ` ${i + 1} из ${names.length}` : ""}: ${name}`, progress: null };
      try {
        await withDevice((d) => d.renameCard(cardPath(dir, name), cardPath(target, name)));
        moved.push(name);
      } catch (e) {
        if (!/уже есть/.test((e as Error).message)) throw e;
        skipped.push(name);
      }
    }
  } catch (e) {
    notice.value = { kind: "error", text: `Перенос: ${(e as Error).message}` };
  } finally {
    cardBusy.value = null;
  }
  const to = cardPath(target).slice(CARD.length);
  if (moved.length) log("info", `На карте в ${to}: ${moved.join(", ")}`);
  if (skipped.length && !notice.value) notice.value = { kind: "info", text: `В ${to} уже есть: ${skipped.join(", ")} — эти не перенесены` };
  await refreshPicking(dir, []);
}

const MIME: Record<string, string> = { wav: "audio/wav", aif: "audio/aiff", aiff: "audio/aiff", flac: "audio/flac", mp3: "audio/mpeg", ogg: "audio/ogg", m4a: "audio/mp4", aac: "audio/aac" };

/**
 * Card files dropped on a pad: read them from the card, then the usual import (the pad and the
 * empty pads after it in its bank, BPM from the name or by sound).
 */
export async function importFromCard(paths: string[], startPad: number): Promise<void> {
  const blocked = writeBlockReason.value
    ?? (project.value?.banks[startPad >> 4]?.protected ? "Банк защищён (BANK Protect на SP)" : null)
    ?? (pads.value[startPad]?.size ? `${padName(startPad)} занят. Перетащите на пустой pad` : null)
    ?? (cardBusy.value ? "Карта занята — дождитесь конца" : null);
  if (blocked) return void (notice.value = { kind: "error", text: blocked });
  const files: File[] = [];
  try {
    for (const [i, path] of paths.entries()) {
      const name = path.slice(path.lastIndexOf("/") + 1);
      const what = paths.length > 1 ? `Читаю с карты ${i + 1} из ${paths.length}: ${name}` : `Читаю с карты ${name}`;
      cardBusy.value = { text: what, progress: 0 };
      const data = await readCardFile(path, what);
      files.push(new File([data.slice()], name, { type: MIME[name.split(".").pop()!.toLowerCase()] ?? "" }));
    }
  } catch (e) {
    notice.value = { kind: "error", text: `Чтение с карты: ${(e as Error).message}` };
    return;
  } finally {
    cardBusy.value = null;
  }
  log("info", `С карты: ${files.map((f) => f.name).join(", ")} → ${padName(startPad)}`);
  importFiles(files, startPad);
}
