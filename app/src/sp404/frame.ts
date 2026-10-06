// Message framing on the serial link (SparkyMK2 docs/re/01-transport.md).
// Short: 12 bytes, up to 7 payload bytes, length in byte 11. Long: 16-byte header + payload.

export const CH_CONTROL = 0x05;
export const CH_FILE = 0x06;

const KIND_SHORT = 0x12;
const KIND_LONG = 0x13;
const ADDR_HOST = 0x60;
const ADDR_DEVICE = 0xe0;
const MAX_PAYLOAD = 1 << 24;

export interface Message {
  short: boolean;
  channel: number;
  payload: Uint8Array;
}

export function encodeShort(channel: number, payload: ArrayLike<number>): Uint8Array {
  if (payload.length > 7) throw new Error("short payload > 7 bytes");
  const b = new Uint8Array(12);
  b.set([KIND_SHORT, ADDR_HOST, ADDR_DEVICE, channel]);
  b.set(payload, 4);
  b[11] = payload.length; // the device ignores a short message whose length byte is 0
  return b;
}

export function encodeLong(channel: number, payload: ArrayLike<number>): Uint8Array {
  const b = new Uint8Array(16 + payload.length);
  b.set([KIND_LONG, ADDR_HOST, ADDR_DEVICE, channel]);
  new DataView(b.buffer).setUint32(12, payload.length, true);
  b.set(payload, 16);
  return b;
}

/** Incremental decoder for the device → host byte stream. */
export class FrameDecoder {
  private buf = new Uint8Array(0);

  push(chunk: Uint8Array): void {
    const n = new Uint8Array(this.buf.length + chunk.length);
    n.set(this.buf);
    n.set(chunk, this.buf.length);
    this.buf = n;
  }

  *messages(): Generator<Message> {
    for (;;) {
      const b = this.buf;
      if (b.length === 0) return;
      let total: number;
      if (b[0] === KIND_SHORT) total = 12;
      else if (b[0] === KIND_LONG) {
        if (b.length < 16) return;
        const len = new DataView(b.buffer, b.byteOffset).getUint32(12, true);
        if (len > MAX_PAYLOAD) { this.buf = b.subarray(1); continue; }
        total = 16 + len;
      } else { this.buf = b.subarray(1); continue; }
      if (b.length < total) return;
      const f = b.slice(0, total);
      this.buf = b.subarray(total);
      const short = f[0] === KIND_SHORT;
      yield { short, channel: f[3], payload: short ? f.slice(4, 4 + Math.min(f[11], 7)) : f.slice(16) };
    }
  }
}

export const hex = (a: Uint8Array, max = 64): string => {
  const s = Array.from(a.subarray(0, max), (b) => b.toString(16).padStart(2, "0")).join(" ");
  return a.length > max ? `${s} … (+${a.length - max} B)` : s;
};
