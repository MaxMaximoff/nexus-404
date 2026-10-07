import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CH_CONTROL, CH_FILE, FileReq, FrameDecoder, O_CREAT_TRUNC_RDWR, SP404Device, assignSampleBlock, bpmFromFileName,
  padSpeed, computePeaks, computeEnvelope, findSound, ENVELOPE_BLOCK, encodeLong, encodeShort, makeGuard, md5, parseBpmInput, parseFileReply, parsePadBlock, parseSmpHeader,
  samplePath, septDec, septEnc, smpHeader, buildSmp, SampleUploader, newJob, type ImportJob, smpToPcm, deviceErrorText, frameToByte, remotePath, type SP404Transport,
} from "./index";

const hex = (a: ArrayLike<number>) => Buffer.from(Uint8Array.from(a)).toString("hex");

describe("framing (SparkyMK2 frame.rs vectors)", () => {
  it("encodes the status poll", () => {
    expect(hex(encodeShort(CH_CONTROL, [0xfe, 0x66, 0x00]))).toBe("1260e005fe66000000000003");
  });
  it("decodes messages split across chunks", () => {
    const a = encodeShort(CH_CONTROL, [0xfe, 0x66, 0x00]);
    const b = encodeLong(CH_FILE, [0xf0, 0x41, 0x7a, 0x03, 0xf7]);
    const stream = new Uint8Array([0x00, 0xff, ...a, ...b]);
    const dec = new FrameDecoder();
    for (let i = 0; i < stream.length; i += 7) dec.push(stream.subarray(i, i + 7));
    const msgs = [...dec.messages()];
    expect(msgs).toHaveLength(2);
    expect(hex(msgs[0].payload)).toBe("fe6600");
    expect(hex(msgs[1].payload)).toBe("f0417a03f7");
  });
});

describe("septets (SparkyMK2 septet.rs vectors)", () => {
  it("encodes", () => {
    expect(septEnc(-1)).toEqual([0x7f, 0x7f, 0x7f, 0x7f, 0x7f]);
    expect(septEnc(512)).toEqual([0, 0, 0, 4, 0]);
    expect(septEnc(0x8043cde8 | 0)).toEqual([0x78, 0x02, 0x0f, 0x1b, 0x68]);
    expect(septEnc(512, 0x40)).toEqual([0x40, 0, 0, 4, 0]);
  });
  it("decodes the last-chunk flag", () => {
    const d = septDec(Uint8Array.from([0x40, 0, 0, 4, 0]), 0);
    expect(d.u32).toBe(512);
    expect(d.high & 4).toBe(4);
  });
  it("parses replies seen on the device", () => {
    // stat reply for A1 (log 2026-10-06): mode 0x81FF, size 77312
    const r = parseFileReply(Buffer.from("f0417a02000000000040000000 08ff8100 00002e0100f7".replace(/ /g, ""), "hex"));
    expect(r.kind).toBe("data");
    if (r.kind === "data") expect(new DataView(r.data.buffer, r.data.byteOffset).getUint32(4, true)).toBe(77312);
    expect(parseFileReply(Buffer.from("f0417a7a7f7f7f7f7f0000000002f7", "hex"))).toEqual({ kind: "status", result: -1, extra: 2 });
  });
});

describe("md5 and SMP", () => {
  it("matches node's md5", () => {
    for (const s of ["", "abc", "x".repeat(55), "y".repeat(56), "z".repeat(1000)])
      expect(hex(md5(new TextEncoder().encode(s)))).toBe(createHash("md5").update(s).digest("hex"));
  });
  it("builds the same header as a device-made SMP", () => {
    // A1 of project 1: 76800 PCM bytes, stereo; digest read from the device.
    const h = smpHeader(76800, 2);
    expect(hex(h.subarray(0, 0x30))).toBe("5246575600012df80000bb800000000200000010" + "00".repeat(12) + "0cc41f95af031d3b46f9eb5574cfc887");
    expect(parseSmpHeader(h)).toMatchObject({ pcmBytes: 76800, channels: 2, rate: 48000, bits: 16, digestOk: true });
  });
  it("round-trips PCM big-endian", () => {
    const pcm = Int16Array.from([0, 1, -1, 32767, -32768, 1234]);
    const back = smpToPcm(buildSmp(pcm, 2))!;
    expect(Array.from(back.samples)).toEqual(Array.from(pcm));
    expect(back.channels).toBe(2);
  });
});

