// Host-side audio: decode any browser-supported file into 48 kHz 16-bit PCM (1 or 2 channels),
// peaks for drawing, and a BPM hint from the file name.

export interface DecodedAudio {
  samples: Int16Array; // interleaved
  channels: 1 | 2;
  frames: number;
  note: string; // how it was decoded, for the log
}

interface WavInfo { format: number; channels: number; rate: number; bits: number; offset: number; length: number }

function parseWav(buf: ArrayBuffer): WavInfo | null {
  const dv = new DataView(buf);
  const str = (o: number, n: number) => String.fromCharCode(...new Uint8Array(buf, o, n));
  if (buf.byteLength < 12 || str(0, 4) !== "RIFF" || str(8, 4) !== "WAVE") return null;
  let off = 12;
  let fmt: Omit<WavInfo, "offset" | "length"> | null = null;
  let data: { offset: number; length: number } | null = null;
  while (off + 8 <= buf.byteLength) {
    const id = str(off, 4);
    const size = dv.getUint32(off + 4, true);
    const body = off + 8;
    if (id === "fmt ") {
      fmt = { format: dv.getUint16(body, true), channels: dv.getUint16(body + 2, true), rate: dv.getUint32(body + 4, true), bits: dv.getUint16(body + 14, true) };
      if (fmt.format === 0xfffe && size >= 26) fmt.format = dv.getUint16(body + 24, true);
    } else if (id === "data") data = { offset: body, length: Math.min(size, buf.byteLength - body) };
    off = body + size + (size & 1);
  }
  return fmt && data ? { ...fmt, ...data } : null;
}

/** 16-bit 48 kHz PCM WAVs are copied bit-exact (as the official app does); anything else goes through decodeAudioData. */
export async function decodeAudio(file: Blob & { name?: string }): Promise<DecodedAudio> {
  const buf = await file.arrayBuffer();
  const wav = parseWav(buf);
  if (wav && wav.format === 1 && wav.bits === 16 && wav.rate === 48000 && (wav.channels === 1 || wav.channels === 2)) {
    const n = wav.length >> 1;
    const samples = new Int16Array(n);
    const dv = new DataView(buf, wav.offset, n * 2);
    for (let i = 0; i < n; i++) samples[i] = dv.getInt16(i * 2, true);
    return { samples, channels: wav.channels, frames: n / wav.channels, note: "WAV 48k/16, без перекодирования" };
  }
  const ctx = new OfflineAudioContext(1, 1, 48000);
  let audio: AudioBuffer;
  try {
    audio = await ctx.decodeAudioData(buf.slice(0)); // resampled to the context's 48 kHz
  } catch {
    throw new Error("браузер не смог декодировать файл (поддерживаются WAV, MP3, FLAC, OGG, AAC/M4A)");
  }
  const channels = (Math.min(2, audio.numberOfChannels) as 1 | 2);
  const frames = audio.length;
  const data = Array.from({ length: channels }, (_, c) => audio.getChannelData(c));
  const samples = new Int16Array(frames * channels);
  for (let i = 0; i < frames; i++)
    for (let c = 0; c < channels; c++) {
      const x = Math.max(-1, Math.min(1, data[c][i]));
      samples[i * channels + c] = Math.round(x < 0 ? x * 32768 : x * 32767);
    }
  const src = wav ? `WAV ${wav.rate} Hz/${wav.bits} bit/${wav.channels} ch` : file.type || "audio";
  const extra = audio.numberOfChannels > 2 ? `, взяты 2 из ${audio.numberOfChannels} каналов` : "";
  return { samples, channels, frames, note: `${src} → 48k/16/${channels} ch${extra}` };
}

/** Per channel, `points` [min, max] pairs normalised to -1..1. */
export function computePeaks(samples: Int16Array, channels: number, points: number): Float32Array[] {
  const frames = Math.floor(samples.length / channels);
  const n = Math.max(1, Math.min(points, frames));
  return Array.from({ length: channels }, (_, ch) => {
    const out = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      const from = Math.floor((i * frames) / n);
      const to = Math.max(from + 1, Math.floor(((i + 1) * frames) / n));
      let lo = 0, hi = 0;
      for (let f = from; f < to && f < frames; f++) {
        const v = samples[f * channels + ch];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      out[i * 2] = lo / 32768;
      out[i * 2 + 1] = hi / 32767;
    }
    return out;
  });
}

/** Frames per envelope block: 32 frames = 0.67 ms at 48 kHz. */
export const ENVELOPE_BLOCK = 32;

/** Loudest absolute sample (any channel) per block of `block` frames; enough to find silence later at any threshold. */
export function computeEnvelope(samples: Int16Array, channels: number, block = ENVELOPE_BLOCK): Uint16Array {
  const frames = Math.floor(samples.length / channels);
  const out = new Uint16Array(Math.ceil(frames / block));
  for (let i = 0; i < out.length; i++) {
    let m = 0;
    for (let s = i * block * channels, e = Math.min(frames, (i + 1) * block) * channels; s < e; s++) {
      const v = samples[s] < 0 ? -samples[s] : samples[s];
      if (v > m) m = v;
    }
    out[i] = m;
  }
  return out;
}

/**
 * Where the sound starts and ends (frames, end exclusive): the first and last block reaching
 * `thresholdDb` dBFS. Rounded outwards to whole blocks, so no sound is ever cut. `null` when
 * the whole sample is quieter than the threshold.
 */
export function findSound(envelope: Uint16Array, frames: number, thresholdDb: number, block = ENVELOPE_BLOCK): { start: number; end: number } | null {
  const level = 32768 * 10 ** (thresholdDb / 20);
  let first = -1, last = -1;
  for (let i = 0; i < envelope.length; i++) if (envelope[i] >= level) { if (first < 0) first = i; last = i; }
  return first < 0 ? null : { start: first * block, end: Math.min(frames, (last + 1) * block) };
}

/** "loop_96bpm.wav", "Drums 120 BPM", "beat-93.5bpm" → BPM × 100; null when absent or out of 40–200. */
export function bpmFromFileName(name: string): number | null {
  const m = /(\d{2,3}(?:[.,]\d{1,2})?)\s*[-_ ]?\s*bpm/i.exec(name);
  if (!m) return null;
  const x100 = Math.round(parseFloat(m[1].replace(",", ".")) * 100);
  return x100 >= 4000 && x100 <= 20000 ? x100 : null;
}

/** "120", "93.25", "93,5" → BPM × 100, or an error message. */
export function parseBpmInput(s: string): { x100: number } | { error: string } | null {
  const t = s.trim().replace(",", ".");
  if (!t) return null;
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(t)) return { error: "число вида 120 или 93.25" };
  const x100 = Math.round(parseFloat(t) * 100);
  if (x100 < 4000 || x100 > 20000) return { error: "от 40 до 200" };
  return { x100 };
}

export const formatBpm = (x100: number): string => (x100 / 100).toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
