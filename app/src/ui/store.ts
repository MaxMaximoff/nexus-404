// App state (signals) and the controller that drives the device.

import { batch, computed, signal } from "@preact/signals";
import {
  PAD_COUNT, SP404Device, SampleUploader, WebSerialTransport, bpmFromFileName, computeEnvelope, computePeaks, isSp404Port,
  BPM_RANGES, VARI_MODES, byteToFrame, detectBpm, newJob, padName, samplePath, smpToPcm,
  type BpmResult, type DeviceStatus, type ImportJob, type LogLevel, type PadBlock, type ProjectSettings,
} from "../sp404";

export type Conn = "unsupported" | "idle" | "connecting" | "loading" | "ready" | "lost";

export interface Waveform {
  key: string;
  peaks: Float32Array[];
  envelope: Uint16Array;
  channels: number;
  frames: number;
  /** Interleaved PCM for zooming in; dropped from all but the newest SAMPLE_CACHE waveforms. */
  samples?: Int16Array;
}
export interface LogLine { t: string; level: LogLevel; text: string }

const WAVE_POINTS = 640;
const SAMPLE_CACHE = 16;
const AUTO_WAVE_MAX_BYTES = 4 * 1024 * 1024;
const POLL_MS = 1000;

export const conn = signal<Conn>(WebSerialTransport.supported() ? "idle" : "unsupported");
export const hasGrant = signal(false);
export const status = signal<DeviceStatus | null>(null);
export const project = signal<(ProjectSettings & { names: string[] }) | null>(null);
export const pads = signal<(PadBlock | null)[]>(Array(PAD_COUNT).fill(null));
export const loadProgress = signal(0);
export const freeKb = signal<number | null>(null);
export const selectedBank = signal(0);
export const selectedPad = signal(0);
export const jobs = signal<ImportJob[]>([]);
export const waveforms = signal(new Map<number, Waveform>());
export const waveLoading = signal<{ pad: number; progress: number } | null>(null);
/** Channel count per pad (from the SMP header), keyed like waveforms so a new sample invalidates it. */
export const padChannels = signal(new Map<number, { key: string; channels: number }>());
export const logLines = signal<LogLine[]>([]);
export const showDebug = signal(false);
export const defaultBpm = signal("");
export const notice = signal<{ kind: "error" | "info"; text: string } | null>(null);

export const project1 = computed(() => (status.value ? status.value.project + 1 : 0));
export const writeBlockReason = computed<string | null>(() => {
  if (conn.value !== "ready") return "SP не подключён";
  if (status.value && status.value.workingMode !== 0) return "SP показывает меню — закройте его на устройстве";
  return null;
});
export const importing = computed(() => jobs.value.some((j) => j.state === "queued" || j.state === "decoding" || j.state === "uploading"));

let device: SP404Device | null = null;
let transport: WebSerialTransport | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let reloadTimer: ReturnType<typeof setTimeout> | null = null;
let importChain: Promise<unknown> = Promise.resolve();
const reserved = new Set<number>(); // pads targeted by queued jobs

export function log(level: LogLevel, text: string): void {
  const t = new Date().toTimeString().slice(0, 8);
  const next = [...logLines.value, { t, level, text }];
  logLines.value = next.length > 600 ? next.slice(-500) : next;
  if (level === "error") console.error(text);
}

function fail(e: unknown, context: string): void {
  const text = `${context}: ${(e as Error).message ?? e}`;
  log("error", text);
  notice.value = { kind: "error", text };
}

// ------------------------------------------------------------------ connection

export async function refreshGrant(): Promise<void> {
  hasGrant.value = (await WebSerialTransport.grantedPorts()).length > 0;
}

export async function connect(): Promise<void> {
  try {
    await openPort(await WebSerialTransport.request());
  } catch (e) {
    if ((e as DOMException).name === "NotFoundError") return; // chooser cancelled
    fail(e, "Подключение");
    conn.value = "idle";
  }
}

export async function reconnect(silent = false): Promise<void> {
  const [port] = await WebSerialTransport.grantedPorts();
  if (!port) return silent ? undefined : connect();
  try {
    await openPort(port);
  } catch (e) {
    if (silent) log("info", `Автоподключение не удалось: ${(e as Error).message}`);
    else fail(e, "Переподключение");
    teardown();
    conn.value = "idle";
  }
}

