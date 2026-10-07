// Record from an audio input of the computer (a virtual cable from Ableton, a loopback, a mic)
// straight onto a pad: 48 kHz, no voice processing, a level meter before and while recording.
// A take becomes a 48k/16 WAV and goes through the usual import, which copies it bit-exact.

import { signal } from "@preact/signals";
import { computeEnvelope, computePeaks, encodeWav, floatBlocksToPcm, padName } from "../sp404";
import { importFiles, log, notice, pads, selectedPad, type Waveform } from "./store";

export interface Take {
  samples: Int16Array; channels: 1 | 2; frames: number; name: string; wave: Waveform; peak: number;
  /** A resample: the BPM it played at (put on the new pad) and the pad it came from. */
  bpmX100?: number | null; source?: number;
}

/** Drag data for a take dropped on a pad. */
export const TAKE_DRAG = "application/x-nexus-take";
export const RATE = 48000;
const BLOCK = 2048; // frames per message from the worklet (~43 ms)
const MAX_SECONDS = 600;
const INPUT_KEY = "nexus404.rec.input";

export const recInputs = signal<{ id: string; label: string }[]>([]);
export const recInputId = signal<string>(load(INPUT_KEY) ?? "");
export const recState = signal<"off" | "arming" | "armed" | "recording">("off");
/** Peak per channel, 0..1, falling slowly. */
export const recLevel = signal<number[]>([0, 0]);
export const recClip = signal(false);
export const recSeconds = signal(0);
export const recTake = signal<Take | null>(null);
export const recError = signal<string | null>(null);
export const takePlaying = signal(false);

function load(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

let ctx: AudioContext | null = null;
let stream: MediaStream | null = null;
let tap: AudioWorkletNode | null = null;
let channels: 1 | 2 = 2;
let blocks: Float32Array[][] = [];
let frames = 0;
let player: AudioBufferSourceNode | null = null;

// Collects BLOCK frames per channel and posts them; outputs silence (it is wired to a muted gain
// so the graph keeps pulling it).
const WORKLET = `
class NexusTap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = null; this.n = 0; }
  process(inputs) {
    const inp = inputs[0];
    if (inp && inp.length) {
      if (!this.buf || this.buf.length !== inp.length) { this.buf = inp.map(() => new Float32Array(${BLOCK})); this.n = 0; }
      const len = inp[0].length;
      for (let c = 0; c < inp.length; c++) this.buf[c].set(inp[c], this.n);
      this.n += len;
      if (this.n >= ${BLOCK}) {
        this.port.postMessage(this.buf, this.buf.map((b) => b.buffer));
        this.buf = null;
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor("nexus-tap", NexusTap);
`;

/** The computer's audio inputs; names show only once the page may use an input. */
export async function listInputs(): Promise<void> {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    recInputs.value = all.filter((d) => d.kind === "audioinput").map((d, i) => ({ id: d.deviceId, label: d.label || `Вход ${i + 1}` }));
  } catch {
    recInputs.value = [];
  }
}

/** Open the chosen input and start the meter (asks for permission the first time). */
export async function arm(): Promise<void> {
  disarm();
  recState.value = "arming";
  recError.value = null;
  try {
    const id = recInputId.value;
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: id ? { exact: id } : undefined,
        echoCancellation: false, noiseSuppression: false, autoGainControl: false,
        channelCount: { ideal: 2 }, sampleRate: { ideal: RATE },
      },
    });
    await listInputs();
    const track = stream.getAudioTracks()[0];
    const used = track?.getSettings().deviceId;
    if (used && used !== recInputId.value) recInputId.value = used;
    channels = (track?.getSettings().channelCount ?? 2) === 1 ? 1 : 2;
    ctx = new AudioContext({ sampleRate: RATE }); // the browser resamples the input to 48 kHz if needed
    await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" })));
    const src = ctx.createMediaStreamSource(stream);
    tap = new AudioWorkletNode(ctx, "nexus-tap", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: channels, channelCountMode: "explicit" });
    tap.port.onmessage = (e) => onBlock(e.data as Float32Array[]);
    const mute = ctx.createGain();
    mute.gain.value = 0;
    src.connect(tap).connect(mute).connect(ctx.destination);
    recState.value = "armed";
    log("info", `Вход для записи: ${track?.label || "по умолчанию"}, ${channels === 1 ? "моно" : "стерео"}`);
  } catch (e) {
    const err = e as DOMException;
    recError.value = err.name === "NotAllowedError" ? "Доступ ко входу запрещён — разрешите микрофон для этой страницы (значок слева от адреса)"
      : err.name === "NotFoundError" || err.name === "OverconstrainedError" ? "Вход не найден — выберите другой"
      : err.message;
    disarm();
  }
}

/** Close the input (the browser's microphone indicator goes off). A recording in progress is kept as a take. */
export function disarm(): void {
  if (recState.value === "recording") stop();
  tap?.port.close();
  tap = null;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  void ctx?.close();
  ctx = null;
  recState.value = "off";
  recLevel.value = [0, 0];
}

export function setInput(id: string): void {
  recInputId.value = id;
  try { localStorage.setItem(INPUT_KEY, id); } catch { /* private mode */ }
  if (recState.value === "armed") void arm();
}

