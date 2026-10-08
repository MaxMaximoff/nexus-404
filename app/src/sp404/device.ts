// Request/reply on top of the serial byte stream. One operation at a time (`exclusive`), like
// SparkyMK2's Device::exclusive: a status poll must never land in the middle of an import.

import { CH_CONTROL, CH_FILE, FrameDecoder, encodeLong, encodeShort, hex, type Message } from "./frame";
import {
  BULK_READ, CARD, CHUNK, FileReq, HOST_ACK, hostStatus, parseDeviceFileRequest, isCardImportFile, remotePath, O_CREAT_TRUNC_RDWR, O_RDONLY, ROOT, WRITE_BATCH, parseFileReply, samplePath,
} from "./fileApi";
import {
  BANKS, BPM_MAX_X100, BPM_MIN_X100, FLAG_ONE_SHOT, GLOBAL, PARAM_BANK_TEMPO, PARAM_PROJECT_TEMPO, PARAM_TEMPO_SELECT, LEVEL_MAX, PAD_COUNT, PROJECT_COUNT, PARAM_BPM, PARAM_CLEARED_BY_ONE_SHOT, PARAM_END,
  PARAM_FLAGS, PARAM_GATE, PARAM_PITCH_COARSE, PARAM_PITCH_FINE, PARAM_TIME_STRETCH, PARAM_VINYL, PITCH_COARSE_MAX, PITCH_FINE_MAX,
  STRETCH_MAX_X100, STRETCH_MIN_X100, VARI_MASK, VARI_MODES, PARAM_LEVEL, PARAM_LOOP, PARAM_BPM_SYNC, PARAM_START, assignSampleBlock, byteToFrame, deviceErrorText, padName,
  FLAG_FIXED_VELOCITY, PARAM_ATTACK, PARAM_BALANCE, PARAM_BUS_FX, PARAM_HOLD, PARAM_MUTE_GROUP, PARAM_PAD_LINK, PARAM_PLAY_MODE, PARAM_RELEASE, PARAM_ROLL,
  PAD_PARAM_RANGE, padFieldOf, parsePadBlock, parseProjectSettings, parseStatus, setParamPayload,
  type DeviceStatus, type PadBlock, type ProjectSettings,
} from "./control";
import { SMP_HEADER_LEN, parseSmpHeader } from "./smp";
import { makeGuard, type Guard, type WritePolicy } from "./guard";
import type { SP404Transport } from "./transport";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type Logger = (level: LogLevel, text: string) => void;
export type Progress = (done: number, total: number) => void;

export interface DirEntry { name: string; dir: boolean }
const DT_DIR = 4; // readdir entry type, Linux d_type
const MAX_DIR_ENTRIES = 10000;
const MAX_CARD_DEPTH = 16;
const S_IFMT = 0xf000, S_IFDIR = 0x4000; // stat mode: 0x41FF directory, 0x81FF file

const TIMEOUT = 5000;
/** Status polls while the SP renders: without them it pauses after ~3.5 s (SparkyMK2). */
const RENDER_POLL = 500;
/** Longest the SP may stay silent while rendering (it reports progress meanwhile). */
const RENDER_IDLE = 30000;
const RENDER_BEGIN = 1000, RENDER_END = 1001, RENDER_BOUNCE = 1003;
/** Global parameter the SP echoes with the progress of a long operation, 0..~104. */
const PARAM_PROGRESS = 0x86;
const CLOSE_AFTER_WRITE = 20000;

export class DeviceError extends Error {}

interface Waiter { pred: (m: Message) => boolean; resolve: (m: Message) => void; timer: ReturnType<typeof setTimeout> }

export class SP404Device {
  /** Unsolicited messages: `1A proj` (project data changed), `32 code` (device error), … */
  onNotification: (m: Message) => void = () => {};

  readonly policy: WritePolicy = { importProject: null, importPad: null, writableHandles: new Set() };
  private readonly guard: Guard = makeGuard(this.policy);
  private readonly decoder = new FrameDecoder();
  private inbox: Message[] = [];
  private waiter: Waiter | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private quiet = false;

  constructor(private readonly t: SP404Transport, private readonly log: Logger = () => {}) {
    t.onBytes = (b) => this.onBytes(b);
  }

  get busy(): boolean {
    return this.pending > 0;
  }

  private onBytes(bytes: Uint8Array): void {
    this.decoder.push(bytes);
    for (const m of this.decoder.messages()) {
      if (!this.quiet) this.log("debug", `< ch${m.channel.toString(16).padStart(2, "0")} ${m.short ? "S" : "L"} ${hex(m.payload)}`);
      if (m.channel === CH_CONTROL && m.payload[0] === 0x32 && m.payload.length >= 5) {
        const code = new DataView(m.payload.buffer, m.payload.byteOffset).getInt32(1, true);
        this.log("warn", `SP сообщил об ошибке: ${deviceErrorText(code)} (${code})`);
      }
      if (this.waiter && this.waiter.pred(m)) {
        const w = this.waiter;
        this.waiter = null;
        clearTimeout(w.timer);
        w.resolve(m);
      } else {
        if (m.channel === CH_CONTROL && (m.payload[0] === 0x1a || m.payload[0] === 0x32)) this.onNotification(m);
        this.inbox.push(m);
        if (this.inbox.length > 256) this.inbox.shift();
      }
    }
  }