async function openPort(port: SerialPort): Promise<void> {
  conn.value = "connecting";
  notice.value = null;
  const t = new WebSerialTransport(port);
  t.onLost = (reason) => {
    if (transport !== t) return;
    log("warn", `Связь потеряна: ${reason}`);
    teardown();
    conn.value = "lost";
  };
  try {
    await t.open();
  } catch (e) {
    throw new Error(`${(e as Error).message}. Порт занят? Закройте SP-404MKII App и другие вкладки`);
  }
  transport = t;
  device = new SP404Device(t, (level, text) => (level !== "debug" || showDebug.value) && log(level, text));
  device.onNotification = (m) => {
    if (m.payload[0] === 0x1a) scheduleReload(500);
  };
  await loadAll(true);
  pollTimer = setInterval(poll, POLL_MS);
  refreshGrant();
}

function teardown(): void {
  if (pollTimer) clearInterval(pollTimer);
  if (reloadTimer) clearTimeout(reloadTimer);
  pollTimer = reloadTimer = null;
  playing.value = null;
  device = null;
  transport = null;
}

export async function disconnect(): Promise<void> {
  const d = device, t = transport;
  teardown();
  try { await d?.exclusive((x) => x.mkiiExit()); } catch { /* the link may already be gone */ }
  await t?.close();
  batch(() => {
    conn.value = "idle";
    status.value = null;
  });
  log("info", "Отключено");
}

if (WebSerialTransport.supported()) {
  navigator.serial.addEventListener("connect", (e) => {
    refreshGrant();
    const port = e.target as SerialPort;
    if (isSp404Port(port) && conn.value === "lost") {
      log("info", "SP снова подключён — переподключаюсь");
      setTimeout(() => conn.value === "lost" && reconnect(true), 1500);
    }
  });
  navigator.serial.addEventListener("disconnect", () => refreshGrant());
  refreshGrant().then(() => {
    // Previously granted port and the unit plugged in: connect without asking.
    if (hasGrant.value && conn.value === "idle") reconnect(true);
  });
}

// ------------------------------------------------------------------ reading

async function loadAll(first = false): Promise<void> {
  const d = device;
  if (!d) return;
  conn.value = "loading";
  loadProgress.value = 0;
  try {
    await d.exclusive(async (x) => {
      const st = await x.status();
      const ps = await x.projectSettings(st.project);
      const blocks = await x.allPadBlocks((done, total) => (loadProgress.value = done / total));
      const kb = await x.freeKb().catch(() => null);
      batch(() => {
        status.value = st;
        project.value = ps;
        pads.value = blocks;
        freeKb.value = kb;
        waveforms.value = new Map();
        padChannels.value = new Map();
        if (first) {
          selectedBank.value = st.bank;
          selectedPad.value = st.bank * 16 + st.pad;
        }
      });
      log("info", `Проект ${st.project + 1} «${ps.name || ps.names[st.project]}»: ${blocks.filter((b) => b.size).length} сэмплов`);
    });
    if (device === d) conn.value = "ready";
    loadWaveformIfSmall(selectedPad.value);
  } catch (e) {
    if (device === d) {
      fail(e, "Чтение SP");
      conn.value = "ready";
    }
  }
}

export function scheduleReload(ms: number): void {
  if (reloadTimer) clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    reloadTimer = null;
    if (device && !importing.value) loadAll();
  }, ms);
}

export const reload = () => device && loadAll();

async function poll(): Promise<void> {
  const d = device;
  if (!d || conn.value !== "ready") return;
  try {
    const st = await d.tryExclusive((x) => x.status());
    if (!st || device !== d) return;
    const prev = status.value;
    status.value = st;
    if (prev && prev.project !== st.project) {
      log("info", `На SP выбран проект ${st.project + 1} — жду, пока он загрузится`);
      // Pad blocks read empty while the device is still loading a project (report §0).
      scheduleReload(2500);
    }
  } catch {
    /* a missed poll is not worth reporting; a dead link reports itself via onLost */
  }
}

// ------------------------------------------------------------------ selection & waveform

let selectTimer: ReturnType<typeof setTimeout> | null = null;