describe("pad block", () => {
  it("assigns a sample like the official app (report §0)", () => {
    const raw = new Uint8Array(327);
    raw[0] = 0x1e; raw[1] = 34;
    const dv = new DataView(raw.buffer);
    dv.setUint32(3 + 3 * 4, 127, true); dv.setUint32(3 + 4 * 4, 1, true); dv.setUint32(3 + 9 * 4, 9000, true);
    const w = assignSampleBlock(parsePadBlock(raw), 480512, "loop_96bpm_44k_mono_and_more");
    expect(w.length).toBe(199);
    const b = parsePadBlock(new Uint8Array([...w, ...new Uint8Array(128)]));
    expect(b).toMatchObject({ size: 480512, startByte: 512, endByte: 480512, level: 127, gate: true, bpmX100: 9000, name: "loop_96bpm_44k_mono_and" });
    expect(new DataView(w.buffer).getUint32(3 + 11 * 4, true)).toBe(512);
  });
});

describe("guard", () => {
  const policy = { importProject: 4, importPad: 33, writableHandles: new Set([100]) };
  const g = makeGuard(policy);
  const allowed: [number, ArrayLike<number>][] = [
    [CH_CONTROL, [0xfe, 0x66, 0]], [CH_CONTROL, [0x9e, 5, 0]], [CH_CONTROL, [0x9a, 0, 0]], [CH_CONTROL, [0x9a, 15, 0]], [CH_CONTROL, [0x8e, 5, 0, 0x7f, 0xff]], [CH_CONTROL, [0x8f, 5, 0, 0]],
    [CH_CONTROL, [0xfb, 0xa0, 0]], [CH_CONTROL, [0x91, 33, 0, 1, 0]], [CH_CONTROL, [0x9d]], [CH_CONTROL, [0x9f, 33, 0]],
    [CH_CONTROL, [1, 0x6f, 0, 7, 0, 0xe0, 0x2e, 0, 0]],
    [CH_CONTROL, [1, 0x69, 0, 159, 0, 127, 0, 0, 0]], [CH_CONTROL, [1, 0x6a, 0, 33, 0, 1, 0, 0, 0]], [CH_CONTROL, [1, 0x6b, 0, 33, 0, 0, 0, 0, 0]],
    [CH_CONTROL, [1, 0x70, 0, 33, 0, 0x24, 0, 0, 0]], [CH_CONTROL, [1, 0x72, 0, 33, 0, 0, 0, 0, 0]],
    [CH_CONTROL, [1, 0x6e, 0, 33, 0, 1, 0, 0, 0]],
    [CH_CONTROL, [1, 0x73, 0, 33, 0, 0xf4, 0xff, 0xff, 0xff]], [CH_CONTROL, [1, 0x74, 0, 33, 0, 100, 0, 0, 0]], // −12 st, +100 ct
    [CH_CONTROL, [1, 0x76, 0, 33, 0, 0x88, 0x13, 0, 0]], [CH_CONTROL, [1, 0x77, 0, 33, 0, 0, 0, 0, 0]], // 50 %, Vinyl off
    [CH_CONTROL, [1, 0x67, 0, 33, 0, 0xe8, 0x03, 0, 0]], [CH_CONTROL, [1, 0x68, 0, 33, 0, 0, 0x77, 0x01, 0]],
    [CH_CONTROL, [1, 0x00, 0, 0xff, 0xff, 9, 0, 0, 0]], [CH_CONTROL, [1, 0x01, 0, 0xff, 0xff, 15, 0, 0, 0]],
    [CH_CONTROL, [1, 0x0a, 0, 0xff, 0xff, 0x40, 0x1f, 0, 0]], [CH_CONTROL, [1, 0x0b, 0, 0xff, 0xff, 1, 0, 0, 0]],
    [CH_CONTROL, [1, 0x21, 0, 0xff, 0xff, 0xa0, 0x0f, 0, 0]], [CH_CONTROL, [1, 0x2a, 0, 0xff, 0xff, 0x20, 0x4e, 0, 0]],
    [CH_FILE, FileReq.open(samplePath(4, 33), O_CREAT_TRUNC_RDWR)], [CH_FILE, FileReq.unlink(samplePath(4, 33, "TMP"))],
    [CH_FILE, FileReq.write(100, new Uint8Array(8), true)], [CH_FILE, FileReq.seek(100, 0)], [CH_FILE, FileReq.stat("x")],
  ];
  const blocked: [number, ArrayLike<number>][] = [
    [CH_CONTROL, [0x92, 0, 0, 0, 0, 0, 0]], [CH_CONTROL, [0x91, 33, 0, 0, 0]], [CH_CONTROL, [0x91, 34, 0, 1, 0]],
    [CH_CONTROL, [0x95, 0, 0, 1, 0, 0, 0]], [CH_CONTROL, [0x35, 3, 65]], [CH_CONTROL, [0x02, 33, 0, 65]],
    [CH_CONTROL, [0x9a, 16, 0]], [CH_CONTROL, [0x9a, 1, 1]], [CH_CONTROL, [0x9a, 1]], [CH_CONTROL, [0xb1, 3, 0]],
    // per-pad parameters: unknown ids, values out of range, a pad past J16
    [CH_CONTROL, [1, 0x6d, 0, 33, 0, 1, 0, 0, 0]], [CH_CONTROL, [1, 0x6e, 0, 33, 0, 2, 0, 0, 0]], [CH_CONTROL, [1, 0x75, 0, 33, 0, 1, 0, 0, 0]],
    [CH_CONTROL, [1, 0x73, 0, 33, 0, 13, 0, 0, 0]], [CH_CONTROL, [1, 0x74, 0, 33, 0, 0x9b, 0xff, 0xff, 0xff]], // +13 st, −101 ct
    [CH_CONTROL, [1, 0x76, 0, 33, 0, 0x87, 0x13, 0, 0]], [CH_CONTROL, [1, 0x76, 0, 33, 0, 0x99, 0x3a, 0, 0]], // 49.99 %, 150.01 %
    [CH_CONTROL, [1, 0x77, 0, 33, 0, 2, 0, 0, 0]], [CH_CONTROL, [1, 0x8e, 0, 33, 0, 0, 0, 0, 0]],
    [CH_CONTROL, [1, 0x69, 0, 33, 0, 128, 0, 0, 0]], [CH_CONTROL, [1, 0x6a, 0, 33, 0, 2, 0, 0, 0]], [CH_CONTROL, [1, 0x72, 0, 33, 0, 1, 0, 0, 0]],
    [CH_CONTROL, [1, 0x70, 0, 33, 0, 0, 1, 0, 0]], [CH_CONTROL, [1, 0x67, 0, 33, 0, 0xff, 0xff, 0xff, 0xff]], [CH_CONTROL, [1, 0x68, 0, 33, 0, 0, 0, 0, 0]],
    [CH_CONTROL, [1, 0x6f, 0, 33, 0, 0x9f, 0x0f, 0, 0]], [CH_CONTROL, [1, 0x6f, 0, 33, 0, 0x21, 0x4e, 0, 0]], // 39.99, 200.01
    [CH_CONTROL, [1, 0x69, 0, 160, 0, 1, 0, 0, 0]],
    [CH_CONTROL, [1, 0x69, 1, 33, 0, 1, 0, 0, 0]],
    [CH_CONTROL, [1, 0x00, 0, 0xff, 0xff, 10, 0, 0, 0]],
    // global parameters: tempos out of range, bank 11, bank volume, tempo id aimed at a pad
    [CH_CONTROL, [1, 0x0a, 0, 0xff, 0xff, 0x9f, 0x0f, 0, 0]], [CH_CONTROL, [1, 0x0b, 0, 0xff, 0xff, 2, 0, 0, 0]],
    [CH_CONTROL, [1, 0x21, 0, 0xff, 0xff, 0x30, 0x75, 0, 0]], [CH_CONTROL, [1, 0x2b, 0, 0xff, 0xff, 0x40, 0x1f, 0, 0]],
    [CH_CONTROL, [1, 0x35, 0, 0xff, 0xff, 0, 0, 0, 0]], [CH_CONTROL, [1, 0x0a, 0, 33, 0, 0x40, 0x1f, 0, 0]],
    [CH_CONTROL, [1, 0x17, 0, 0xff, 0xff, 1, 0, 0, 0]],
    [CH_FILE, FileReq.open(samplePath(4, 34), O_CREAT_TRUNC_RDWR)], [CH_FILE, FileReq.open(samplePath(1, 33), O_CREAT_TRUNC_RDWR)],
    [CH_FILE, FileReq.unlink("ROLAND/SP-404MKII/PROJECT_04/PADCONF.BIN")], [CH_FILE, FileReq.write(101, new Uint8Array(4), true)],
  ];
  it.each(allowed)("allows ch%i %o", (c, p) => expect(() => g(c, Uint8Array.from(p))).not.toThrow());
  it.each(blocked)("blocks ch%i %o", (c, p) => expect(() => g(c, Uint8Array.from(p))).toThrow());
  it("blocks import traffic when no import is running", () => {
    const idle = makeGuard({ importProject: null, importPad: null, writableHandles: new Set() });
    expect(() => idle(CH_CONTROL, Uint8Array.from([0xfb, 0xa0, 0]))).toThrow();
    expect(() => idle(CH_CONTROL, Uint8Array.from([0x9f, 33, 0]))).toThrow();
  });
});