  private waitFor(pred: (m: Message) => boolean, ms: number, what: string): Promise<Message> {
    const i = this.inbox.findIndex(pred);
    if (i >= 0) return Promise.resolve(this.inbox.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new DeviceError(`нет ответа от SP: ${what}`));
      }, ms);
      this.waiter = { pred, resolve, timer };
    });
  }

  private async send(channel: number, payload: Uint8Array, short: boolean): Promise<void> {
    this.guard(channel, payload);
    if (!this.quiet) this.log("debug", `> ch${channel.toString(16).padStart(2, "0")} ${short ? "S" : "L"} ${hex(payload)}`);
    await this.t.write(short ? encodeShort(channel, payload) : encodeLong(channel, payload));
  }

  /** Run `fn` with no other operation in between. */
  exclusive<T>(fn: (d: this) => Promise<T>): Promise<T> {
    this.pending++;
    const run = this.queue.then(() => fn(this));
    this.queue = run.catch(() => {}).finally(() => this.pending--);
    return run;
  }

  /** Like `exclusive`, but `null` at once when another operation is running (for background polls). */
  tryExclusive<T>(fn: (d: this) => Promise<T>): Promise<T | null> {
    return this.busy ? Promise.resolve(null) : this.exclusive(fn);
  }

  private async transact(channel: number, payload: Uint8Array, short: boolean, pred: (m: Message) => boolean, what: string, ms = TIMEOUT): Promise<Message> {
    this.inbox.length = 0;
    const reply = this.waitFor(pred, ms, what);
    await this.send(channel, payload, short);
    return reply;
  }

  private ctl(payload: ArrayLike<number>, pred: (p: Uint8Array) => boolean, what: string): Promise<Message> {
    const p = Uint8Array.from(payload);
    return this.transact(CH_CONTROL, p, p.length <= 7, (m) => m.channel === CH_CONTROL && pred(m.payload), what);
  }

  /** Short command whose reply is `cmd status`; fails unless status is 0. */
  private async command(payload: number[], expect: number, what: string): Promise<void> {
    const p = (await this.ctl(payload, (q) => q[0] === expect, what)).payload;
    if (p.length > 1 && p[1] !== 0) throw new DeviceError(`${what}: статус ${p[1]}`);
  }

  private fire(payload: number[]): Promise<void> {
    return this.send(CH_CONTROL, Uint8Array.from(payload), true);
  }

  // ------------------------------------------------------------------ control, read

  async status(): Promise<DeviceStatus> {
    return parseStatus((await this.ctl([0xfe, 0x66, 0x00], (p) => p[0] === 0x7e, "status")).payload);
  }

  /** Settings of `project` (0-based) and the 16 project names that follow the reply. */
  async projectSettings(project: number): Promise<ProjectSettings & { names: string[] }> {
    const m = await this.ctl([0xfd, project, 0x00], (p) => p[0] === 0x7d && p[1] === project, "project settings");
    const names: string[] = Array(16).fill("");
    let got = 0;
    const deadline = Date.now() + 1500;
    while (got < 16 && Date.now() < deadline) {
      try {
        const n = await this.waitFor((x) => x.channel === CH_CONTROL && x.payload[0] === 0x35, Math.max(1, deadline - Date.now()), "project names");
        names[n.payload[1] & 15] = new TextDecoder("latin1").decode(n.payload.subarray(2)).replace(/[\0 ]+$/, "").trim();
        got++;
      } catch {
        break;
      }
    }
    return { ...parseProjectSettings(m.payload), names };
  }

  async padBlock(pad: number): Promise<PadBlock> {
    const lo = pad & 0xff, hi = pad >> 8;
    const m = await this.transact(CH_CONTROL, Uint8Array.from([0x9e, lo, hi]), true,
      (x) => x.channel === CH_CONTROL && !x.short && x.payload[0] === 0x1e && x.payload[1] === lo && x.payload[2] === hi,
      `pad block ${padName(pad)}`);
    return parsePadBlock(m.payload);
  }

  async allPadBlocks(onProgress: Progress = () => {}): Promise<PadBlock[]> {
    const out: PadBlock[] = [];
    for (let i = 0; i < PAD_COUNT; i++) {
      out.push(await this.padBlock(i));
      onProgress(i + 1, PAD_COUNT);
    }
    return out;
  }

  // ------------------------------------------------------------------ control, harmless

  /**
   * Select a pad on the unit (global params 00 = bank, 01 = pad), as the official app does on every
   * click. Preview (`8E`) plays the pad selected on the unit, so this must come first.
   */
  async selectOnDevice(pad: number): Promise<void> {
    for (const [id, value] of [[0x00, pad >> 4], [0x01, pad & 15]]) {
      const p = setParamPayload(id, 0xffff, value);
      await this.transact(CH_CONTROL, p, false,
        (m) => m.channel === CH_CONTROL && m.payload[0] === 0x01 && m.payload[1] === id && m.payload[3] === 0xff && m.payload[4] === 0xff,
        "select pad");
    }
  }

  /** Select `pad` on the unit and start playing it (the app sends this on mouse down). */
  async previewStart(pad: number): Promise<void> {
    await this.selectOnDevice(pad);
    const p = (await this.ctl([0x8e, pad & 0xff, pad >> 8, 0x7f, 0xff], (q) => q[0] === 0x0e && q[1] === (pad & 0xff), "preview start")).payload;
    if (p.length > 3 && p[3] !== 0) throw new DeviceError(`прослушивание: статус ${p[3]}`);
  }

  async previewStop(pad: number): Promise<void> {
    await this.ctl([0x8f, pad & 0xff, pad >> 8, 0x00], (p) => p[0] === 0x0f, "preview stop");
  }

  /**
   * Stop a pad that plays on after preview (Gate off: the SP ignores `8F` then). What one would do
   * by hand: Gate on, press and release the pad, which cuts the old voice, then Gate back off.
   * With Gate on, a release alone stops it. Returns the block re-read afterwards.
   */
  stopPad(project1: number, pad: number): Promise<PadBlock> {
    return this.editPad(project1, pad, async (b) => {
      if (b.gate) return this.previewStop(pad);
      await this.setParam(pad, PARAM_GATE, 1);
      try {
        await this.previewStart(pad);
        await this.previewStop(pad);
      } finally {
        await this.setParam(pad, PARAM_GATE, 0);
      }
    });
  }

  /**
   * Move a pad's sample with its settings, as the official app's drag does: onto an empty pad
   * (`95 src dst 0`), or swap with an occupied one (`95 src dst 1`). Overwrite (mode 0 onto a
   * sample) is never sent: it deletes the destination. The unit answers `15 00` and, once the
   * project is updated, `1A proj`; both blocks are re-read after that. With `onlyToEmpty` an
   * occupied destination is an error instead of a swap.
   */
  async movePad(project1: number, src: number, dst: number, onlyToEmpty = false): Promise<{ src: PadBlock; dst: PadBlock; swapped: boolean }> {
    for (const p of [src, dst]) if (!(Number.isInteger(p) && p >= 0 && p < PAD_COUNT)) throw new DeviceError(`нет pad'а ${p}`);
    if (src === dst) throw new DeviceError("pad переносится сам на себя");
    await this.requireCurrent(project1);
    if (!(await this.padBlock(src)).size) throw new DeviceError(`${padName(src)} пуст`);
    const swapped = !!(await this.padBlock(dst)).size;
    if (swapped && onlyToEmpty) throw new DeviceError(`${padName(dst)} уже занят`);
    this.policy.moveToEmpty = swapped ? null : dst;
    try {
      await this.command([0x95, src & 0xff, src >> 8, dst & 0xff, dst >> 8, swapped ? 1 : 0, 0], 0x15, "перенос pad'а");
    } finally {
      this.policy.moveToEmpty = null;
    }
    await this.waitFor((m) => m.channel === CH_CONTROL && m.payload[0] === 0x1a, 3000, "project update").catch(() =>
      this.log("warn", "SP не прислал 1A после переноса, читаю блоки так"));
    return { src: await this.padBlock(src), dst: await this.padBlock(dst), swapped };
  }

  /**
   * Delete a pad's sample (`91 pad 00 00`), for good: the user has confirmed it. Only a loaded pad
   * of the current project, outside the menu, in a bank that is not protected. The unit answers
   * `11 00` twice and then `1A proj`; the block is re-read after that and must be empty.
   */
  async deletePad(project1: number, pad: number): Promise<PadBlock> {
    if (!(Number.isInteger(pad) && pad >= 0 && pad < PAD_COUNT)) throw new DeviceError(`нет pad'а ${pad}`);
    await this.requireCurrent(project1);
    if (!(await this.padBlock(pad)).size) throw new DeviceError(`${padName(pad)} уже пуст`);
    if ((await this.projectSettings(project1 - 1)).banks[pad >> 4]?.protected) throw new DeviceError(`банк ${BANKS[pad >> 4]} защищён (BANK Protect)`);
    this.policy.deletePad = pad;
    try {
      await this.command([0x91, pad & 0xff, pad >> 8, 0x00, 0x00], 0x11, "удаление pad'а");
    } finally {
      this.policy.deletePad = null;
    }
    // The second 11 00 and the 1A may come in either order; take both so neither is mistaken for a later reply.
    const ctl = (c: number) => (m: Message) => m.channel === CH_CONTROL && m.payload[0] === c;
    await this.waitFor(ctl(0x11), 2000, "второй ответ на удаление").catch(() => this.log("warn", "SP не прислал второй 11 00 после удаления"));
    await this.waitFor(ctl(0x1a), 3000, "project update").catch(() => this.log("warn", "SP не прислал 1A после удаления, читаю блок так"));
    const block = await this.padBlock(pad);
    if (block.size) throw new DeviceError(`${padName(pad)}: после удаления блок не пуст`);
    return block;
  }

  /**
   * Select a project (1-based) on the unit. It answers `1A 00` and then loads the project: pad
   * blocks read empty for a while, so the caller waits before reading them (report §0).
   */
  async selectProject(project1: number): Promise<void> {
    if (!(Number.isInteger(project1) && project1 >= 1 && project1 <= PROJECT_COUNT)) throw new DeviceError(`нет проекта ${project1}`);
    const st = await this.status();
    if (st.workingMode !== 0) throw new DeviceError("SP показывает меню — закройте его на устройстве");
    if (st.project + 1 === project1) return;
    await this.command([0x9a, project1 - 1, 0x00], 0x1a, "выбор проекта");
  }

  /** What the official app sends when it lets go of the device. No reply. */
  async mkiiExit(): Promise<void> {
    await this.fire([0x3a, 0x00, 0x00, 0x00]);
  }

  // ------------------------------------------------------------------ control, write

  /** Send one set-parameter (`target` = pad, or GLOBAL) and wait for the device's echo. */
  private async setParam(target: number, id: number, value: number): Promise<void> {
    const p = setParamPayload(id, target, value);
    await this.transact(CH_CONTROL, p, false,
      (m) => m.channel === CH_CONTROL && m.payload[0] === 0x01 && m.payload[1] === id && m.payload[3] === p[3] && m.payload[4] === p[4],
      `set param ${id.toString(16)}`);
  }

  /**
   * Edit a loaded pad of the current project: checks the project and the menu, runs `fn` with the
   * block as it is now, and returns the block re-read afterwards (the device has the last word).
   */
  private async editPad(project1: number, pad: number, fn: (block: PadBlock) => Promise<void>): Promise<PadBlock> {
    await this.requireCurrent(project1);
    const block = await this.padBlock(pad);
    if (!block.size) throw new DeviceError(`${padName(pad)} пуст`);
    await fn(block);
    return this.padBlock(pad);
  }

  /** Set a pad's BPM (× 100). `project1` must be the current project, checked first. */
  async setBpm(project1: number, pad: number, bpmX100: number): Promise<PadBlock> {
    checkBpm(bpmX100);
    return this.editPad(project1, pad, () => this.setParam(pad, PARAM_BPM, bpmX100));
  }

  async setLevel(project1: number, pad: number, level: number): Promise<PadBlock> {
    if (!(Number.isInteger(level) && level >= 0 && level <= LEVEL_MAX)) throw new DeviceError(`Level должен быть от 0 до ${LEVEL_MAX}`);
    return this.editPad(project1, pad, () => this.setParam(pad, PARAM_LEVEL, level));
  }

  setGate(project1: number, pad: number, on: boolean): Promise<PadBlock> {
    return this.editPad(project1, pad, () => this.setParam(pad, PARAM_GATE, on ? 1 : 0));
  }

  setLoop(project1: number, pad: number, on: boolean): Promise<PadBlock> {
    return this.editPad(project1, pad, () => this.setParam(pad, PARAM_LOOP, on ? 1 : 0));
  }

  setBpmSync(project1: number, pad: number, on: boolean): Promise<PadBlock> {
    return this.editPad(project1, pad, () => this.setParam(pad, PARAM_BPM_SYNC, on ? 1 : 0));
  }

  /** Vinyl on: tempo changes shift pitch, like a record (checked on the unit); the official app greys out Pitch. */
  setVinyl(project1: number, pad: number, on: boolean): Promise<PadBlock> {
    return this.editPad(project1, pad, () => this.setParam(pad, PARAM_VINYL, on ? 1 : 0));
  }

  async setTimeStretch(project1: number, pad: number, x100: number): Promise<PadBlock> {
    if (!(Number.isInteger(x100) && x100 >= STRETCH_MIN_X100 && x100 <= STRETCH_MAX_X100)) throw new DeviceError("Time Stretch должен быть от 50 до 150 %");
    return this.editPad(project1, pad, () => this.setParam(pad, PARAM_TIME_STRETCH, x100));
  }

  /** Pitch in semitones (±12) and cents (±100); only the changed one is sent. */
  async setPitch(project1: number, pad: number, coarse: number, fine: number): Promise<PadBlock> {
    if (!(Number.isInteger(coarse) && Math.abs(coarse) <= PITCH_COARSE_MAX)) throw new DeviceError(`Pitch: полутоны от −${PITCH_COARSE_MAX} до ${PITCH_COARSE_MAX}`);
    if (!(Number.isInteger(fine) && Math.abs(fine) <= PITCH_FINE_MAX)) throw new DeviceError(`Pitch: центы от −${PITCH_FINE_MAX} до ${PITCH_FINE_MAX}`);
    return this.editPad(project1, pad, async (b) => {
      if (coarse !== b.pitchCoarse) await this.setParam(pad, PARAM_PITCH_COARSE, coarse);
      if (fine !== b.pitchFine) await this.setParam(pad, PARAM_PITCH_FINE, fine);
    });
  }

  /** VARI MODE, index into VARI_MODES: sets bits 1–2 of the mode flags, keeping the other bits. */
  setVari(project1: number, pad: number, mode: number): Promise<PadBlock> {
    if (!(Number.isInteger(mode) && mode >= 0 && mode < VARI_MODES.length)) throw new DeviceError(`VARI MODE: 0–${VARI_MODES.length - 1}`);
    return this.editPad(project1, pad, (b) => this.setParam(pad, PARAM_FLAGS, (b.flags & ~VARI_MASK) | (mode << 1)));
  }

  /**
   * Set one of the plain per-pad parameters (Mute Group, Play Mode, Balance, PAD Link, BUS FX,
   * Roll, Attack, Hold, Release): an integer within its PAD_PARAM_RANGE.
   */
  setPadParam(project1: number, pad: number, id: number, value: number): Promise<PadBlock> {
    const range = PLAIN_PARAMS.has(id) ? PAD_PARAM_RANGE.get(id) : undefined;
    if (!range) throw new DeviceError(`параметр ${id.toString(16)} так не задаётся`);
    if (!(Number.isInteger(value) && value >= range[0] && value <= range[1])) throw new DeviceError(`значение ${value} вне ${range[0]}–${range[1]}`);
    return this.editPad(project1, pad, () => this.setParam(pad, id, value));
  }

  /** Fixed Velocity: bit 0 of the mode flags, keeping the other bits. */
  setFixedVelocity(project1: number, pad: number, on: boolean): Promise<PadBlock> {
    return this.editPad(project1, pad, (b) => this.setParam(pad, PARAM_FLAGS, on ? b.flags | FLAG_FIXED_VELOCITY : b.flags & ~FLAG_FIXED_VELOCITY));
  }

  /**
   * Toggle bit 5 of the mode flags, keeping the other bits. Turning One Shot on also sends
   * Gate = 0, Loop = 0 and `72` = 0 afterwards, as the official app does.
   */
  setOneShot(project1: number, pad: number, on: boolean): Promise<PadBlock> {
    return this.editPad(project1, pad, async (b) => {
      await this.setParam(pad, PARAM_FLAGS, on ? b.flags | FLAG_ONE_SHOT : b.flags & ~FLAG_ONE_SHOT);
      if (on && !b.oneShot) for (const id of [PARAM_GATE, PARAM_LOOP, PARAM_CLEARED_BY_ONE_SHOT]) await this.setParam(pad, id, 0);
    });
  }

  /**
   * Edit project-wide settings of the current project: checks the project and the menu, runs
   * `fn`, and returns the settings re-read afterwards.
   */
  private async editProject(project1: number, fn: () => Promise<void>): Promise<ProjectSettings & { names: string[] }> {
    const st = await this.requireCurrent(project1);
    await fn();
    return this.projectSettings(st.project);
  }

  async setProjectTempo(project1: number, bpmX100: number) {
    checkBpm(bpmX100);
    return this.editProject(project1, () => this.setParam(GLOBAL, PARAM_PROJECT_TEMPO, bpmX100));
  }

  async setBankTempo(project1: number, bank: number, bpmX100: number) {
    checkBpm(bpmX100);
    if (!(Number.isInteger(bank) && bank >= 0 && bank < 10)) throw new DeviceError(`нет банка ${bank}`);
    return this.editProject(project1, () => this.setParam(GLOBAL, PARAM_BANK_TEMPO + bank, bpmX100));
  }

  /** `true`: the project tempo applies to every bank; `false`: each bank plays at its own tempo. */
  setTempoSelect(project1: number, useProjectTempo: boolean) {
    return this.editProject(project1, () => this.setParam(GLOBAL, PARAM_TEMPO_SELECT, useProjectTempo ? 1 : 0));
  }

  /** Channel count from the SMP header on the card. */
  async sampleChannels(project1: number, pad: number): Promise<number> {
    const info = parseSmpHeader(await this.readFile(samplePath(project1, pad), SMP_HEADER_LEN));
    if (!info || info.channels < 1 || info.channels > 2) throw new DeviceError(`${padName(pad)}: не удалось прочитать заголовок сэмпла`);
    return info.channels;
  }

  /**
   * Set Start/End in frames (End exclusive, at most the sample length). Only changed markers are
   * sent, in an order that keeps Start < End at every step.
   */
  setRange(project1: number, pad: number, start: number, end: number): Promise<PadBlock> {
    return this.editPad(project1, pad, async (b) => {
      const ch = await this.sampleChannels(project1, pad);
      const total = byteToFrame(b.size, ch);
      if (!(Number.isInteger(start) && Number.isInteger(end) && start >= 0 && start < end && end <= total))
        throw new DeviceError(`Start/End: нужно 0 ≤ Start < End ≤ ${total} кадров`);
      const oldEnd = byteToFrame(b.endByte, ch);
      const steps: [number, number][] = [];
      if (start !== byteToFrame(b.startByte, ch)) steps.push([PARAM_START, start]);
      if (end !== oldEnd) steps.push([PARAM_END, end]);
      if (start >= oldEnd) steps.reverse(); // new Start would pass the old End: move End first
      for (const [id, v] of steps) await this.setParam(pad, id, v);
    });
  }

  private async requireCurrent(project1: number): Promise<DeviceStatus> {
    const st = await this.status();
    if (st.project + 1 !== project1) throw new DeviceError(`на SP сейчас проект ${st.project + 1}, а не ${project1}`);
    if (st.workingMode !== 0) throw new DeviceError("SP показывает меню — закройте его на устройстве");
    return st;
  }

  // ------------------------------------------------------------------ file API

  private async fileCall(payload: Uint8Array, what: string, ms = TIMEOUT) {
    const m = await this.transact(CH_FILE, payload, false, (x) => x.channel === CH_FILE && !x.short, what, ms);
    return parseFileReply(m.payload);
  }

  private async statusCall(payload: Uint8Array, what: string, ms = TIMEOUT): Promise<number> {
    const r = await this.fileCall(payload, what, ms);
    if (r.kind !== "status") throw new DeviceError(`${what}: неожиданные данные`);
    if (r.result === -1) throw new DeviceError(`${what}: отказ (errno ${r.extra})`);
    return r.result;
  }

  async stat(path: string): Promise<{ mode: number; size: number } | null> {
    const r = await this.fileCall(FileReq.stat(path), `stat ${path}`);
    if (r.kind === "status") return null;
    const dv = new DataView(r.data.buffer, r.data.byteOffset);
    return { mode: dv.getUint32(0, true), size: dv.getUint32(4, true) };
  }

  async freeKb(): Promise<number> {
    return this.statusCall(FileReq.freeKb(ROOT), "free space");
  }

  private async read(handle: number, count: number): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    this.inbox.length = 0;
    let next = this.waitFor((m) => m.channel === CH_FILE && !m.short, TIMEOUT, "read");
    await this.send(CH_FILE, FileReq.read(handle, count), false);
    for (;;) {
      const r = parseFileReply((await next).payload);
      if (r.kind === "status") {
        if (r.result === -1) throw new DeviceError("read: отказ");
        break;
      }
      chunks.push(r.data);
      if (r.last) break;
      next = this.waitFor((m) => m.channel === CH_FILE && !m.short, TIMEOUT, "read");
    }
    return concat(chunks);
  }

  /**
   * List a directory, without `.` and `..`: on the card (`/…`) or in the device's own storage
   * (`/SP404REMOTE//…`). `opendir` hands back a handle even for a missing path, which then lists
   * empty. The card closes the handle itself once readdir runs out and refuses closedir after
   * that: not a failure.
   */
  async listDir(path: string): Promise<DirEntry[]> {
    const h = await this.statusCall(FileReq.opendir(path), `opendir ${path}`);
    const out: DirEntry[] = [];
    try {
      for (let n = 0; n < MAX_DIR_ENTRIES; n++) {
        const r = await this.fileCall(FileReq.readdir(h), "readdir");
        if (r.kind === "status") break;
        const len = r.data[4] ?? 0, name = new TextDecoder().decode(r.data.subarray(6, 6 + len));
        if (name !== "." && name !== "..") out.push({ name, dir: r.data[5] === DT_DIR });
      }
    } finally {
      await this.statusCall(FileReq.closedir(h), "closedir").catch(() => {});
    }
    return out;
  }

  /**
   * Put a new file into the card's IMPORT/ folder (`sd:/IMPORT/…`), for the SP's own IMPORT
   * browser: SparkyMK2 checked that a file written there over USB shows up on the unit. An
   * existing name is refused, so nothing on the card is replaced; the size is checked after.
   */
  async writeCardFile(path: string, data: Uint8Array, onProgress: Progress = () => {}): Promise<void> {
    const wire = remotePath(path);
    if (!path.startsWith(CARD) || !isCardImportFile(wire)) throw new DeviceError(`на карту можно писать только в IMPORT: ${path}`);
    if (await this.stat(path)) throw new DeviceError(`на карте уже есть ${wire}`);
    this.policy.cardWrite = wire;
    try {
      const h = await this.statusCall(FileReq.open(path, O_CREAT_TRUNC_RDWR), `open ${wire}`);
      this.policy.writableHandles.add(h);
      const prevQuiet = this.quiet;
      try {
        this.quiet = true;
        await this.writeData(h, data, (d) => onProgress(d, data.length));
      } finally {
        this.quiet = prevQuiet;
        await this.statusCall(FileReq.close(h), "close", CLOSE_AFTER_WRITE);
        this.policy.writableHandles.delete(h);
      }
    } finally {
      this.policy.cardWrite = null;
    }
    const st = await this.stat(path);
    if (!st || st.size !== data.length) throw new DeviceError(`проверка размера: на карте ${st?.size ?? "нет файла"}, ожидалось ${data.length}`);
    onProgress(data.length, data.length);
  }

  /**
   * Delete a file or a folder with everything in it, inside the card's IMPORT/ only (the user has
   * confirmed it). The card removes only empty folders, so a folder is emptied first, depth first.
   * `onItem` gets each wire path once it is gone; returns how many entries went.
   */
  async deleteCardPath(path: string, onItem: (wire: string) => void = () => {}): Promise<number> {
    const wire = remotePath(path);
    if (!path.startsWith(CARD) || !isCardImportFile(wire)) throw new DeviceError(`на карте можно удалять только внутри IMPORT: ${path}`);
    const st = await this.stat(path);
    if (!st) throw new DeviceError(`на карте нет ${wire}`);
    let n = 0;
    const remove = async (p: string, dir: boolean, depth: number): Promise<void> => {
      if (depth > MAX_CARD_DEPTH) throw new DeviceError(`слишком глубокая вложенность: ${remotePath(p)}`);
      if (dir) for (const e of await this.listDir(p)) await remove(`${p}/${e.name}`, e.dir, depth + 1);
      this.policy.cardDelete = remotePath(p);
      try {
        await this.statusCall(dir ? FileReq.rmdir(p) : FileReq.unlink(p), `${dir ? "rmdir" : "unlink"} ${remotePath(p)}`);
      } finally {
        this.policy.cardDelete = null;
      }
      n++;
      onItem(remotePath(p));
    };
    await remove(path.replace(/\/+$/, ""), (st.mode & S_IFMT) === S_IFDIR, 0);
    return n;
  }

  /** Create a folder inside the card's IMPORT/; an existing name is refused. */
  async mkdirCard(path: string): Promise<void> {
    const wire = remotePath(path);
    if (!path.startsWith(CARD) || !isCardImportFile(wire)) throw new DeviceError(`папки на карте создаются только внутри IMPORT: ${path}`);
    if (await this.stat(path)) throw new DeviceError(`на карте уже есть ${wire}`);
    this.policy.cardMkdir = wire;
    try {
      await this.statusCall(FileReq.mkdir(path), `mkdir ${wire}`);
    } finally {
      this.policy.cardMkdir = null;
    }
  }

  /**
   * Rename or move a file or folder, both paths inside the card's IMPORT/. The destination must
   * not exist (nothing is replaced), and a folder cannot go into itself.
   */
  async renameCard(from: string, to: string): Promise<void> {
    const a = remotePath(from), b = remotePath(to);
    if (![from, to].every((p) => p.startsWith(CARD)) || !isCardImportFile(a) || !isCardImportFile(b))
      throw new DeviceError(`переносить на карте можно только внутри IMPORT: ${a} → ${b}`);
    if (a === b) return;
    if (b.startsWith(`${a}/`)) throw new DeviceError(`папку нельзя перенести в саму себя: ${a} → ${b}`);
    if (!(await this.stat(from))) throw new DeviceError(`на карте нет ${a}`);
    // Only a change of case is the same entry on the card's filesystem; anything else that exists is refused.
    if (a.toLowerCase() !== b.toLowerCase() && (await this.stat(to))) throw new DeviceError(`на карте уже есть ${b}`);
    const req = FileReq.rename(from, to); // throws on a path that does not fit, before anything is sent
    this.policy.cardRename = { from: a, to: b };
    try {
      await this.statusCall(req, `rename ${a} → ${b}`);
    } finally {
      this.policy.cardRename = null;
    }
  }

  /** Whole file, or its first `limit` bytes. `null` when it does not exist. */
  async readFile(path: string, limit = Infinity, onProgress: Progress = () => {}): Promise<Uint8Array | null> {
    const st = await this.stat(path);
    if (!st) return null;
    const total = Math.min(st.size, limit);
    const h = await this.statusCall(FileReq.open(path, O_RDONLY), `open ${path}`);
    const parts: Uint8Array[] = [];
    let done = 0;
    const prevQuiet = this.quiet;
    try {
      this.quiet = total > CHUNK;
      while (done < total) {
        const part = await this.read(h, Math.min(BULK_READ, total - done));
        if (part.length === 0) break;
        parts.push(part);
        done += part.length;
        onProgress(done, total);
      }
    } finally {
      this.quiet = prevQuiet;
      await this.statusCall(FileReq.close(h), "close");
    }
    return concat(parts).subarray(0, total);
  }

  /**
   * Bounce: the SP plays pattern `slot` of the current project in real time and writes the result
   * to us as a WAV (SparkyMK2 spec 04-patterns.md; their client checked it on the unit). Nothing is
   * written on the SP. `onProgress` gets 0..1 from the SP's progress reports.
   */
  async bouncePattern(project1: number, slot: number, onProgress: (f: number) => void = () => {}): Promise<Uint8Array> {
    if (!(Number.isInteger(slot) && slot >= 0 && slot < PAD_COUNT)) throw new DeviceError(`нет слота паттерна ${slot}`);
    await this.requireCurrent(project1);
    const id = [slot & 0xff, slot >> 8];
    const control = (op: number) => this.ctl([0xb8, ...id, op & 0xff, op >> 8, 0, 0],
      (q) => q[0] === 0x38 && q[1] === id[0] && q[2] === id[1] && (q[3] | (q[4] << 8)) === op, `рендер ${op}`);
    const file = new HostFile();
    this.policy.renderPattern = slot;
    try {
      await this.fire([0xfb, 0x00, 0x00]); // begin (no reply)
      try {
        await control(RENDER_BEGIN);
        try {
          await this.serveRender(id, RENDER_BOUNCE, file, onProgress);
        } finally {
          await control(RENDER_END).catch((e) => this.log("warn", `конец рендера: ${(e as Error).message}`));
        }
      } finally {
        await this.fire([0xfc, 0x00, 0x00]); // end (no reply)
      }
    } finally {
      this.policy.renderPattern = null;
    }
    return file.bytes();
  }

  /** Start render `op` and answer the SP's writes into `file` until it reports the result. */
  private async serveRender(id: number[], op: number, file: HostFile, onProgress: (f: number) => void): Promise<void> {
    const isStatus = (m: Message) => m.channel === CH_CONTROL && m.payload[0] === 0x7e;
    this.inbox.length = 0;
    await this.send(CH_CONTROL, Uint8Array.from([0xb8, ...id, op & 0xff, op >> 8, 0, 0]), true);
    let polled = Date.now(), heard = Date.now();
    const prevQuiet = this.quiet;
    this.quiet = true; // a bounce is ~100 frames each way
    try {
      for (;;) {
        if (Date.now() - polled >= RENDER_POLL) {
          this.inbox = this.inbox.filter((m) => !isStatus(m));
          await this.fire([0xfe, 0x66, 0x00]);
          polled = Date.now();
        }
        let m: Message;
        try {
          m = await this.waitFor((x) => !isStatus(x), RENDER_POLL, "рендер");
        } catch {
          if (Date.now() - heard > RENDER_IDLE) throw new DeviceError(`SP молчит ${RENDER_IDLE / 1000} s во время рендера`);
          continue;
        }
        heard = Date.now();
        const p = m.payload;
        if (m.channel === CH_FILE && !m.short) {
          const r = parseDeviceFileRequest(p);
          if (!r) { this.log("warn", `рендер: непонятный запрос файла ${hex(p, 16)}`); continue; }
          const result = r.op === "write" ? file.write(r.data) : file.seek(r.offset);
          await this.send(CH_FILE, Uint8Array.from(HOST_ACK), true);
          await this.send(CH_FILE, hostStatus(result), false);
          continue;
        }
        if (m.channel === CH_CONTROL && p[0] === 0x39 && p.length >= 9 && p[1] === id[0] && p[2] === id[1] && (p[3] | (p[4] << 8)) === op) {
          const code = p[7] | (p[8] << 8);
          if (code !== 0) throw new DeviceError(`SP не смог отрендерить паттерн (код ${code})`);
          onProgress(1);
          return;
        }
        if (m.channel === CH_CONTROL && p[0] === 0x01 && p[1] === PARAM_PROGRESS && p.length >= 9)
          onProgress(Math.min(1, new DataView(p.buffer, p.byteOffset).getInt32(5, true) / 100));
      }
    } finally {
      this.quiet = prevQuiet;
    }
  }

  /** Write at the current position: 15 × 20 KB per batch, the device acks each batch's byte count. */
  private async writeData(handle: number, data: Uint8Array, onProgress: Progress = () => {}): Promise<void> {
    let done = 0;
    for (let off = 0; off < data.length; ) {
      const batch: Uint8Array[] = [];
      for (let i = 0; i < WRITE_BATCH && off < data.length; i++, off += CHUNK) batch.push(data.subarray(off, Math.min(off + CHUNK, data.length)));
      const expected = batch.reduce((n, c) => n + c.length, 0);
      const frames = batch.map((c, i) => {
        const payload = FileReq.write(handle, c, i === batch.length - 1);
        this.guard(CH_FILE, payload);
        return encodeLong(CH_FILE, payload);
      });
      this.inbox.length = 0;
      const ack = this.waitFor((m) => m.channel === CH_FILE && !m.short, 10000, "write ack");
      await this.t.write(concat(frames)); // one serial write per batch
      const r = parseFileReply((await ack).payload);
      if (r.kind !== "status" || r.result !== expected) throw new DeviceError(`запись: SP принял ${r.kind === "status" ? r.result : "?"} из ${expected} байт`);
      done += expected;
      onProgress(done, data.length);
    }
  }

  /**
   * Import a complete SMP file into an EMPTY pad of the current project, following the official
   * app's sequence (SparkyMK2 sp404-device/src/control.rs import_smp; verified on hardware).
   */
  /**
   * Copy a pad onto an empty one. The unit has no copy command: the source SMP is read and imported
   * unchanged under the same name, then the settings in PAD_PARAM_RANGE are sent as set-parameters.
   * Chop points and anything else outside that list stay as on a fresh pad. Progress: reading is the
   * first half, writing the second. Returns the new block and the settings that did not come out equal.
   */
  async copyPad(project1: number, src: number, dst: number, onProgress: Progress = () => {}): Promise<{ block: PadBlock; differs: string[] }> {
    for (const p of [src, dst]) if (!(Number.isInteger(p) && p >= 0 && p < PAD_COUNT)) throw new DeviceError(`нет pad'а ${p}`);
    if (src === dst) throw new DeviceError("pad копируется сам на себя");
    await this.requireCurrent(project1);
    const s = await this.padBlock(src);
    if (!s.size) throw new DeviceError(`${padName(src)} пуст`);
    if ((await this.padBlock(dst)).size) throw new DeviceError(`${padName(dst)} уже занят`); // before the long read
    const smp = await this.readFile(samplePath(project1, src), Infinity, (d, t) => onProgress(d, 2 * t));
    if (!smp || smp.length !== s.size) throw new DeviceError(`${padName(src)}: не удалось прочитать сэмпл (${smp?.length ?? "нет файла"} из ${s.size} байт)`);
    const ch = parseSmpHeader(smp)?.channels;
    if (ch !== 1 && ch !== 2) throw new DeviceError(`${padName(src)}: не удалось прочитать заголовок сэмпла`);
    const b = await this.importSmp(project1, dst, smp, s.name, (d, t) => onProgress(t + d, 2 * t));

    // Start, then End: the fresh pad spans the whole file, so Start < End holds at every step.
    if (s.startByte !== b.startByte) await this.setParam(dst, PARAM_START, byteToFrame(s.startByte, ch));
    if (s.endByte !== b.endByte) await this.setParam(dst, PARAM_END, byteToFrame(s.endByte, ch));
    // On/off fields may read other than 1 when on (Loop reads 7FFFFFFF): they are sent as 0/1.
    const field = (blk: PadBlock, id: number) => {
      const v = new DataView(blk.raw.buffer, blk.raw.byteOffset).getInt32(3 + padFieldOf(id) * 4, true);
      return PAD_PARAM_RANGE.get(id)![1] === 1 ? +(v !== 0) : v;
    };
    // Flags first: One Shot on the unit may touch Gate and Loop, which come after it.
    const ids = [PARAM_FLAGS, ...[...PAD_PARAM_RANGE.keys()].filter((id) => id !== PARAM_FLAGS && id !== PARAM_START && id !== PARAM_END)];
    const skipped: string[] = [];
    for (const id of ids) {
      const v = field(s, id), range = PAD_PARAM_RANGE.get(id)!;
      if (v === field(b, id)) continue;
      if (v < range[0] || v > range[1]) { skipped.push(`${id.toString(16)}=${v}`); continue; }
      await this.setParam(dst, id, v);
    }
    if (skipped.length) this.log("warn", `${padName(dst)}: не скопировано (вне разрешённого): ${skipped.join(", ")}`);

    const out = await this.padBlock(dst);
    const differs = [
      ...(out.startByte !== s.startByte ? ["Start"] : []), ...(out.endByte !== s.endByte ? ["End"] : []),
      ...ids.filter((id) => field(out, id) !== field(s, id)).map((id) => id.toString(16)),
    ];
    return { block: out, differs };
  }

  async importSmp(project1: number, pad: number, smp: Uint8Array, name: string, onProgress: Progress = () => {}): Promise<PadBlock> {
    await this.requireCurrent(project1);
    const block = await this.padBlock(pad);
    if (block.size !== 0) throw new DeviceError(`${padName(pad)} уже занят («${block.name}»)`);
    const path = samplePath(project1, pad);
    const tmp = samplePath(project1, pad, "TMP");
    const id = [pad & 0xff, pad >> 8];
    this.policy.importProject = project1;
    this.policy.importPad = pad;
    try {
      await this.fire([0xfb, 0xa0, 0x00]); // begin (no reply)
      try {
        await this.command([0x91, ...id, 0x01, 0x00], 0x11, "release slot");
        await this.command([0x9d], 0x1d, "stop");
        for (const p of [tmp, path]) {
          try { await this.statusCall(FileReq.unlink(p), `unlink ${p}`); } catch { /* usually absent */ }
        }
        const h = await this.statusCall(FileReq.open(path, O_CREAT_TRUNC_RDWR), `open ${path}`);
        this.policy.writableHandles.add(h);
        const prevQuiet = this.quiet;
        try {
          await this.statusCall(FileReq.seek(h, 512), "seek");
          this.quiet = true;
          await this.writeData(h, smp.subarray(512), (d) => onProgress(d, smp.length));
          this.quiet = prevQuiet;
          await this.statusCall(FileReq.seek(h, 0), "seek");
          await this.writeData(h, smp.subarray(0, 512));
        } finally {
          this.quiet = prevQuiet;
          await this.statusCall(FileReq.close(h), "close", CLOSE_AFTER_WRITE);
          this.policy.writableHandles.delete(h);
        }
        const st = await this.stat(path);
        if (!st || st.size !== smp.length) throw new DeviceError(`проверка размера: на SP ${st?.size ?? "нет файла"}, ожидалось ${smp.length}`);
        const p = assignSampleBlock(block, smp.length, name);
        await this.ctl(p, (q) => q[0] === 0x1e && (q.length <= 2 || (q[1] === id[0] && q[2] === id[1])), "pad block write");
        const c = (await this.ctl([0x9f, ...id], (q) => q.length >= 4 && q[0] === 0x1f && q[1] === id[0] && q[2] === id[1], "commit")).payload;
        if (c[3] !== 0) throw new DeviceError(`commit: статус ${c[3]}`);
        onProgress(smp.length, smp.length);
      } finally {
        await this.fire([0xfc, 0x00, 0x00]); // end (no reply)
      }
    } finally {
      this.policy.importPad = null;
      this.policy.importProject = null;
    }
    return this.padBlock(pad);
  }
}

