// SP-404MKII over Web Serial: framing, file API, control channel, SMP building.
// Protocol: SparkyMK2/docs/re (01-transport.md, 02-files.md, 03-parameters.md).

export const VID = 0x0582;
export const PID_SERIAL = 0x02E7;
const BAUD = 921600;
const SETTLE_MS = 350;

const KIND_SHORT = 0x12, KIND_LONG = 0x13, ADDR_HOST = 0x60, ADDR_DEVICE = 0xE0;
export const CH_CONTROL = 0x05, CH_FILE = 0x06;
export const BANKS = "ABCDEFGHIJ";

export const hex = (a, max = 64) => {
  const s = Array.from(a.slice(0, max), b => b.toString(16).padStart(2, "0")).join(" ");
  return a.length > max ? `${s} … (+${a.length - max} B)` : s;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
export const padName = i => `${BANKS[i >> 4]}${(i & 15) + 1}`;
export function parsePadName(s) {
  const m = /^([A-Ja-j])(\d{1,2})$/.exec(s.trim());
  if (!m || +m[2] < 1 || +m[2] > 16) return null;
  return (m[1].toUpperCase().charCodeAt(0) - 65) * 16 + (+m[2] - 1);
}

// ---------------------------------------------------------------- framing
export const Frame = {
  short(channel, payload) {
    if (payload.length > 7) throw new Error("short payload > 7 bytes");
    const b = new Uint8Array(12);
    b.set([KIND_SHORT, ADDR_HOST, ADDR_DEVICE, channel]);
    b.set(payload, 4);
    b[11] = payload.length;
    return b;
  },
  long(channel, payload) {
    const b = new Uint8Array(16 + payload.length);
    b.set([KIND_LONG, ADDR_HOST, ADDR_DEVICE, channel]);
    new DataView(b.buffer).setUint32(12, payload.length, true);
    b.set(payload, 16);
    return b;
  },
};

export class FrameDecoder {
  constructor() { this.buf = new Uint8Array(0); }
  push(chunk) {
    const n = new Uint8Array(this.buf.length + chunk.length);
    n.set(this.buf); n.set(chunk, this.buf.length); this.buf = n;
  }
  *messages() {
    for (;;) {
      const b = this.buf;
      if (b.length === 0) return;
      let total;
      if (b[0] === KIND_SHORT) total = 12;
      else if (b[0] === KIND_LONG) {
        if (b.length < 16) return;
        const len = new DataView(b.buffer, b.byteOffset).getUint32(12, true);
        if (len > (1 << 24)) { this.buf = b.subarray(1); continue; }
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

// ---------------------------------------------------------------- septets
const FLAG_LAST = 0x40, FLAG_MULTI = 0x20, CHUNK = 0x5000, WRITE_BATCH = 15;
export function septEnc(v, flags = 0) {
  const raw = BigInt.asUintN(35, BigInt(v));
  const out = [];
  for (let i = 0; i < 5; i++) out.push(Number((raw >> BigInt(7 * (4 - i))) & 0x7Fn));
  out[0] |= flags;
  return out;
}
export function septDec(bytes, at) {
  let raw = 0n;
  for (let i = 0; i < 5; i++) {
    const b = bytes[at + i];
    if (b === undefined || b & 0x80) throw new Error("bad septet");
    raw = (raw << 7n) | BigInt(b);
  }
  return { i32: Number(BigInt.asIntN(32, raw)), u32: Number(BigInt.asUintN(32, raw)), high: Number(raw >> 32n) };
}

// ---------------------------------------------------------------- file API (channel 6)
export const Op = { Open: 0x00, Close: 0x03, Read: 0x04, Write: 0x06, Seek: 0x07, Unlink: 0x0A, OpenDir: 0x0C, CloseDir: 0x0D, ReadDir: 0x0E, Stat: 0x12, FStat: 0x13, FreeKb: 0x18 };
export const O_RDONLY = 0, O_CREAT_TRUNC_RDWR = 0x602;
const ROOT = "/SP404REMOTE//";
export const remotePath = p => p.startsWith(ROOT) ? p : `${ROOT}/${p.replace(/^[\/\\]+/, "")}`;
export const samplePath = (project1, pad, ext = "SMP") =>
  `ROLAND/SP-404MKII/PROJECT_${String(project1).padStart(2, "0")}/SMPL/BANK${(pad >> 4) + 1}-${String((pad & 15) + 1).padStart(2, "0")}.${ext}`;

const enc = new TextEncoder();
export const FileApi = {
  request(op, first, second, tail) { return Uint8Array.from([0xF0, 0x41, 0x7A, 0x03, op, ...first, ...second, ...tail, 0xF7]); },
  pathReq(op, first, path) {
    const bytes = [...enc.encode(remotePath(path)), 0];
    return this.request(op, septEnc(first), septEnc(bytes.length), bytes);
  },
  handleReq(op, handle, arg) { return this.request(op, septEnc(handle), arg, [0]); },
  open: (path, flags) => FileApi.pathReq(Op.Open, flags, path),
  close: h => FileApi.handleReq(Op.Close, h, septEnc(0)),
  read: (h, n) => FileApi.handleReq(Op.Read, h, septEnc(n, n > CHUNK ? FLAG_MULTI : 0)),
  write(h, data, last) {
    const head = [0xF0, 0x41, 0x7A, 0x03, Op.Write, ...septEnc(h), ...septEnc(data.length, last ? FLAG_LAST : 0)];
    const out = new Uint8Array(head.length + data.length + 1);
    out.set(head); out.set(data, head.length); out[out.length - 1] = 0xF7;
    return out;
  },
  seek: (h, offset) => FileApi.handleReq(Op.Seek, h, septEnc(offset)),
  unlink: path => FileApi.pathReq(Op.Unlink, 0, path),
  stat: path => FileApi.pathReq(Op.Stat, 0, path),
  opendir: path => FileApi.pathReq(Op.OpenDir, 0, path),
  readdir: h => FileApi.handleReq(Op.ReadDir, h, septEnc(0)),
  closedir: h => FileApi.handleReq(Op.CloseDir, h, septEnc(0)),
  freeKb: path => FileApi.pathReq(Op.FreeKb, 0, path),
  parseReply(p) {
    if (p.length < 5 || p[0] !== 0xF0 || p[1] !== 0x41 || p[2] !== 0x7A || p[p.length - 1] !== 0xF7) throw new Error("not a file API payload");
    const body = p.subarray(3, p.length - 1);
    const a = septDec(body, 1), b = septDec(body, 6);
    if (body[0] === 0x7A) return { kind: "status", result: a.i32, extra: b.i32 };
    if (body[0] === 0x02) return { kind: "data", handle: a.i32, last: (b.high & 0b100) !== 0, data: body.slice(11, 11 + b.u32) };
    throw new Error("unexpected file reply 0x" + body[0].toString(16));
  },
};
/** The parts of a file request a guard needs: op, first/second integers, path (for path ops). */
export function describeFileRequest(p) {
  const op = p[4], first = septDec(p, 5), second = septDec(p, 10);
  const pathOps = [Op.Open, Op.Unlink, Op.OpenDir, Op.Stat, Op.FreeKb];
  const path = pathOps.includes(op) ? new TextDecoder().decode(p.subarray(15, p.length - 2)) : null;
  return { op, first, second, path };
}

// ---------------------------------------------------------------- pad block / settings
const PAD_NAME_AT = 175, PAD_NAME_LEN = 24, PAD_WRITE_LEN = 199;
export function parsePadBlock(p) {
  const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
  const f = n => dv.getUint32(3 + n * 4, true);
  const nameBytes = p.subarray(PAD_NAME_AT, PAD_NAME_AT + PAD_NAME_LEN);
  const name = new TextDecoder("latin1").decode(nameBytes.subarray(0, nameBytes.indexOf(0) < 0 ? 24 : nameBytes.indexOf(0))).trimEnd();
  return {
    index: dv.getUint16(1, true), size: f(0), startByte: f(1), endByte: f(2),
    level: f(3), gate: f(4), loop: f(5) !== 0, bpmSync: f(8), bpmX100: f(9), flags: f(10),
    oneShot: (f(10) & 32) !== 0, name, raw: p.slice(),
  };
}
/** The block the host writes back after an import (as PadBlock::assign_sample + write_payload). */
export function assignSampleBlock(block, fileSize, name) {
  const p = block.raw.slice(0, PAD_WRITE_LEN);
  const dv = new DataView(p.buffer);
  const set = (n, v) => dv.setUint32(3 + n * 4, v, true);
  set(0, fileSize); set(1, 512); set(2, fileSize); set(11, 512);
  p.fill(0, PAD_NAME_AT, PAD_NAME_AT + PAD_NAME_LEN);
  p.set(sanitizeName(name), PAD_NAME_AT);
  return p;
}
export const sanitizeName = name => Uint8Array.from([...name].map(c => c.charCodeAt(0)).filter(c => c >= 0x20 && c < 0x7F).slice(0, PAD_NAME_LEN - 1));

export function parseProjectSettings(p) {
  const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
  const w = n => dv.getUint32(3 + n * 4, true);
  const banks = [];
  for (let b = 0; b < 10; b++) {
    const word = w(12 + b), vol = (w(23 + (b >> 1)) >>> ((b & 1) ? 16 : 0)) & 0xFFFF;
    banks.push({ letter: BANKS[b], protected: !!(word & 1), tempoX100: (word >>> 1) & 0xFFFF, volume: 127 - vol });
  }
  return {
    project: p[1], projectTempoX100: w(0) & 0xFFFF, useProjectTempo: !!((w(0) >>> 16) & 1), banks,
    name: new TextDecoder("latin1").decode(p.subarray(115, 147)).replace(/[\0 ]+$/, ""),
  };
}

// ---------------------------------------------------------------- guards
const READ_FILE_OPS = new Set([Op.Close, Op.Read, Op.OpenDir, Op.CloseDir, Op.ReadDir, Op.Stat, Op.FStat, Op.FreeKb]);
const READ_CONTROL = new Set([0xFE, 0xFD, 0x9E, 0x3A]);

export function readOnlyGuard(channel, payload) {
  if (channel === CH_CONTROL && READ_CONTROL.has(payload[0])) return;
  if (channel === CH_FILE && payload[3] === 0x03) {
    const r = describeFileRequest(payload);
    if (READ_FILE_OPS.has(r.op) || (r.op === Op.Open && r.first.i32 === O_RDONLY)) return;
  }
  throw new Error(`guard: blocked ch${channel} ${hex(payload, 8)}`);
}

/**
 * Sandbox guard: read-only traffic anywhere, plus exactly the import / set-BPM traffic for
 * `state.project` (1-based) while it is the current project. `state.importPad` is the pad being
 * imported right now (null otherwise); `state.writableHandles` holds handles opened for that import.
 */
export function sandboxGuard(state) {
  return (channel, payload) => {
    try { readOnlyGuard(channel, payload); return; } catch {}
    if (!state.project || state.currentProject !== state.project) throw new Error(`guard: writes need sandbox project ${state.project} to be current (current: ${state.currentProject})`);
    const pad = payload.length >= 3 ? payload[1] | (payload[2] << 8) : -1;
    const importing = state.importPad !== null && pad === state.importPad;
    if (channel === CH_CONTROL) {
      const c = payload[0];
      if (c === 0xFB && payload[1] === 0xA0 && payload[2] === 0x00) return;              // import begin
      if (c === 0xFC && payload[1] === 0x00 && payload[2] === 0x00) return;              // import end
      if (c === 0x9D && payload.length === 1) return;                                    // stop
      if (c === 0x91 && importing && payload[3] === 0x01 && payload[4] === 0x00) return; // release slot (not delete)
      if (c === 0x1E && importing && payload.length === PAD_WRITE_LEN) return;           // pad block write
      if (c === 0x9F && importing && payload.length === 3) return;                       // commit
      if (c === 0x01 && payload[1] === 0x6F && payload[2] === 0x00 && payload.length === 9) {
        const target = payload[3] | (payload[4] << 8);
        if (target < 160) return;                                                        // set BPM on a pad
      }
    }
    if (channel === CH_FILE && payload[3] === 0x03 && state.importPad !== null) {
      const r = describeFileRequest(payload);
      const allowed = ["SMP", "TMP"].map(e => remotePath(samplePath(state.project, state.importPad, e)));
      if ((r.op === Op.Open && r.first.i32 === O_CREAT_TRUNC_RDWR && r.path === allowed[0])) return;
      if (r.op === Op.Unlink && allowed.includes(r.path)) return;
      if ((r.op === Op.Write || r.op === Op.Seek) && state.writableHandles.has(r.first.i32)) return;
    }
    throw new Error(`guard: blocked ch${channel} ${hex(payload, 12)}`);
  };
}

// ---------------------------------------------------------------- transport
export class WebSerialTransport {
  constructor(port, log) { this.port = port; this.log = log; this.onBytes = () => {}; this.onClose = () => {}; }
  async open() {
    await this.port.open({ baudRate: BAUD, dataBits: 8, stopBits: 1, parity: "none", flowControl: "none", bufferSize: 1 << 20 });
    await this.port.setSignals({ dataTerminalReady: true, requestToSend: true });
    await sleep(SETTLE_MS);
    this.writer = this.port.writable.getWriter();
    this.loopDone = this.readLoop();
  }
  async readLoop() {
    try {
      while (this.port.readable) {
        this.reader = this.port.readable.getReader();
        try {
          for (;;) {
            const { value, done } = await this.reader.read();
            if (done) break;
            if (value?.length) this.onBytes(value);
          }
        } finally { this.reader.releaseLock(); this.reader = null; }
        if (this.closing) break;
      }
    } catch (e) { this.log(`read error: ${e.message}`, "warn"); }
    if (!this.closing) this.onClose();
  }
  async write(bytes) { await this.writer.write(bytes); }
  async close() {
    this.closing = true;
    try { await this.reader?.cancel(); } catch {}
    try { await this.loopDone; } catch {}
    try { this.writer?.releaseLock(); } catch {}
    try { await this.port.setSignals({ dataTerminalReady: false, requestToSend: false }); } catch {}
    try { await this.port.close(); } catch {}
  }
}

// ---------------------------------------------------------------- device
export class SP404Device {
  constructor(transport, log, guard = readOnlyGuard) {
    this.t = transport; this.log = log; this.guard = guard;
    this.decoder = new FrameDecoder();
    this.inbox = []; this.waiter = null; this.queue = Promise.resolve();
    this.writableHandles = new Set();
    this.quiet = false;                 // suppress per-frame logging during bulk writes
    transport.onBytes = b => this.onBytes(b);
  }
  onBytes(bytes) {
    this.decoder.push(bytes);
    for (const m of this.decoder.messages()) {
      if (!this.quiet) this.log(`< ch${m.channel.toString(16).padStart(2, "0")} ${m.short ? "S" : "L"} ${hex(m.payload)}`, "rx");
      if (m.channel === CH_CONTROL && m.payload[0] === 0x32 && m.payload.length >= 5)
        this.log(`device error notification: ${new DataView(m.payload.buffer, m.payload.byteOffset).getInt32(1, true)}`, "warn");
      if (this.waiter && this.waiter.pred(m)) { const w = this.waiter; this.waiter = null; clearTimeout(w.timer); w.resolve(m); }
      else { this.inbox.push(m); if (this.inbox.length > 256) this.inbox.shift(); }
    }
  }
  waitFor(pred, ms, what) {
    const i = this.inbox.findIndex(pred);
    if (i >= 0) return Promise.resolve(this.inbox.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiter = null; reject(new Error(`timeout: ${what}`)); }, ms);
      this.waiter = { pred, resolve, reject, timer };
    });
  }
  async send(channel, payload, short) {
    this.guard(channel, payload);
    if (!this.quiet) this.log(`> ch${channel.toString(16).padStart(2, "0")} ${short ? "S" : "L"} ${hex(payload)}`, "tx");
    await this.t.write(short ? Frame.short(channel, payload) : Frame.long(channel, payload));
  }
  exclusive(fn) { const r = this.queue.then(() => fn(this)); this.queue = r.catch(() => {}); return r; }
  async transact(channel, payload, short, pred, what, ms = 5000) {
    this.inbox.length = 0;
    const reply = this.waitFor(pred, ms, what);
    await this.send(channel, payload, short);
    return reply;
  }
  ctl(payload, pred, what, ms) { return this.transact(CH_CONTROL, payload, payload.length <= 7, m => m.channel === CH_CONTROL && pred(m.payload), what, ms); }
  /** Short command whose reply is `cmd status`; fails unless status is 0. */
  async command(payload, expect, what) {
    const p = (await this.ctl(payload, p => p[0] === expect, what)).payload;
    if (p.length > 1 && p[1] !== 0) throw new Error(`${what}: device status ${p[1]}`);
  }

  // control, read
  async status() {
    const p = (await this.ctl([0xFE, 0x66, 0x00], p => p[0] === 0x7E, "status")).payload;
    return { project: p[1], bank: p[3], pad: p[5], workingMode: p[12], raw: p };
  }
  async projectSettings(project) {
    const m = await this.ctl([0xFD, project, 0x00], p => p[0] === 0x7D && p[1] === project, "project settings");
    const settings = parseProjectSettings(m.payload), names = [];
    const deadline = Date.now() + 1500;
    while (names.filter(Boolean).length < 16 && Date.now() < deadline) {
      try {
        const n = await this.waitFor(m => m.channel === CH_CONTROL && m.payload[0] === 0x35, Math.max(1, deadline - Date.now()), "project names");
        names[n.payload[1]] = new TextDecoder("latin1").decode(n.payload.subarray(2)).replace(/[\0 ]+$/, "").trim() || " ";
      } catch { break; }
    }
    return { ...settings, names };
  }
  async padBlock(index) {
    const lo = index & 0xFF, hi = index >> 8;
    const m = await this.transact(CH_CONTROL, [0x9E, lo, hi], true,
      m => m.channel === CH_CONTROL && !m.short && m.payload[0] === 0x1E && m.payload[1] === lo && m.payload[2] === hi, `pad block ${padName(index)}`);
    return parsePadBlock(m.payload);
  }
  async mkiiExit() { await this.send(CH_CONTROL, [0x3A, 0x00, 0x00, 0x00], true); }

  // control, write
  async setParam(id, target, value) {
    const p = new Uint8Array(9);
    const dv = new DataView(p.buffer);
    p[0] = 0x01; p[1] = id; p[2] = 0; dv.setUint16(3, target, true); dv.setInt32(5, value, true);
    await this.transact(CH_CONTROL, p, false, m => m.channel === CH_CONTROL && m.payload[0] === 0x01 && m.payload[1] === id &&
      m.payload[3] === p[3] && m.payload[4] === p[4], `set param 0x${id.toString(16)}`);
  }
  setBpm(pad, bpmX100) {
    if (!(bpmX100 >= 4000 && bpmX100 <= 20000)) throw new Error("BPM must be 40.00–200.00");
    return this.setParam(0x6F, pad, bpmX100);
  }

  // file API
  async fileCall(payload, what, ms = 5000) {
    const m = await this.transact(CH_FILE, payload, false, m => m.channel === CH_FILE && !m.short, what, ms);
    return FileApi.parseReply(m.payload);
  }
  async statusCall(payload, what, ms) {
    const r = await this.fileCall(payload, what, ms);
    if (r.kind !== "status") throw new Error(`${what}: unexpected data`);
    if (r.result === -1) throw new Error(`${what}: refused (errno ${r.extra})`);
    return r.result;
  }
  async stat(path) {
    const r = await this.fileCall(FileApi.stat(path), `stat ${path}`);
    if (r.kind === "status") return null;
    const dv = new DataView(r.data.buffer, r.data.byteOffset);
    return { mode: dv.getUint32(0, true), size: dv.getUint32(4, true) };
  }
  async read(handle, count) {
    const chunks = [];
    this.inbox.length = 0;
    let next = this.waitFor(m => m.channel === CH_FILE && !m.short, 5000, "read");
    await this.send(CH_FILE, FileApi.read(handle, count), false);
    for (;;) {
      const r = FileApi.parseReply((await next).payload);
      if (r.kind === "status") { if (r.result === -1) throw new Error("read refused"); break; }
      chunks.push(r.data);
      if (r.last) break;
      next = this.waitFor(m => m.channel === CH_FILE && !m.short, 5000, "read");
    }
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  }
  async readPrefix(path, n) {
    if (!(await this.stat(path))) return null;
    const h = await this.statusCall(FileApi.open(path, O_RDONLY), `open ${path}`);
    try { return await this.read(h, n); } finally { await this.statusCall(FileApi.close(h), "close"); }
  }
  async listDir(path) {
    const dir = await this.statusCall(FileApi.opendir(path), `opendir ${path}`);
    const entries = [];
    for (;;) {
      const r = await this.fileCall(FileApi.readdir(dir), "readdir");
      if (r.kind !== "data") break;
      const name = new TextDecoder().decode(r.data.subarray(6, 6 + r.data[4]));
      if (name !== "." && name !== "..") entries.push({ name, dir: r.data[5] === 4 });
    }
    try { await this.statusCall(FileApi.closedir(dir), "closedir"); } catch {}
    return entries;
  }
  async freeKb() { return this.statusCall(FileApi.freeKb(ROOT), "free space"); }

  /** Write `data` at the current position: batches of 15 × 20 KB, the device acks each batch's byte count. */
  async writeData(handle, data, onProgress = () => {}) {
    let done = 0;
    for (let off = 0; off < data.length;) {
      const batch = [];
      for (let i = 0; i < WRITE_BATCH && off < data.length; i++, off += CHUNK) batch.push(data.subarray(off, Math.min(off + CHUNK, data.length)));
      const expected = batch.reduce((n, c) => n + c.length, 0);
      // One serial write per batch: a separate writer.write per 20 KB chunk costs throughput.
      const frames = batch.map((c, i) => {
        const payload = FileApi.write(handle, c, i === batch.length - 1);
        this.guard(CH_FILE, payload);
        return Frame.long(CH_FILE, payload);
      });
      const bytes = new Uint8Array(frames.reduce((n, f) => n + f.length, 0));
      frames.reduce((o, f) => (bytes.set(f, o), o + f.length), 0);
      this.inbox.length = 0;
      const ack = this.waitFor(m => m.channel === CH_FILE && !m.short, 10000, "write ack");
      if (!this.quiet) this.log(`> ch06 write batch: ${batch.length} chunk(s), ${expected} B`, "tx");
      await this.t.write(bytes);
      const r = FileApi.parseReply((await ack).payload);
      if (r.kind !== "status" || r.result !== expected) throw new Error(`write: device accepted ${r.result} of ${expected} bytes`);
      done += expected;
      onProgress(done, data.length);
    }
  }

  /**
   * Import a complete SMP file into an EMPTY pad of the current project, following the official app's
   * sequence (SparkyMK2 sp404-device/src/control.rs import_smp). `project1` is 1-based.
   */
  async importSmp(project1, pad, smp, name, onProgress = () => {}, state = null) {
    const st = await this.status();
    if (st.project + 1 !== project1) throw new Error(`project ${project1} is not current (current: ${st.project + 1})`);
    const block = await this.padBlock(pad);
    if (block.size !== 0) throw new Error(`${padName(pad)} is not empty ("${block.name}")`);
    const path = samplePath(project1, pad), tmp = samplePath(project1, pad, "TMP");
    const id = [pad & 0xFF, pad >> 8];
    if (state) { state.importPad = pad; state.currentProject = project1; }
    await this.send(CH_CONTROL, [0xFB, 0xA0, 0x00], true);                               // begin (no reply)
    try {
      await this.command([0x91, ...id, 0x01, 0x00], 0x11, "release slot");
      await this.command([0x9D], 0x1D, "stop");
      for (const p of [tmp, path]) { try { await this.statusCall(FileApi.unlink(p), `unlink ${p}`); } catch {} }
      const h = await this.statusCall(FileApi.open(path, O_CREAT_TRUNC_RDWR), `open ${path}`);
      this.writableHandles.add(h);
      let written;
      const prevQuiet = this.quiet;
      try {
        await this.statusCall(FileApi.seek(h, 512), "seek 512");
        this.quiet = true;
        await this.writeData(h, smp.subarray(512), (d, t) => onProgress(d, t + 512));
        this.quiet = prevQuiet;
        await this.statusCall(FileApi.seek(h, 0), "seek 0");
        await this.writeData(h, smp.subarray(0, 512));
        written = true;
      } finally {
        this.quiet = prevQuiet;
        await this.statusCall(FileApi.close(h), "close", 20000);
        this.writableHandles.delete(h);
      }
      const s = await this.stat(path);
      if (!written || !s || s.size !== smp.length) throw new Error(`size check: device has ${s?.size}, expected ${smp.length}`);
      const p = assignSampleBlock(block, smp.length, name);
      await this.ctl(p, q => q[0] === 0x1E && (q.length <= 2 || (q[1] === id[0] && q[2] === id[1])), "pad block write");
      const c = (await this.ctl([0x9F, ...id], q => q.length >= 4 && q[0] === 0x1F && q[1] === id[0] && q[2] === id[1], "commit")).payload;
      if (c[3] !== 0) throw new Error(`commit: device status ${c[3]}`);
      onProgress(smp.length, smp.length);
    } finally {
      await this.send(CH_CONTROL, [0xFC, 0x00, 0x00], true);                             // end (no reply)
      if (state) state.importPad = null;
    }
    return this.padBlock(pad);
  }
}

// ---------------------------------------------------------------- MD5 (RFC 1321), for the SMP header digest
const MD5_S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
const MD5_K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);
export function md5(bytes) {
  const len = bytes.length, total = (((len + 8) >>> 6) + 1) * 64;
  const buf = new Uint8Array(total);
  buf.set(bytes); buf[len] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(total - 8, (len * 8) >>> 0, true);
  dv.setUint32(total - 4, Math.floor(len / 2 ** 29), true);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let off = 0; off < total; off += 64) {
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + MD5_K[i] + dv.getUint32(off + g * 4, true)) >>> 0;
      A = D; D = C; C = B;
      const s = MD5_S[(i >> 4) * 4 + (i & 3)];
      B = (B + ((F << s) | (F >>> (32 - s)))) >>> 0;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }
  const out = new Uint8Array(16), o = new DataView(out.buffer);
  [a0, b0, c0, d0].forEach((v, i) => o.setUint32(i * 4, v, true));
  return out;
}