export function selectPad(pad: number): void {
  batch(() => {
    selectedPad.value = pad;
    selectedBank.value = pad >> 4;
  });
  // Keep the unit on the same pad, like the official app (debounced for quick clicking).
  if (selectTimer) clearTimeout(selectTimer);
  selectTimer = setTimeout(() => {
    const d = device, st = status.value;
    if (!d || conn.value !== "ready" || (st && st.bank * 16 + st.pad === pad)) return;
    d.exclusive((x) => x.selectOnDevice(pad))
      .then(() => { if (status.value) status.value = { ...status.value, bank: pad >> 4, pad: pad & 15 }; })
      .catch((e) => log("warn", `Выбор pad'а на SP: ${(e as Error).message}`));
  }, 120);
  loadWaveformIfSmall(pad);
}

const waveKey = (b: PadBlock) => `${b.size}:${b.name}`;

function loadWaveformIfSmall(pad: number): void {
  const b = pads.value[pad];
  if (!b?.size || waveforms.value.get(pad)?.key === waveKey(b)) return;
  if (b.size <= AUTO_WAVE_MAX_BYTES) loadWaveform(pad);
  else loadChannels(pad);
}

export async function loadWaveform(pad: number): Promise<void> {
  const d = device, b = pads.value[pad];
  if (!d || !b?.size || waveLoading.value) return;
  waveLoading.value = { pad, progress: 0 };
  try {
    const smp = await d.exclusive((x) => x.readFile(samplePath(project1.value, pad), Infinity, (done, total) => (waveLoading.value = { pad, progress: done / total })));
    const pcm = smp && smpToPcm(smp);
    if (!pcm) throw new Error("файл сэмпла не найден");
    setWaveform(pad, b, pcm.samples, pcm.channels);
  } catch (e) {
    fail(e, `Волна ${padName(pad)}`);
  } finally {
    waveLoading.value = null;
  }
}

function setWaveform(pad: number, b: PadBlock, samples: Int16Array, channels: number): void {
  const m = new Map(waveforms.value);
  m.delete(pad); // re-insert so the map stays in age order
  m.set(pad, {
    key: waveKey(b), peaks: computePeaks(samples, channels, WAVE_POINTS), envelope: computeEnvelope(samples, channels),
    channels, frames: samples.length / channels, samples,
  });
  let keep = SAMPLE_CACHE;
  for (const [k, w] of [...m].reverse()) if (w.samples && --keep < 0) m.set(k, { ...w, samples: undefined });
  batch(() => {
    waveforms.value = m;
    rememberChannels(pad, b, channels);
  });
}

function rememberChannels(pad: number, b: PadBlock, channels: number): void {
  const m = new Map(padChannels.value);
  m.set(pad, { key: waveKey(b), channels });
  padChannels.value = m;
}

/** Channels of the selected pad's sample, as far as known; Start/End need it to convert bytes to frames. */
export const channelsOf = (pad: number): number | null => {
  const b = pads.value[pad], c = padChannels.value.get(pad);
  return b?.size && c?.key === waveKey(b) ? c.channels : null;
};

/** Read just the 512-byte SMP header when the sample is too big to load its waveform on its own. */
async function loadChannels(pad: number): Promise<void> {
  const d = device, b = pads.value[pad];
  if (!d || !b?.size || channelsOf(pad) !== null) return;
  try {
    const ch = await d.exclusive((x) => x.sampleChannels(project1.value, pad));
    const now = pads.value[pad];
    if (now && waveKey(now) === waveKey(b)) rememberChannels(pad, now, ch);
  } catch (e) {
    log("warn", `${padName(pad)}: ${(e as Error).message}`);
  }
}

// ------------------------------------------------------------------ writing

function setPad(block: PadBlock): void {
  const next = [...pads.value];
  next[block.index] = block;
  pads.value = next;
}

/** Run one pad edit on the device and show the block it returns. */
async function editPad(pad: number, what: string, fn: (d: SP404Device, p1: number) => Promise<PadBlock>): Promise<boolean> {
  const d = device;
  if (!d) return false;
  try {
    const b = await d.exclusive((x) => fn(x, project1.value));
    setPad(b);
    log("info", `${padName(pad)}: ${what}`);
    return true;
  } catch (e) {
    fail(e, `${padName(pad)}, ${what}`);
    return false;
  }
}

const onOff = (on: boolean) => (on ? "вкл" : "выкл");

