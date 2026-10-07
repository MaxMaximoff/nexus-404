// Channel 6: POSIX-like remote file API (SparkyMK2 docs/re/01-transport.md).
// Payload: F0 41 7A <cmd> … F7. Integers are 35-bit, 5 septets, big-endian.

export const FLAG_LAST = 0x40;
const FLAG_MULTI = 0x20;
export const CHUNK = 0x5000;
export const WRITE_BATCH = 15;
export const BULK_READ = 0x20000;

export const Op = {
  Open: 0x00, Close: 0x03, Read: 0x04, Write: 0x06, Seek: 0x07, Mkdir: 0x09, Unlink: 0x0a, Rmdir: 0x0b, Rename: 0x17,
  OpenDir: 0x0c, CloseDir: 0x0d, ReadDir: 0x0e, Stat: 0x12, FStat: 0x13, FreeKb: 0x18,
} as const;

export const O_RDONLY = 0;
export const O_CREAT_TRUNC_RDWR = 0x602;
export const ROOT = "/SP404REMOTE//";

export function septEnc(v: number, flags = 0): number[] {
  const raw = BigInt.asUintN(35, BigInt(v));
  const out: number[] = [];
  for (let i = 0; i < 5; i++) out.push(Number((raw >> BigInt(7 * (4 - i))) & 0x7fn));
  out[0] |= flags;
  return out;
}

export interface Septets { i32: number; u32: number; high: number }

export function septDec(bytes: Uint8Array, at: number): Septets {
  let raw = 0n;
  for (let i = 0; i < 5; i++) {
    const b = bytes[at + i];
    if (b === undefined || b & 0x80) throw new Error("bad septet");
    raw = (raw << 7n) | BigInt(b);
  }
  return { i32: Number(BigInt.asIntN(32, raw)), u32: Number(BigInt.asUintN(32, raw)), high: Number(raw >> 32n) };
}

/** Paths on the SD card are written `sd:/IMPORT/…`; on the wire the card is the bare `/` volume. */
export const CARD = "sd:";

/** Device path: plain paths address the device's own storage, `sd:/…` the SD card. */
export const remotePath = (p: string): string =>
  p.startsWith(ROOT) ? p
    : p.startsWith(CARD) ? `/${p.slice(CARD.length).replace(/^[/\\]+/, "")}`
    : `${ROOT}/${p.replace(/^[/\\]+/, "")}`;

/**
 * The only place the client writes on the card: a file inside IMPORT/ (or a folder in it), for
 * the SP's own IMPORT browser. Wire path, no "." / ".." segments, no empty names.
 */
export function isCardImportFile(wire: string): boolean {
  const parts = wire.split("/");
  return parts[0] === "" && parts[1]?.toUpperCase() === "IMPORT" && parts.length >= 3 && parts.slice(2).every((s) => s !== "" && s !== "." && s !== "..");
}

/** `ROLAND/SP-404MKII/PROJECT_NN/SMPL/BANKb-pp.SMP` (project 1-based, pad 0..159). */
export const samplePath = (project1: number, pad: number, ext = "SMP"): string =>
  `ROLAND/SP-404MKII/PROJECT_${String(project1).padStart(2, "0")}/SMPL/BANK${(pad >> 4) + 1}-${String((pad & 15) + 1).padStart(2, "0")}.${ext}`;

const enc = new TextEncoder();
const request = (op: number, first: number[], second: number[], tail: ArrayLike<number>): Uint8Array => {
  const head = [0xf0, 0x41, 0x7a, 0x03, op, ...first, ...second];
  const out = new Uint8Array(head.length + tail.length + 1);
  out.set(head);
  out.set(tail, head.length);
  out[out.length - 1] = 0xf7;
  return out;
};
const pathReq = (op: number, first: number, path: string): Uint8Array => {
  const bytes = [...enc.encode(remotePath(path)), 0];
  return request(op, septEnc(first), septEnc(bytes.length), bytes);
};
const handleReq = (op: number, handle: number, arg: number[]): Uint8Array => request(op, septEnc(handle), arg, [0]);

