// Channel 5: status, project settings, pad blocks, set parameter (SparkyMK2 docs/re/03-parameters.md).

export const BANKS = "ABCDEFGHIJ";
export const PAD_COUNT = 160;
export const PROJECT_COUNT = 16;
export const padName = (i: number): string => `${BANKS[i >> 4]}${(i & 15) + 1}`;

export interface DeviceStatus {
  project: number; // 0-based
  bank: number;
  pad: number;
  workingMode: number; // 0 = normal; 4 while the device shows a settings screen
  playing: boolean;
}

export function parseStatus(p: Uint8Array): DeviceStatus {
  const pos = new DataView(p.buffer, p.byteOffset, p.byteLength).getUint32(8, true);
  return { project: p[1], bank: p[3], pad: p[5], workingMode: p[12], playing: pos !== 0xffffffff };
}

export interface BankSettings { letter: string; protected: boolean; tempoX100: number; volume: number }
export interface ProjectSettings {
  project: number;
  projectTempoX100: number;
  useProjectTempo: boolean;
  banks: BankSettings[];
  name: string;
}

export function parseProjectSettings(p: Uint8Array): ProjectSettings {
  const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
  const w = (n: number) => dv.getUint32(3 + n * 4, true);
  const banks: BankSettings[] = [];
  for (let b = 0; b < 10; b++) {
    const word = w(12 + b);
    const vol = (w(23 + (b >> 1)) >>> (b & 1 ? 16 : 0)) & 0xffff;
    banks.push({ letter: BANKS[b], protected: !!(word & 1), tempoX100: (word >>> 1) & 0xffff, volume: 127 - vol });
  }
  return {
    project: p[1],
    projectTempoX100: w(0) & 0xffff,
    useProjectTempo: !!((w(0) >>> 16) & 1),
    banks,
    name: new TextDecoder("latin1").decode(p.subarray(115, 147)).replace(/[\0 ]+$/, ""),
  };
}

const NAME_AT = 175;
const NAME_LEN = 24;
export const PAD_WRITE_LEN = 199;

export interface PadBlock {
  index: number;
  size: number; // SMP file size, 0 = empty pad
  startByte: number;
  endByte: number;
  level: number;
  gate: boolean;
  loop: boolean;
  bpmSync: boolean;
  bpmX100: number;
  flags: number;
  oneShot: boolean;
  /** VARI MODE (time-stretch algorithm with Vinyl off): bits 1–2 of the flags, see VARI_MODES. */
  vari: number;
  pitchCoarse: number;
  pitchFine: number;
  timeStretchX100: number;
  vinyl: boolean;
  name: string;
  raw: Uint8Array;
}

export function parsePadBlock(p: Uint8Array): PadBlock {
  const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
  const f = (n: number) => dv.getUint32(3 + n * 4, true);
  const nameBytes = p.subarray(NAME_AT, NAME_AT + NAME_LEN);
  const end = nameBytes.indexOf(0);
  return {
    index: dv.getUint16(1, true),
    size: f(0),
    startByte: f(1),
    endByte: f(2),
    level: f(3),
    gate: f(4) !== 0,
    loop: f(5) !== 0,
    bpmSync: f(8) !== 0,
    bpmX100: f(9),
    flags: f(10),
    oneShot: (f(10) & 32) !== 0,
    vari: (f(10) & VARI_MASK) >> 1,
    pitchCoarse: dv.getInt32(3 + 13 * 4, true),
    pitchFine: dv.getInt32(3 + 14 * 4, true),
    timeStretchX100: f(16),
    vinyl: f(17) !== 0,
    name: new TextDecoder("latin1").decode(nameBytes.subarray(0, end < 0 ? NAME_LEN : end)).trimEnd(),
    raw: p.slice(),
  };
}

/** Name bytes as the device keeps them: printable ASCII, at most 23, NUL-padded. */
export const sanitizeName = (name: string): Uint8Array =>
  Uint8Array.from([...name].map((c) => c.charCodeAt(0)).filter((c) => c >= 0x20 && c < 0x7f).slice(0, NAME_LEN - 1));

/**
 * The block the host writes back after an import: the current block with size, start, end,
 * loop top and name replaced. Verified byte-for-byte against the official app (report §0).
 */
export function assignSampleBlock(block: PadBlock, fileSize: number, name: string): Uint8Array {
  const p = block.raw.slice(0, PAD_WRITE_LEN);
  const dv = new DataView(p.buffer);
  const set = (n: number, v: number) => dv.setUint32(3 + n * 4, v, true);
  set(0, fileSize);
  set(1, 512);
  set(2, fileSize);
  set(11, 512);
  p.fill(0, NAME_AT, NAME_AT + NAME_LEN);
  p.set(sanitizeName(name), NAME_AT);
  return p;
}

export function setParamPayload(id: number, target: number, value: number): Uint8Array {
  const p = new Uint8Array(9);
  const dv = new DataView(p.buffer);
  p[0] = 0x01;
  p[1] = id;
  dv.setUint16(3, target, true);
  dv.setInt32(5, value, true);
  return p;
}