// ---------------------------------------------------------------- SMP (02-files.md)
export function smpHeader(pcmBytes, channels, random = n => crypto.getRandomValues(new Uint8Array(n))) {
  const h = new Uint8Array(512), dv = new DataView(h.buffer);
  h.set([0x52, 0x46, 0x57, 0x56]);                          // "RFWV"
  dv.setUint32(4, pcmBytes + 504); dv.setUint32(8, 48000); dv.setUint32(12, channels); dv.setUint32(16, 16);
  h.set(md5(h.subarray(4, 20)), 0x20);
  h.set(random(512 - 0x30), 0x30);                           // filler: arbitrary bytes, the app writes rand()
  return h;
}
export function parseSmpHeader(h) {
  if (!h || h.length < 0x30 || h[0] !== 0x52 || h[1] !== 0x46 || h[2] !== 0x57 || h[3] !== 0x56) return null;
  const dv = new DataView(h.buffer, h.byteOffset);
  const digest = md5(h.subarray(4, 20));
  return { pcmBytes: dv.getUint32(4) - 504, rate: dv.getUint32(8), channels: dv.getUint32(12), bits: dv.getUint32(16),
    digestOk: digest.every((b, i) => b === h[0x20 + i]) };
}
/** Build an SMP file from interleaved 16-bit PCM (Int16Array). */
export function buildSmp(samples, channels) {
  const smp = new Uint8Array(512 + samples.length * 2);
  smp.set(smpHeader(samples.length * 2, channels));
  const dv = new DataView(smp.buffer);
  for (let i = 0; i < samples.length; i++) dv.setInt16(512 + i * 2, samples[i], false);   // big-endian
  return smp;
}

