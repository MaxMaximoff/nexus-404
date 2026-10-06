// `*.SMP` sample files (SparkyMK2 docs/re/02-files.md): 512-byte "RFWV" header, then
// 16-bit big-endian interleaved PCM at 48 kHz. Header bytes 0x20..0x2F hold MD5 of bytes 0x04..0x13.

import { md5 } from "./md5";

export const SMP_HEADER_LEN = 512;

export function smpHeader(pcmBytes: number, channels: number, random = (n: number) => crypto.getRandomValues(new Uint8Array(n))): Uint8Array {
  const h = new Uint8Array(SMP_HEADER_LEN);
  const dv = new DataView(h.buffer);
  h.set([0x52, 0x46, 0x57, 0x56]); // "RFWV"
  dv.setUint32(4, pcmBytes + 504);
  dv.setUint32(8, 48000);
  dv.setUint32(12, channels);
  dv.setUint32(16, 16);
  h.set(md5(h.subarray(4, 20)), 0x20);
  h.set(random(SMP_HEADER_LEN - 0x30), 0x30); // filler: arbitrary bytes (the official app writes rand())
  return h;
}

export interface SmpInfo { pcmBytes: number; rate: number; channels: number; bits: number; digestOk: boolean }

export function parseSmpHeader(h: Uint8Array | null): SmpInfo | null {
  if (!h || h.length < 0x30 || h[0] !== 0x52 || h[1] !== 0x46 || h[2] !== 0x57 || h[3] !== 0x56) return null;
  const dv = new DataView(h.buffer, h.byteOffset);
  const digest = md5(h.subarray(4, 20));
  return {
    pcmBytes: dv.getUint32(4) - 504,
    rate: dv.getUint32(8),
    channels: dv.getUint32(12),
    bits: dv.getUint32(16),
    digestOk: digest.every((b, i) => b === h[0x20 + i]),
  };
}

/** A whole SMP file from interleaved 16-bit PCM. */
export function buildSmp(samples: Int16Array, channels: number): Uint8Array {
  const smp = new Uint8Array(SMP_HEADER_LEN + samples.length * 2);
  smp.set(smpHeader(samples.length * 2, channels));
  const dv = new DataView(smp.buffer);
  for (let i = 0; i < samples.length; i++) dv.setInt16(SMP_HEADER_LEN + i * 2, samples[i], false);
  return smp;
}

/** Interleaved PCM back out of an SMP file. */
export function smpToPcm(smp: Uint8Array): { samples: Int16Array; channels: number } | null {
  const info = parseSmpHeader(smp);
  if (!info) return null;
  const n = Math.min(info.pcmBytes, smp.length - SMP_HEADER_LEN) >> 1;
  const dv = new DataView(smp.buffer, smp.byteOffset + SMP_HEADER_LEN);
  const samples = new Int16Array(n);
  for (let i = 0; i < n; i++) samples[i] = dv.getInt16(i * 2, false);
  return { samples, channels: info.channels };
}
