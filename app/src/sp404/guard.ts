// Last line of defence: every outgoing message passes through a guard. Read traffic and preview are
// always allowed; writes are limited to the import sequence for the one pad being imported and to
// the per-pad parameters in PAD_PARAM_RANGE (Start, End, Level, Gate, Loop, BPM Sync, BPM, flags)
// and the tempos in GLOBAL_PARAM_RANGE (project, banks, tempo select).
// Init (92), delete (91 … 00 00), move (95), renames, mkdir/rmdir/rename on the card can never
// leave the page.

import { CH_CONTROL, CH_FILE, hex } from "./frame";
import { GLOBAL_PARAM_RANGE, PAD_PARAM_RANGE, PAD_WRITE_LEN, PAD_COUNT } from "./control";
import { describeFileRequest, O_CREAT_TRUNC_RDWR, O_RDONLY, Op, remotePath, samplePath } from "./fileApi";

export interface WritePolicy {
  /** 1-based project the current import writes into; set by the device for the length of one import. */
  importProject: number | null;
  importPad: number | null;
  writableHandles: Set<number>;
}

export type Guard = (channel: number, payload: Uint8Array) => void;

const READ_CONTROL = new Set([0xfe, 0xfd, 0x9e, 0x3a]);
const READ_FILE_OPS = new Set<number>([Op.Close, Op.Read, Op.OpenDir, Op.CloseDir, Op.ReadDir, Op.Stat, Op.FStat, Op.FreeKb]);

export class GuardError extends Error {}

export function makeGuard(policy: WritePolicy): Guard {
  return (channel, p) => {
    const pad = p.length >= 3 ? p[1] | (p[2] << 8) : -1;
    if (channel === CH_CONTROL) {
      const c = p[0];
      if (READ_CONTROL.has(c)) return;
      if (c === 0x8e && p.length === 5 && pad < PAD_COUNT) return; // preview start
      if (c === 0x8f && p.length === 4 && p[3] === 0x00 && pad < PAD_COUNT) return; // preview stop
      if (c === 0x01 && p.length === 9 && p[2] === 0 && (p[3] | (p[4] << 8)) < PAD_COUNT) {
        // Set a per-pad parameter: only the ids and values in PAD_PARAM_RANGE.
        const range = PAD_PARAM_RANGE.get(p[1]);
        const value = new DataView(p.buffer, p.byteOffset).getInt32(5, true);
        if (range && value >= range[0] && value <= range[1]) return;
      }
      if (c === 0x01 && p.length === 9 && p[2] === 0 && p[3] === 0xff && p[4] === 0xff) {
        // Project and bank tempos, tempo select: only the ids and values in GLOBAL_PARAM_RANGE.
        const range = GLOBAL_PARAM_RANGE.get(p[1]);
        const value = new DataView(p.buffer, p.byteOffset).getInt32(5, true);
        if (range && value >= range[0] && value <= range[1]) return;
      }
      // Select bank / pad on the unit (global 00 / 01): UI state only, the official app sends it on every click.
      if (c === 0x01 && p.length === 9 && p[2] === 0 && p[3] === 0xff && p[4] === 0xff && p[6] === 0 && p[7] === 0 && p[8] === 0 &&
        ((p[1] === 0x00 && p[5] < 10) || (p[1] === 0x01 && p[5] < 16))) return;
      const importing = policy.importPad !== null && pad === policy.importPad;
      if (c === 0xfb && p[1] === 0xa0 && p[2] === 0x00 && policy.importPad !== null) return; // import begin
      if (c === 0xfc && p[1] === 0x00 && p[2] === 0x00) return; // edit end
      if (c === 0x9d && p.length === 1) return; // stop
      if (importing && c === 0x91 && p.length === 5 && p[3] === 0x01 && p[4] === 0x00) return; // release slot, not delete
      if (importing && c === 0x1e && p.length === PAD_WRITE_LEN) return; // pad block write
      if (importing && c === 0x9f && p.length === 3) return; // commit
    }
    if (channel === CH_FILE && p[3] === 0x03) {
      const r = describeFileRequest(p);
      if (READ_FILE_OPS.has(r.op) || (r.op === Op.Open && r.first.i32 === O_RDONLY)) return;
      if (policy.importPad !== null && policy.importProject !== null) {
        const smp = remotePath(samplePath(policy.importProject, policy.importPad));
        const tmp = remotePath(samplePath(policy.importProject, policy.importPad, "TMP"));
        if (r.op === Op.Open && r.first.i32 === O_CREAT_TRUNC_RDWR && r.path === smp) return;
        if (r.op === Op.Unlink && (r.path === smp || r.path === tmp)) return;
        if ((r.op === Op.Write || r.op === Op.Seek) && policy.writableHandles.has(r.first.i32)) return;
      }
    }
    throw new GuardError(`заблокировано защитой: ch${channel} ${hex(p, 12)}`);
  };
}