describe("device against a scripted SP", () => {
  /** A fake SP that answers the import sequence the way the real one did (log 2026-10-06). */
  function fakeSp() {
    const files = new Map<string, Uint8Array>();
    let open: { path: string; pos: number } | null = null;
    const sent: string[] = [];
    const params: [number, number, number][] = []; // per-pad set-parameter: id, pad, value
    const globals = new Map<number, number>([[0x0a, 9000], [0x0b, 0], ...Array.from({ length: 10 }, (_, b) => [0x21 + b, 9000] as [number, number])]);
    let blocks = new Map<number, Uint8Array>();
    const t: SP404Transport = {
      async open() {}, async close() {}, onBytes: () => {}, onLost: () => {},
      async write(bytes) {
        const dec = new FrameDecoder();
        dec.push(bytes);
        for (const m of dec.messages()) queueMicrotask(() => answer(m.channel, m.payload));
      },
    };
    const reply = (ch: number, p: ArrayLike<number>) => t.onBytes(p.length <= 7 ? encodeShort(ch, p) : encodeLong(ch, p));
    const status = (r: number) => reply(CH_FILE, [0xf0, 0x41, 0x7a, 0x7a, ...septEnc(r), ...septEnc(0), 0xf7]);
    const block = (pad: number) => blocks.get(pad) ?? Uint8Array.from([0x1e, pad, 0, ...new Uint8Array(324)]);
    function answer(ch: number, p: Uint8Array) {
      sent.push(`${ch}:${hex(p.subarray(0, 5))}`);
      if (ch === CH_CONTROL) {
        if (p[0] === 0xfe) reply(ch, [0x7e, 3, 0, 2, 0, 1, 0, 0, 0xff, 0xff, 0xff, 0xff, 0, 2, 1, 0, 0, 0x0b, 0x33]);
        else if (p[0] === 0x9e) reply(ch, block(p[1]));
        else if (p[0] === 0xfd) {
          const s = new Uint8Array(147), dv = new DataView(s.buffer);
          s.set([0x7d, p[1], 0]);
          dv.setUint32(3, globals.get(0x0a)! | (globals.get(0x0b)! << 16), true);
          for (let b = 0; b < 10; b++) dv.setUint32(3 + (12 + b) * 4, globals.get(0x21 + b)! << 1, true);
          reply(ch, s);
          for (let n = 0; n < 16; n++) reply(ch, [0x35, n, ...new TextEncoder().encode(`PROJECT_${n + 1}`)]);
        }
        else if (p[0] === 0x8e) reply(ch, [0x0e, p[1], p[2], 0]);
        else if (p[0] === 0x8f) reply(ch, [0x0f, p[1], p[2], 0]);
        else if (p[0] === 0x91) reply(ch, [0x11, 0]);
        else if (p[0] === 0x9a) reply(ch, [0x1a, 0]);
        else if (p[0] === 0x9d) reply(ch, [0x1d, 0]);
        else if (p[0] === 0x1e) { blocks.set(p[1], Uint8Array.from([...p, ...new Uint8Array(128)])); reply(ch, [0x1e, 0]); }
        else if (p[0] === 0x9f) reply(ch, [0x1f, p[1], p[2], 0]);
        else if (p[0] === 0x01) {
          const dv = new DataView(p.buffer, p.byteOffset), pad = dv.getUint16(3, true), v = dv.getInt32(5, true);
          if (pad === 0xffff) globals.set(p[1], v);
          else {
            params.push([p[1], pad, v]);
            const b = block(pad), bv = new DataView(b.buffer);
            const ch = parseSmpHeader(files.get(remotePath(samplePath(4, pad))) ?? null)?.channels ?? 2;
            if (p[1] === 0x67 || p[1] === 0x68) bv.setUint32(3 + (p[1] - 0x66) * 4, frameToByte(v, ch), true);
            else if (p[1] >= 0x69 && p[1] <= 0x7b) bv.setUint32(3 + (p[1] - 0x66) * 4, v, true);
            blocks.set(pad, b);
          }
          reply(ch, p);
        }
        return;
      }
      const op = p[4], first = septDec(p, 5).i32, second = septDec(p, 10);
      const path = new TextDecoder().decode(p.subarray(15, p.length - 2));
      if (op === 0x0a) status(files.delete(path) ? 0 : -1);
      else if (op === 0x00) { if (first === O_CREAT_TRUNC_RDWR) files.set(path, new Uint8Array(0)); if (!files.has(path)) return status(-1); open = { path, pos: 0 }; status(0x114); }
      else if (op === 0x07) { open!.pos = second.i32; status(second.i32); }
      else if (op === 0x06) {
        const len = second.u32, data = p.subarray(15, 15 + len), f = files.get(open!.path)!;
        const n = new Uint8Array(Math.max(f.length, open!.pos + len)); n.set(f); n.set(data, open!.pos);
        files.set(open!.path, n); open!.pos += len;
        if (second.high & 4) { const done = (globalThis as any).__batch + len; (globalThis as any).__batch = 0; status(done); } else (globalThis as any).__batch = ((globalThis as any).__batch ?? 0) + len;
      } else if (op === 0x03) status(0);
      else if (op === 0x12) {
        const f = files.get(path);
        if (!f) return status(-1);
        const d = new Uint8Array(8); new DataView(d.buffer).setUint32(0, 0x81ff, true); new DataView(d.buffer).setUint32(4, f.length, true);
        reply(CH_FILE, [0xf0, 0x41, 0x7a, 0x02, ...septEnc(0), ...septEnc(8, 0x40), ...d, 0xf7]);
      } else if (op === 0x04) {
        const f = files.get(open!.path)!, d = f.subarray(open!.pos, open!.pos + second.u32); open!.pos += d.length;
        reply(CH_FILE, [0xf0, 0x41, 0x7a, 0x02, ...septEnc(first), ...septEnc(d.length, 0x40), ...d, 0xf7]);
      }
    }
    const setField = (pad: number, field: number, v: number) => {
      const b = block(pad);
      new DataView(b.buffer).setUint32(3 + field * 4, v, true);
      blocks.set(pad, b);
    };
    return { t, files, sent, params, setField, globals };
  }

  it("imports into an empty pad and the device ends up with the exact SMP and block", async () => {
    const sp = fakeSp();
    const dev = new SP404Device(sp.t);
    const pcm = new Int16Array(48000 * 2 * 3).map((_, i) => (i * 37) % 30000 - 15000); // 3 s stereo, > 1 batch
    const smp = buildSmp(pcm, 2);
    const progress: number[] = [];
    const block = await dev.exclusive((d) => d.importSmp(4, 33, smp, "test-sample", (a, b) => progress.push(a / b)));
    expect(hex(sp.files.get("/SP404REMOTE///ROLAND/SP-404MKII/PROJECT_04/SMPL/BANK3-02.SMP")!)).toBe(hex(smp));
    expect(block).toMatchObject({ size: smp.length, startByte: 512, endByte: smp.length, name: "test-sample" });
    expect(progress.at(-1)).toBe(1);
    expect(sp.sent[0]).toBe("5:fe6600"); // checked the current project first
    expect(dev.policy.importPad).toBeNull();
  });
  it("refuses a pad that is not empty, without writing anything", async () => {
    const sp = fakeSp();
    const dev = new SP404Device(sp.t);
    await dev.exclusive((d) => d.importSmp(4, 33, buildSmp(new Int16Array(4), 2), "a"));
    const before = sp.sent.length;
    await expect(dev.exclusive((d) => d.importSmp(4, 33, buildSmp(new Int16Array(4), 2), "b"))).rejects.toThrow(/занят/);
    expect(sp.sent.slice(before).map((s) => s.slice(0, 4))).toEqual(["5:fe", "5:9e"]);
  });
  it("refuses a project that is not current", async () => {
    const dev = new SP404Device(fakeSp().t);
    await expect(dev.exclusive((d) => d.importSmp(1, 33, buildSmp(new Int16Array(4), 2), "a"))).rejects.toThrow(/проект 4/);
  });
  /** SP with a 1 s stereo sample (48 000 frames) imported on C2. */
  /** A 48 kHz/16-bit stereo WAV of clicks, `seconds` long. */
  function clickWav(name: string, bpm: number, seconds: number): File {
    const frames = Math.round(seconds * 48000), pcm = new Int16Array(frames * 2);
    for (let t = 0; t < seconds; t += 60 / bpm)
      for (let i = 0, at = Math.round(t * 48000); i < 960 && at + i < frames; i++) pcm[2 * (at + i)] = pcm[2 * (at + i) + 1] = Math.round(Math.sin(i * 0.9) * 20000 * Math.exp(-i / 150));
    const head = new DataView(new ArrayBuffer(44));
    [..."RIFF"].forEach((c, i) => head.setUint8(i, c.charCodeAt(0)));
    head.setUint32(4, 36 + pcm.byteLength, true);
    [..."WAVEfmt "].forEach((c, i) => head.setUint8(8 + i, c.charCodeAt(0)));
    head.setUint32(16, 16, true); head.setUint16(20, 1, true); head.setUint16(22, 2, true);
    head.setUint32(24, 48000, true); head.setUint32(28, 48000 * 4, true); head.setUint16(32, 4, true); head.setUint16(34, 16, true);
    [..."data"].forEach((c, i) => head.setUint8(36 + i, c.charCodeAt(0)));
    head.setUint32(40, pcm.byteLength, true);
    return new File([head.buffer, pcm.buffer], name, { type: "audio/wav" });
  }
  it("imports with BPM from the name, else detected, else from the field", async () => {
    const sp = fakeSp();
    const dev = new SP404Device(sp.t);
    const seen: ImportJob[] = [];
    const up = new SampleUploader(dev, { onJob: (j) => seen.push(j), onPad: () => {} }, () => {});
    const jobs = [
      newJob(clickWav("a_96bpm.wav", 120, 4), 33, 9600, 9000, 80), // the name wins
      newJob(clickWav("b.wav", 120, 4), 34, null, 9000, 80), // detected: 8 beats in 4 s
      newJob(new File([clickWav("c.wav", 120, 4)], "c.wav"), 35, null, 9000, null), // detection off: the field
    ];
    jobs.push(newJob(clickWav("d.wav", 0.001, 4), 36, null, 9000, 80)); // one click, no beat: the field
    expect(await up.run(4, jobs)).toBe(4);
    expect(sp.params.filter(([id]) => id === 0x6f)).toEqual([[0x6f, 33, 9600], [0x6f, 34, 12000], [0x6f, 35, 9000], [0x6f, 36, 9000]]);
    expect(jobs.map((j) => j.bpmFrom)).toEqual(["name", "detected", "field", "field"]);
  });

  async function loaded() {
    const sp = fakeSp();
    const dev = new SP404Device(sp.t);
    await dev.exclusive((d) => d.importSmp(4, 33, buildSmp(new Int16Array(48000 * 2), 2), "s"));
    return { sp, dev };
  }

  it("sets Level, Gate, Loop and BPM Sync and returns the block as re-read", async () => {
    const { sp, dev } = await loaded();
    expect((await dev.exclusive((d) => d.setLevel(4, 33, 90))).level).toBe(90);
    expect((await dev.exclusive((d) => d.setGate(4, 33, true))).gate).toBe(true);
    expect((await dev.exclusive((d) => d.setLoop(4, 33, true))).loop).toBe(true);
    expect((await dev.exclusive((d) => d.setBpmSync(4, 33, true))).bpmSync).toBe(true);
    expect(sp.params).toEqual([[0x69, 33, 90], [0x6a, 33, 1], [0x6b, 33, 1], [0x6e, 33, 1]]);
    await expect(dev.exclusive((d) => d.setLevel(4, 33, 128))).rejects.toThrow(/Level/);
  });
  it("sets Vinyl, Time Stretch and Pitch, sending only what changed", async () => {
    const { sp, dev } = await loaded();
    expect((await dev.exclusive((d) => d.setVinyl(4, 33, true))).vinyl).toBe(true);
    expect((await dev.exclusive((d) => d.setTimeStretch(4, 33, 7550))).timeStretchX100).toBe(7550);
    let b = await dev.exclusive((d) => d.setPitch(4, 33, -12, 0));
    expect(b).toMatchObject({ pitchCoarse: -12, pitchFine: 0 });
    b = await dev.exclusive((d) => d.setPitch(4, 33, -12, -35));
    expect(b).toMatchObject({ pitchCoarse: -12, pitchFine: -35 });
    expect(sp.params).toEqual([[0x77, 33, 1], [0x76, 33, 7550], [0x73, 33, -12], [0x74, 33, -35]]);
    await expect(dev.exclusive((d) => d.setPitch(4, 33, 13, 0))).rejects.toThrow(/полутоны/);
    await expect(dev.exclusive((d) => d.setTimeStretch(4, 33, 16000))).rejects.toThrow(/150/);
  });
  it("turns One Shot on like the official app, keeping the other flag bits", async () => {
    const { sp, dev } = await loaded();
    sp.setField(33, 10, 0x05); // flags: bits 0 and 2 already set
    const b = await dev.exclusive((d) => d.setOneShot(4, 33, true));
    expect(sp.params).toEqual([[0x70, 33, 0x25], [0x6a, 33, 0], [0x6b, 33, 0], [0x72, 33, 0]]);
    expect(b).toMatchObject({ oneShot: true, flags: 0x25, gate: false, loop: false });
    sp.params.length = 0;
    await dev.exclusive((d) => d.setOneShot(4, 33, true)); // already on: no side effects again
    await dev.exclusive((d) => d.setOneShot(4, 33, false));
    expect(sp.params).toEqual([[0x70, 33, 0x25], [0x70, 33, 0x05]]);
  });
  it("sets VARI MODE in flag bits 1–2, keeping the other bits", async () => {
    const { sp, dev } = await loaded();
    sp.setField(33, 10, 0x21); // One Shot and Fixed Velocity
    expect(await dev.exclusive((d) => d.setVari(4, 33, 1))).toMatchObject({ vari: 1, flags: 0x23, oneShot: true });
    expect(await dev.exclusive((d) => d.setVari(4, 33, 2))).toMatchObject({ vari: 2, flags: 0x25 });
    expect(await dev.exclusive((d) => d.setVari(4, 33, 0))).toMatchObject({ vari: 0, flags: 0x21 });
    expect(sp.params).toEqual([[0x70, 33, 0x23], [0x70, 33, 0x25], [0x70, 33, 0x21]]);
    await expect(dev.exclusive((d) => d.setVari(4, 33, 3))).rejects.toThrow(/VARI/);
  });
  it("stops a pad playing with Gate off: Gate on, press and release, Gate back off", async () => {
    const { sp, dev } = await loaded();
    sp.setField(33, 4, 0); // Gate off
    const before = sp.sent.length;
    const b = await dev.exclusive((d) => d.stopPad(4, 33));
    expect(b.gate).toBe(false);
    expect(sp.params).toEqual([[0x6a, 33, 1], [0x6a, 33, 0]]);
    expect(sp.sent.slice(before).filter((m) => /^5:(016a|8e|8f)/.test(m)).map((m) => m.slice(0, 4)))
      .toEqual(["5:01", "5:8e", "5:8f", "5:01"]);
    sp.params.length = 0;
    sp.setField(33, 4, 1); // Gate on: a release alone
    await dev.exclusive((d) => d.stopPad(4, 33));
    expect(sp.params).toEqual([]);
    expect(sp.sent.at(-2)?.slice(0, 4)).toBe("5:8f");
  });
  it("selects another project, and nothing when it is already current", async () => {
    const sp = fakeSp();
    const dev = new SP404Device(sp.t);
    await dev.exclusive((d) => d.selectProject(4)); // the fake SP is on project 4
    await dev.exclusive((d) => d.selectProject(9));
    expect(sp.sent.filter((m) => m.startsWith("5:9a"))).toEqual(["5:9a0800"]);
    await expect(dev.exclusive((d) => d.selectProject(17))).rejects.toThrow(/нет проекта/);
  });
  it("moves Start/End in frames, in an order that keeps Start < End", async () => {
    const { sp, dev } = await loaded();
    let b = await dev.exclusive((d) => d.setRange(4, 33, 1000, 2000));
    expect(b).toMatchObject({ startByte: 512 + 1000 * 4, endByte: 512 + 2000 * 4 });
    b = await dev.exclusive((d) => d.setRange(4, 33, 3000, 48000)); // Start past the old End: End goes first
    expect(b).toMatchObject({ startByte: 512 + 3000 * 4, endByte: 512 + 48000 * 4 });
    await dev.exclusive((d) => d.setRange(4, 33, 0, 48000)); // only Start changed
    expect(sp.params).toEqual([[0x67, 33, 1000], [0x68, 33, 2000], [0x68, 33, 48000], [0x67, 33, 3000], [0x67, 33, 0]]);
  });
  it("sets project and bank tempos and tempo select, returning the settings as re-read", async () => {
    const sp = fakeSp();
    const dev = new SP404Device(sp.t);
    expect((await dev.exclusive((d) => d.setProjectTempo(4, 9350))).projectTempoX100).toBe(9350);
    const ps = await dev.exclusive((d) => d.setBankTempo(4, 2, 14000));
    expect(ps.banks.map((b) => b.tempoX100)).toEqual([9000, 9000, 14000, 9000, 9000, 9000, 9000, 9000, 9000, 9000]);
    expect(ps.names[3]).toBe("PROJECT_4");
    expect((await dev.exclusive((d) => d.setTempoSelect(4, true))).useProjectTempo).toBe(true);
    expect(sp.sent.filter((s) => s.startsWith("5:01")).map((s) => s.slice(0, 6))).toEqual(["5:010a", "5:0123", "5:010b"]); // bank C = 21 + 2
    await expect(dev.exclusive((d) => d.setBankTempo(4, 2, 30000))).rejects.toThrow(/40 до 200/);
    await expect(dev.exclusive((d) => d.setProjectTempo(1, 12000))).rejects.toThrow(/проект 4/);
    expect(sp.globals.get(0x0a)).toBe(9350);
  });
  it("refuses a bad range or an empty pad without sending a parameter", async () => {
    const { sp, dev } = await loaded();
    await expect(dev.exclusive((d) => d.setRange(4, 33, 0, 48001))).rejects.toThrow(/48000/);
    await expect(dev.exclusive((d) => d.setRange(4, 33, 500, 500))).rejects.toThrow(/Start/);
    await expect(dev.exclusive((d) => d.setGate(4, 34, true))).rejects.toThrow(/C3 пуст/);
    await expect(dev.exclusive((d) => d.setGate(1, 33, true))).rejects.toThrow(/проект 4/);
    expect(sp.params).toEqual([]);
  });
});

