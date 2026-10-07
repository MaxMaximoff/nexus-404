// The SD card in the SP's slot, read-only for now: browse it, listen to audio in the browser, and
// drop audio files from it onto pads (the same import as files from the computer). The card is
// its own filesystem at "/" (IMPORT/, EXPORT/SAMPLE/, BKUP/); projects live in the device's own
// storage, not here (SparkyMK2 spec 01-transport.md).

import { signal } from "@preact/signals";
import { CARD, padName } from "../sp404";
import { importFiles, log, notice, pads, project, writeBlockReason, withDevice } from "./store";

export interface CardEntry { name: string; dir: boolean; size: number | null }

/** Drag data for card files dropped on a pad: JSON array of card paths. */
export const CARD_DRAG = "application/x-nexus-card";
export const AUDIO_RE = /\.(wav|aiff?|flac|mp3|ogg|m4a|aac)$/i;
export const isAudio = (e: CardEntry) => !e.dir && AUDIO_RE.test(e.name);

const PATH_KEY = "nexus404.card.path";
function savedPath(): string[] {
  try { const v = JSON.parse(localStorage.getItem(PATH_KEY) ?? "[]"); return Array.isArray(v) ? v.filter((x) => typeof x === "string") : []; } catch { return []; }
}

const TAB_KEY = "nexus404.side.tab";
function savedTab(): "pad" | "card" {
  try { return localStorage.getItem(TAB_KEY) === "card" ? "card" : "pad"; } catch { return "pad"; }
}
/** What the right column shows: the pad inspector or the SD card browser. */
export const sideTab = signal<"pad" | "card">(savedTab());
export function showSide(tab: "pad" | "card"): void {
  sideTab.value = tab;
  try { localStorage.setItem(TAB_KEY, tab); } catch { /* private mode */ }
}

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