export const FileReq = {
  open: (path: string, flags: number) => pathReq(Op.Open, flags, path),
  close: (h: number) => handleReq(Op.Close, h, septEnc(0)),
  read: (h: number, n: number) => handleReq(Op.Read, h, septEnc(n, n > CHUNK ? FLAG_MULTI : 0)),
  write: (h: number, data: Uint8Array, last: boolean) => request(Op.Write, septEnc(h), septEnc(data.length, last ? FLAG_LAST : 0), data),
  seek: (h: number, offset: number) => handleReq(Op.Seek, h, septEnc(offset)),
  unlink: (path: string) => pathReq(Op.Unlink, 0, path),
  /** Remove an empty directory (one that still holds entries is refused). */
  rmdir: (path: string) => pathReq(Op.Rmdir, 0, path),
  /** Create a directory; an existing name is refused (EEXIST). */
  mkdir: (path: string) => pathReq(Op.Mkdir, 0, path),
  /**
   * Rename or move (also between directories): two wire paths, each NUL-padded into a 200-byte
   * slot. A path that does not fit is refused here rather than cut short (a cut path could
   * name something else).
   */
  rename: (from: string, to: string) => {
    const block = new Uint8Array(2 * RENAME_SLOT);
    for (const [i, p] of [from, to].entries()) {
      const bytes = enc.encode(remotePath(p));
      if (bytes.length >= RENAME_SLOT) throw new Error(`путь длиннее ${RENAME_SLOT - 1} байт: ${remotePath(p)}`);
      block.set(bytes, i * RENAME_SLOT);
    }
    return request(Op.Rename, septEnc(0), septEnc(block.length), block);
  },
  stat: (path: string) => pathReq(Op.Stat, 0, path),
  opendir: (path: string) => pathReq(Op.OpenDir, 0, path),
  readdir: (h: number) => handleReq(Op.ReadDir, h, septEnc(0)),
  closedir: (h: number) => handleReq(Op.CloseDir, h, septEnc(0)),
  freeKb: (path = ROOT) => pathReq(Op.FreeKb, 0, path),
};

export type FileReply =
  | { kind: "status"; result: number; extra: number }
  | { kind: "data"; handle: number; last: boolean; data: Uint8Array };

export function parseFileReply(p: Uint8Array): FileReply {
  if (p.length < 5 || p[0] !== 0xf0 || p[1] !== 0x41 || p[2] !== 0x7a || p[p.length - 1] !== 0xf7) throw new Error("not a file API payload");
  const body = p.subarray(3, p.length - 1);
  const a = septDec(body, 1);
  const b = septDec(body, 6);
  if (body[0] === 0x7a) return { kind: "status", result: a.i32, extra: b.i32 };
  if (body[0] === 0x02) return { kind: "data", handle: a.i32, last: (b.high & 0b100) !== 0, data: body.slice(11, 11 + b.u32) };
  throw new Error(`unexpected file reply 0x${body[0].toString(16)}`);
}

const RENAME_SLOT = 200;

/** The parts of a host → device file request a guard needs (`to`: the second path of a rename). */
export function describeFileRequest(p: Uint8Array): { op: number; first: Septets; path: string | null; to: string | null } {
  const op = p[4];
  const first = septDec(p, 5);
  const pathOps: number[] = [Op.Open, Op.Unlink, Op.Rmdir, Op.Mkdir, Op.OpenDir, Op.Stat, Op.FreeKb];
  if (op === Op.Rename) {
    const slot = (i: number) => { const s = p.subarray(15 + i * RENAME_SLOT, 15 + (i + 1) * RENAME_SLOT); const z = s.indexOf(0); return new TextDecoder().decode(z < 0 ? s : s.subarray(0, z)); };
    return { op, first, path: p.length === 15 + 2 * RENAME_SLOT + 1 ? slot(0) : null, to: p.length === 15 + 2 * RENAME_SLOT + 1 ? slot(1) : null };
  }
  const path = pathOps.includes(op) ? new TextDecoder().decode(p.subarray(15, p.length - 2)) : null;
  return { op, first, path, to: null };
}