export const PARAM_START = 0x67; // sample frame (the block stores a byte offset)
export const PARAM_END = 0x68;
export const PARAM_LEVEL = 0x69;
export const PARAM_GATE = 0x6a;
export const PARAM_LOOP = 0x6b;
export const PARAM_BPM_SYNC = 0x6e;
export const PARAM_BPM = 0x6f;
export const PARAM_FLAGS = 0x70;
/** Meaning unknown; the official app sends 0 here when One Shot is turned on. */
export const PARAM_CLEARED_BY_ONE_SHOT = 0x72;
export const PARAM_PITCH_COARSE = 0x73; // semitones; the official app edits it only with Vinyl off
export const PARAM_PITCH_FINE = 0x74; // cents
export const PARAM_TIME_STRETCH = 0x76; // percent × 100
export const PARAM_VINYL = 0x77;
export const PITCH_COARSE_MAX = 12;
export const PITCH_FINE_MAX = 100;
export const STRETCH_MIN_X100 = 5000;
export const STRETCH_MAX_X100 = 15000;
export const FLAG_ONE_SHOT = 32;
/** VARI MODE in the flags (checked on the unit): 0 Off, 2 Backing (bit 1), 4 Ensemble (bit 2). */
export const VARI_MASK = 0x06;
export const VARI_MODES = ["Off", "Backing", "Ensemble"] as const;
export const BPM_MIN_X100 = 4000;
export const BPM_MAX_X100 = 20000;
export const LEVEL_MAX = 127;

/** Per-pad parameters the client may set, with the values it may send (inclusive). */
export const PAD_PARAM_RANGE: ReadonlyMap<number, readonly [number, number]> = new Map<number, readonly [number, number]>([
  [PARAM_START, [0, 0x7fffffff]],
  [PARAM_END, [1, 0x7fffffff]],
  [PARAM_LEVEL, [0, LEVEL_MAX]],
  [PARAM_GATE, [0, 1]],
  [PARAM_LOOP, [0, 1]],
  [PARAM_BPM_SYNC, [0, 1]],
  [PARAM_BPM, [BPM_MIN_X100, BPM_MAX_X100]],
  [PARAM_FLAGS, [0, 0xff]],
  [PARAM_CLEARED_BY_ONE_SHOT, [0, 0]],
  [PARAM_PITCH_COARSE, [-PITCH_COARSE_MAX, PITCH_COARSE_MAX]],
  [PARAM_PITCH_FINE, [-PITCH_FINE_MAX, PITCH_FINE_MAX]],
  [PARAM_TIME_STRETCH, [STRETCH_MIN_X100, STRETCH_MAX_X100]],
  [PARAM_VINYL, [0, 1]],
]);

export const GLOBAL = 0xffff; // set-parameter target for project-wide parameters
export const PARAM_PROJECT_TEMPO = 0x0a;
/** 0 = each bank plays at its own tempo, 1 = the project tempo applies to all banks. */
export const PARAM_TEMPO_SELECT = 0x0b;
export const PARAM_BANK_TEMPO = 0x21; // + bank (0..9)

/** Global parameters the client may set, with the values it may send (inclusive). Bank protect and volume are not here. */
export const GLOBAL_PARAM_RANGE: ReadonlyMap<number, readonly [number, number]> = new Map<number, readonly [number, number]>([
  [PARAM_PROJECT_TEMPO, [BPM_MIN_X100, BPM_MAX_X100]],
  [PARAM_TEMPO_SELECT, [0, 1]],
  ...Array.from({ length: 10 }, (_, b) => [PARAM_BANK_TEMPO + b, [BPM_MIN_X100, BPM_MAX_X100]] as const),
]);

/** Block byte offset ↔ sample frame (SMP header is 512 bytes, 16-bit PCM). */
export const byteToFrame = (byte: number, channels: number): number => Math.max(0, (byte - 512) / (2 * channels));
export const frameToByte = (frame: number, channels: number): number => 512 + frame * 2 * channels;

/** Message table the official app uses for `32 code:i32` device errors, in its order (SparkyMK2 control.rs). */
const ERRORS = [
  "Success", "Error", "Media Full", "Media Protect", "Media Error", "Unsupported Format", "Media Unformatted",
  "Media Damaged", "Media Ejected", "Media Busy", "Too Long Rec", "Invalid Format", "Invalid Path", "Cancelled",
  "Not Found", "Open Error", "Read Error", "Write Error", "Duplicate Name", "Not Found Empty Pad", "Invalid Filename",
  "Already Installed", "Update Wave Info Error", "Update Exp Info Error", "Exp Check Wave Error", "Exp Check Exp Error",
  "Exp Slot Full", "Memory Full", "Memory Fragmentation", "Hash Check Error", "Error", "Too Short Sample",
  "License Error", "Too Long Sample", "Kbd Sample Full", "No Chop Points", "BPM Detect Error", "KEY Detect Error",
  "BANK Protected", "One or more BANK Protected", "Some IMPORT errors", "Error", "Import Error", "Sampling Error",
  "BPM Detect Error", "Process Completed",
];
/** −128..−90 index the table at `code + 130`; −1 is a generic error. */
export const deviceErrorText = (code: number): string =>
  code >= -128 && code <= -90 ? ERRORS[code + 130] : code === -1 ? "Error" : `code ${code}`;