/** Parameters with no side effects on others, set through setPadParam. */
const PLAIN_PARAMS = new Set([PARAM_MUTE_GROUP, PARAM_PLAY_MODE, PARAM_BALANCE, PARAM_PAD_LINK, PARAM_BUS_FX, PARAM_ROLL, PARAM_ATTACK, PARAM_HOLD, PARAM_RELEASE]);

/** A file of ours the SP writes into while rendering: grows on write, seek may go anywhere. */
class HostFile {
  private buf = new Uint8Array(1 << 20);
  private size = 0;
  private pos = 0;

  write(data: Uint8Array): number {
    const end = this.pos + data.length;
    if (end > this.buf.length) {
      const n = new Uint8Array(Math.max(end, this.buf.length * 2));
      n.set(this.buf.subarray(0, this.size));
      this.buf = n;
    }
    this.buf.set(data, this.pos);
    this.pos = end;
    this.size = Math.max(this.size, end);
    return data.length;
  }

  seek(offset: number): number {
    this.pos = offset;
    return offset;
  }

  bytes(): Uint8Array {
    return this.buf.slice(0, this.size);
  }
}

function checkBpm(x100: number): void {
  if (!(Number.isInteger(x100) && x100 >= BPM_MIN_X100 && x100 <= BPM_MAX_X100)) throw new DeviceError("BPM должен быть от 40 до 200");
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