describe("helpers", () => {
  it("reads BPM from file names", () => {
    expect(bpmFromFileName("loop_96bpm_44k_mono.wav")).toBe(9600);
    expect(bpmFromFileName("Drums 120 BPM.wav")).toBe(12000);
    expect(bpmFromFileName("beat-93.5bpm.flac")).toBe(9350);
    expect(bpmFromFileName("kick_01.wav")).toBeNull();
    expect(bpmFromFileName("x_300bpm.wav")).toBeNull();
  });
  it("parses typed BPM", () => {
    expect(parseBpmInput("120")).toEqual({ x100: 12000 });
    expect(parseBpmInput("93,25")).toEqual({ x100: 9325 });
    expect(parseBpmInput("12a")).toHaveProperty("error");
    expect(parseBpmInput("250")).toHaveProperty("error");
    expect(parseBpmInput("")).toBeNull();
  });
  it("computes peaks per channel", () => {
    const p = computePeaks(Int16Array.from([0, 0, 16384, -16384, -32768, 32767, 0, 0]), 2, 2);
    expect(p).toHaveLength(2);
    expect(p[0][0]).toBeCloseTo(0); expect(p[0][1]).toBeCloseTo(0.5, 2);
    expect(p[1][0]).toBeCloseTo(-0.5, 2); expect(p[1][3]).toBeCloseTo(1, 2);
  });
  it("finds the sound between silent edges, rounding outwards to whole blocks", () => {
    const frames = 1000, pcm = new Int16Array(frames * 2);
    pcm[2 * 100] = 20; // −64 dBFS: below a −48 dB threshold
    pcm[2 * 130 + 1] = 1000; // −30 dBFS, right channel, frame 130
    pcm[2 * 900] = -2000; // frame 900
    const env = computeEnvelope(pcm, 2);
    expect(env).toHaveLength(Math.ceil(frames / ENVELOPE_BLOCK));
    expect(findSound(env, frames, -48)).toEqual({ start: 128, end: 928 });
    expect(findSound(env, frames, -70)).toEqual({ start: 96, end: 928 });
    expect(findSound(env, frames, -20)).toBeNull();
    const tail = new Int16Array(frames); tail[frames - 1] = 30000; // mono, sound in the last frame
    expect(findSound(computeEnvelope(tail, 1), frames, -48)).toEqual({ start: 992, end: 1000 });
  });
  it("works out the speed the SP plays a pad at (F7 on the unit: 93.2 BPM)", () => {
    const f7 = { bpmSync: true, bpmX100: 9320, timeStretchX100: 10000, vinyl: true, pitchCoarse: 0, pitchFine: 0 };
    expect(padSpeed(f7, 13900)).toMatchObject({ source: "sync", fold: 0 }); // 1.49: still faster
    expect(padSpeed(f7, 13900).ratio).toBeCloseTo(1.491, 3);
    expect(padSpeed(f7, 14000)).toMatchObject({ fold: 1, syncedBpmX100: 18640 }); // 1.502 → slower
    expect(padSpeed(f7, 14000).ratio).toBeCloseTo(0.751, 3);
    expect(padSpeed(f7, 4700)).toMatchObject({ fold: 0 });
    expect(padSpeed(f7, 4600)).toMatchObject({ fold: -1, syncedBpmX100: 4660 }); // 0.494 → faster
    expect(padSpeed(f7, 12000).pitchSt).toBeCloseTo(12 * Math.log2(120 / 93.2), 6); // Vinyl: pitch follows speed
    expect(padSpeed({ ...f7, vinyl: false, pitchCoarse: -3, pitchFine: 25 }, 12000).pitchSt).toBeCloseTo(-2.75, 6);
    expect(padSpeed({ ...f7, bpmSync: false, timeStretchX100: 5000 }, 14000)).toMatchObject({ source: "stretch", ratio: 0.5, fold: 0 });
  });
  it("maps device error codes like the official app", () => {
    expect(deviceErrorText(-119)).toBe("Invalid Format");
    expect(deviceErrorText(-111)).toBe("Not Found Empty Pad");
    expect(deviceErrorText(-92)).toBe("BANK Protected");
  });
});