// ---------------------------------------------------------------- audio decode
function parseWav(buf) {
  const dv = new DataView(buf), str = (o, n) => String.fromCharCode(...new Uint8Array(buf, o, n));
  if (buf.byteLength < 12 || str(0, 4) !== "RIFF" || str(8, 4) !== "WAVE") return null;
  let off = 12, fmt = null, data = null;
  while (off + 8 <= buf.byteLength) {
    const id = str(off, 4), size = dv.getUint32(off + 4, true), body = off + 8;
    if (id === "fmt ") {
      fmt = { format: dv.getUint16(body, true), channels: dv.getUint16(body + 2, true), rate: dv.getUint32(body + 4, true), bits: dv.getUint16(body + 14, true) };
      if (fmt.format === 0xFFFE && size >= 26) fmt.format = dv.getUint16(body + 24, true);
    } else if (id === "data") data = { offset: body, length: Math.min(size, buf.byteLength - body) };
    off = body + size + (size & 1);
  }
  return fmt && data ? { ...fmt, ...data } : null;
}
/**
 * Decode an audio file into 48 kHz 16-bit interleaved PCM (1 or 2 channels).
 * 16-bit 48 kHz PCM WAVs are copied bit-exact; anything else goes through decodeAudioData.
 */
export async function decodeAudio(file) {
  const buf = await file.arrayBuffer();
  const wav = parseWav(buf);
  if (wav && wav.format === 1 && wav.bits === 16 && wav.rate === 48000 && (wav.channels === 1 || wav.channels === 2)) {
    const n = wav.length >> 1, samples = new Int16Array(n), dv = new DataView(buf, wav.offset, n * 2);
    for (let i = 0; i < n; i++) samples[i] = dv.getInt16(i * 2, true);
    return { samples, channels: wav.channels, note: "WAV 48k/16 — bit-exact" };
  }
  const ctx = new OfflineAudioContext(1, 1, 48000);
  const audio = await ctx.decodeAudioData(buf.slice(0));     // resampled to the context's 48 kHz
  const channels = Math.min(2, audio.numberOfChannels), frames = audio.length;
  const data = Array.from({ length: channels }, (_, c) => audio.getChannelData(c));
  const samples = new Int16Array(frames * channels);
  for (let i = 0; i < frames; i++) for (let c = 0; c < channels; c++) {
    const x = Math.max(-1, Math.min(1, data[c][i]));
    samples[i * channels + c] = Math.round(x < 0 ? x * 32768 : x * 32767);
  }
  const src = wav ? `WAV ${wav.rate} Hz/${wav.bits} bit/${wav.channels} ch` : file.type || "audio";
  return { samples, channels, note: `${src} → decodeAudioData → 48k/16/${channels} ch` };
}