function onBlock(b: Float32Array[]): void {
  const prev = recLevel.value;
  const level = b.map((ch, c) => {
    let peak = 0;
    for (let i = 0; i < ch.length; i++) { const v = Math.abs(ch[i]); if (v > peak) peak = v; }
    if (peak >= 0.999) recClip.value = true;
    return Math.max(peak, (prev[c] ?? 0) * 0.85);
  });
  recLevel.value = level;
  if (recState.value !== "recording") return;
  blocks.push(b);
  frames += b[0]?.length ?? 0;
  recSeconds.value = frames / RATE;
  if (frames >= MAX_SECONDS * RATE) {
    stop();
    notice.value = { kind: "info", text: `Запись остановлена на ${MAX_SECONDS / 60} минутах` };
  }
}

export function record(): void {
  if (recState.value !== "armed") return;
  stopTake();
  blocks = [];
  frames = 0;
  recSeconds.value = 0;
  recClip.value = false;
  recState.value = "recording";
}

/** Stop recording; what was recorded becomes the take. */
export function stop(): void {
  if (recState.value !== "recording") return;
  recState.value = "armed";
  const samples = floatBlocksToPcm(blocks, channels);
  blocks = [];
  if (!samples.length) return;
  const d = new Date(), p2 = (x: number) => String(x).padStart(2, "0");
  setTake(samples, channels, `rec_${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`);
  log("info", `Записан дубль ${recTake.value!.name}: ${(recTake.value!.frames / RATE).toFixed(2)} s`);
}

/** Make interleaved 16-bit PCM the take (with its waveform). */
export function setTake(samples: Int16Array, ch: 1 | 2, name: string, extra: Pick<Take, "bpmX100" | "source"> = {}): void {
  stopTake();
  const n = samples.length / ch;
  let peak = 0;
  for (let i = 0; i < samples.length; i++) { const v = Math.abs(samples[i]); if (v > peak) peak = v; }
  recTake.value = {
    samples, channels: ch, frames: n, name, peak: peak / 32768, ...extra,
    wave: { key: `${name}:${n}`, peaks: computePeaks(samples, ch, 640), envelope: computeEnvelope(samples, ch), channels: ch, frames: n, samples },
  };
}

/** Open the input if it is not open yet; true when it is ready to record. */
export async function ensureArmed(): Promise<boolean> {
  if (recState.value === "off") await arm();
  return recState.value === "armed";
}

/**
 * Record while `run` plays something (a resample), in float, one array per channel. The input
 * must be open; the meter and the time show as for a recording.
 */
export async function capture(run: () => Promise<void>): Promise<{ chans: Float32Array[]; channels: 1 | 2 }> {
  if (recState.value !== "armed") throw new Error("вход не открыт");
  blocks = [];
  frames = 0;
  recSeconds.value = 0;
  recClip.value = false;
  recState.value = "recording";
  try {
    await run();
  } finally {
    if (recState.value === "recording") recState.value = "armed";
  }
  const got = blocks;
  blocks = [];
  const n = got.reduce((s, b) => s + (b[0]?.length ?? 0), 0);
  const chans = Array.from({ length: channels }, (_, c) => {
    const out = new Float32Array(n);
    let o = 0;
    for (const b of got) { out.set(b[c] ?? b[0], o); o += b[0]?.length ?? 0; }
    return out;
  });
  return { chans, channels };
}

export function dropTake(): void {
  stopTake();
  recTake.value = null;
}

/** Listen to the take on the computer. */
export async function playTake(): Promise<void> {
  const t = recTake.value;
  if (!t) return;
  if (takePlaying.value) return stopTake();
  const out = ctx ?? new AudioContext({ sampleRate: RATE });
  const buf = out.createBuffer(t.channels, t.frames, RATE);
  for (let c = 0; c < t.channels; c++) {
    const ch = buf.getChannelData(c);
    for (let i = 0; i < t.frames; i++) ch[i] = t.samples[i * t.channels + c] / 32768;
  }
  const s = out.createBufferSource();
  s.buffer = buf;
  s.connect(out.destination);
  s.onended = () => { if (player === s) { player = null; takePlaying.value = false; } };
  player = s;
  takePlaying.value = true;
  s.start();
}

export function stopTake(): void {
  try { player?.stop(); } catch { /* already stopped */ }
  player = null;
  takePlaying.value = false;
}

/** The pad the take button puts it on: the selected pad when empty, else the first empty pad of its bank. */
export function takeTarget(): number | null {
  const sel = selectedPad.value;
  if (!pads.value[sel]?.size) return sel;
  for (let i = sel & ~15; i < (sel & ~15) + 16; i++) if (!pads.value[i]?.size) return i;
  return null;
}

/** Put the take on a pad through the usual import (WAV 48k/16 → SMP, bit-exact). */
export function takeToPad(pad: number): void {
  const t = recTake.value;
  if (!t) return;
  const file = new File([encodeWav(t.samples, t.channels)], `${t.name}.wav`, { type: "audio/wav" });
  log("info", `Дубль ${t.name} → ${padName(pad)}`);
  importFiles([file], pad, t.bpmX100 ?? undefined);
}
