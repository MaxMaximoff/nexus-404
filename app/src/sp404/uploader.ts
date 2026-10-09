// Import queue: decode → SMP → import into an empty pad → BPM → verify the header on the device.

import { decodeAudio, type DecodedAudio } from "./audio";
import { detectBpm } from "./bpm";
import { padName, type PadBlock } from "./control";
import type { SP404Device, Logger } from "./device";
import { samplePath } from "./fileApi";
import { buildSmp, parseSmpHeader } from "./smp";

export type JobState = "queued" | "decoding" | "uploading" | "done" | "error";

export interface ImportJob {
  id: number;
  file: File;
  pad: number;
  bpmX100: number | null;
  /** Where the BPM came from; "detected" is filled in after decoding. */
  bpmFrom: "name" | "detected" | "field" | "source" | null;
  /** Detect the tempo when the file name has none: bottom of the range, and the BPM to use if no beat is found. */
  detect: { minBpm: number; fallbackX100: number | null } | null;
  state: JobState;
  progress: number; // 0..1
  message: string;
}

export interface UploaderHooks {
  onJob(job: ImportJob): void;
  onPad(block: PadBlock, audio: DecodedAudio): void;
}

let nextId = 1;
/**
 * A queued import. BPM: from the file name, else detected from the sound when `detect` is given,
 * else `fallbackX100` (the "BPM новых сэмплов" field), else left as the SP sets it.
 */
/** `fromName`: BPM × 100 known before decoding (from the file name, or `given` by the caller, e.g. a resample's source pad). */
export function newJob(file: File, pad: number, fromName: number | null, fallbackX100: number | null = null, detectMinBpm: number | null = null, given: "name" | "source" = "name"): ImportJob {
  const detect = fromName === null && detectMinBpm !== null ? { minBpm: detectMinBpm, fallbackX100 } : null;
  const bpmX100 = fromName ?? (detect ? null : fallbackX100);
  const bpmFrom = fromName !== null ? given : bpmX100 !== null ? "field" : null;
  return { id: nextId++, file, pad, bpmX100, bpmFrom, detect, state: "queued", progress: 0, message: "Queued" };
}

export const sampleName = (fileName: string): string => fileName.replace(/\.[^.]+$/, "");

export class SampleUploader {
  constructor(private readonly device: SP404Device, private readonly hooks: UploaderHooks, private readonly log: Logger) {}

  /** Run jobs one after another; a failed job does not stop the rest. Returns the number that succeeded. */
  async run(project1: number, jobs: ImportJob[]): Promise<number> {
    let ok = 0;
    for (const job of jobs) {
      const update = (patch: Partial<ImportJob>) => { Object.assign(job, patch); this.hooks.onJob({ ...job }); };
      const label = `${job.file.name} → ${padName(job.pad)}`;
      try {
        update({ state: "decoding", message: "Decoding…" });
        const audio = await decodeAudio(job.file);
        const smp = buildSmp(audio.samples, audio.channels);
        this.log("info", `${label}: ${audio.note}, ${(audio.frames / 48000).toFixed(2)} s, ${(smp.length / 1048576).toFixed(2)} MB`);
        if (job.detect) {
          update({ message: "Detecting BPM…" });
          await new Promise((r) => setTimeout(r, 0)); // let the message paint
          const r = detectBpm(audio.samples, audio.channels, job.detect.minBpm);
          const fb = job.detect.fallbackX100;
          update(r ? { bpmX100: r.x100, bpmFrom: "detected" } : { bpmX100: fb, bpmFrom: fb !== null ? "field" : null });
          this.log("info", `${label}: BPM ${r ? `Detected ${(r.x100 / 100).toFixed(2)}${r.beats ? `, loop ${r.beats} beats` : ""}, clarity ${r.clarity.toFixed(2)}`
            : `Not detected${fb !== null ? `, using ${(fb / 100).toFixed(2)} from the field` : ""}`}`);
        }
        update({ state: "uploading", message: "Uploading…" });
        const t0 = performance.now();
        const block = await this.device.exclusive(async (d) => {
          let b = await d.importSmp(project1, job.pad, smp, sampleName(job.file.name), (done, total) =>
            update({ progress: done / total, message: `Uploading ${Math.round((done / total) * 100)} %` }));
          if (job.bpmX100 !== null) b = await d.setBpm(project1, job.pad, job.bpmX100);
          const head = parseSmpHeader(await d.readFile(samplePath(project1, job.pad), 512));
          if (!head?.digestOk || head.pcmBytes !== smp.length - 512) throw new Error("Sample header verification on SP failed");
          return b;
        });
        const secs = (performance.now() - t0) / 1000;
        this.log("info", `${label}: completed in ${secs.toFixed(1)} s (${(smp.length / 1048576 / secs).toFixed(2)} MB/s)`);
        this.hooks.onPad(block, audio);
        update({ state: "done", progress: 1, message: "Done" });
        ok++;
      } catch (e) {
        const msg = (e as Error).message;
        this.log("error", `${label}: ${msg}`);
        update({ state: "error", message: msg });
      }
    }
    return ok;
  }
}