export const setBpm = (pad: number, x100: number) => editPad(pad, `BPM ${(x100 / 100).toFixed(2)}`, (d, p1) => d.setBpm(p1, pad, x100));
export const setLevel = (pad: number, level: number) => editPad(pad, `Level ${level}`, (d, p1) => d.setLevel(p1, pad, level));
export const setGate = (pad: number, on: boolean) => editPad(pad, `Gate ${onOff(on)}`, (d, p1) => d.setGate(p1, pad, on));
export const setLoop = (pad: number, on: boolean) => editPad(pad, `Loop ${onOff(on)}`, (d, p1) => d.setLoop(p1, pad, on));
export const setBpmSync = (pad: number, on: boolean) => editPad(pad, `BPM Sync ${onOff(on)}`, (d, p1) => d.setBpmSync(p1, pad, on));
export const setVinyl = (pad: number, on: boolean) => editPad(pad, `Vinyl ${onOff(on)}`, (d, p1) => d.setVinyl(p1, pad, on));
export const setTimeStretch = (pad: number, x100: number) =>
  editPad(pad, `Time Stretch ${(x100 / 100).toFixed(2)} %`, (d, p1) => d.setTimeStretch(p1, pad, x100));
export const setPitch = (pad: number, coarse: number, fine: number) =>
  editPad(pad, `Pitch ${coarse} st ${fine} ct`, (d, p1) => d.setPitch(p1, pad, coarse, fine));
export const setVari = (pad: number, mode: number) => editPad(pad, `VARI MODE ${VARI_MODES[mode]}`, (d, p1) => d.setVari(p1, pad, mode));
export const setOneShot = (pad: number, on: boolean) => editPad(pad, `One Shot ${onOff(on)}`, (d, p1) => d.setOneShot(p1, pad, on));
export const setRange = (pad: number, start: number, end: number) =>
  editPad(pad, `Start/End ${start}–${end} кадров`, (d, p1) => d.setRange(p1, pad, start, end));

/** Run one project-wide edit (tempos) and show the settings it returns. */
async function editProject(what: string, fn: (d: SP404Device, p1: number) => Promise<ProjectSettings & { names: string[] }>): Promise<boolean> {
  const d = device;
  if (!d) return false;
  try {
    project.value = await d.exclusive((x) => fn(x, project1.value));
    log("info", `Проект ${project1.value}: ${what}`);
    return true;
  } catch (e) {
    fail(e, `Проект ${project1.value}, ${what}`);
    return false;
  }
}

const bpmText = (x100: number) => `${(x100 / 100).toFixed(2)} BPM`;
export const setProjectTempo = (x100: number) => editProject(`темп проекта ${bpmText(x100)}`, (d, p1) => d.setProjectTempo(p1, x100));
export const setBankTempo = (bank: number, x100: number) =>
  editProject(`темп банка ${padName(bank * 16)[0]} ${bpmText(x100)}`, (d, p1) => d.setBankTempo(p1, bank, x100));
export const setTempoSelect = (useProject: boolean) =>
  editProject(`действует темп ${useProject ? "проекта" : "банков"}`, (d, p1) => d.setTempoSelect(p1, useProject));

/** Range of BPM detection, index into BPM_RANGES (80–159 by default), as BPM SET AUTO on the SP. */
export const bpmRange = signal(1);

/**
 * Detect the tempo of a pad's sample between Start and End, reading the sample from the SP when
 * its PCM is not cached. Null: no clear beat; undefined: could not read the sample.
 */
export async function detectPadBpm(pad: number): Promise<BpmResult | null | undefined> {
  const b = pads.value[pad];
  if (!b?.size) return undefined;
  const cached = () => { const w = waveforms.value.get(pad); return w?.key === waveKey(b) ? w : undefined; };
  if (!cached()?.samples) await loadWaveform(pad);
  const w = cached();
  if (!w?.samples) return undefined;
  const ch = w.channels, from = Math.round(byteToFrame(b.startByte, ch)), to = Math.round(byteToFrame(b.endByte, ch));
  await new Promise((r) => setTimeout(r, 0)); // let "анализ…" paint: a long sample takes up to a second
  const [min, max] = BPM_RANGES[bpmRange.value]!;
  const r = detectBpm(w.samples.subarray(from * ch, to * ch), ch, min);
  log("info", `${padName(pad)}: BPM ${r ? (r.x100 / 100).toFixed(2) + (r.beats ? `, луп ${r.beats} долей` : "") + `, чёткость ${r.clarity.toFixed(2)}` : "не определён"} (диапазон ${min}–${max})`);
  return r;
}

/** Pad started by preview that may still be playing (Gate off), for the stop button; null when none. */
export const playing = signal<number | null>(null);

export async function preview(pad: number, on: boolean): Promise<void> {
  const d = device;
  if (!d) return;
  try {
    await d.exclusive((x) => (on ? x.previewStart(pad) : x.previewStop(pad)));
    if (on) playing.value = pad;
    else if (pads.value[pad]?.gate) playing.value = null; // Gate on: the release has stopped it
  } catch (e) {
    fail(e, "Прослушивание");
  }
}

/** Stop the pad left playing by preview, then select the app's pad on the unit again. */
export async function stopPlaying(): Promise<void> {
  const pad = playing.value;
  if (pad === null) return;
  playing.value = null;
  if (!(await editPad(pad, "стоп", (d, p1) => d.stopPad(p1, pad)))) return;
  const sel = selectedPad.value;
  if (sel === pad) return;
  await device?.exclusive((x) => x.selectOnDevice(sel))
    .then(() => { if (status.value) status.value = { ...status.value, bank: sel >> 4, pad: sel & 15 }; })
    .catch((e) => log("warn", `Выбор pad'а на SP: ${(e as Error).message}`));
}

/** Free pads from `startPad` to the end of its bank, skipping pads already queued. */
function targetPads(startPad: number, count: number): number[] {
  const out: number[] = [];
  for (let i = startPad; i < ((startPad >> 4) + 1) * 16 && out.length < count; i++)
    if (!pads.value[i]?.size && !reserved.has(i)) out.push(i);
  return out;
}

export function importFiles(files: File[], startPad: number): void {
  const d = device;
  const audio = files.filter((f) => /^audio\//.test(f.type) || /\.(wav|aiff?|flac|mp3|ogg|m4a|aac)$/i.test(f.name));
  if (!audio.length) return void (notice.value = { kind: "error", text: "Перетащите аудиофайлы (WAV, AIFF, FLAC, MP3…)" });
  const block = writeBlockReason.value;
  if (!d || block) return void (notice.value = { kind: "error", text: block ?? "SP не подключён" });
  const bank = startPad >> 4;
  if (project.value?.banks[bank]?.protected) return void (notice.value = { kind: "error", text: `Банк ${padName(bank * 16)[0]} защищён (BANK Protect на SP)` });
  if (pads.value[startPad]?.size) return void (notice.value = { kind: "error", text: `${padName(startPad)} занят. Перетащите на пустой pad — перезапись пока не поддерживается` });
  const targets = targetPads(startPad, audio.length);
  if (targets.length < audio.length)
    notice.value = { kind: "info", text: `В банке хватает места для ${targets.length} из ${audio.length} файлов — остальные пропущены` };
  else notice.value = null;
  const fallback = parseDefaultBpm();
  const newJobs = targets.map((pad, i) => newJob(audio[i], pad, bpmFromFileName(audio[i].name) ?? fallback));
  newJobs.forEach((j) => reserved.add(j.pad));
  jobs.value = [...jobs.value.filter((j) => j.state !== "done"), ...newJobs];
  const p1 = project1.value;
  const uploader = new SampleUploader(d, {
    onJob: (job) => {
      jobs.value = jobs.value.map((j) => (j.id === job.id ? job : j));
      if (job.state === "done" || job.state === "error") reserved.delete(job.pad);
    },
    onPad: (b, a) => {
      setPad(b);
      setWaveform(b.index, b, a.samples, a.channels);
      if (selectedPad.value === b.index) selectPad(b.index);
    },
  }, (level, text) => log(level, text));
  importChain = importChain.then(() => uploader.run(p1, newJobs)).then((ok) => {
    if (ok < newJobs.length) notice.value = { kind: "error", text: `Импортировано ${ok} из ${newJobs.length} — подробности в журнале` };
  });
}

function parseDefaultBpm(): number | null {
  const t = defaultBpm.value.trim().replace(",", ".");
  const x = Math.round(parseFloat(t) * 100);
  return t && x >= 4000 && x <= 20000 ? x : null;
}

export function clearFinishedJobs(): void {
  jobs.value = jobs.value.filter((j) => j.state !== "done" && j.state !== "error");
}
