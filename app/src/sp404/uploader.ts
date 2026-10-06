// Import queue: decode → SMP → import into an empty pad → BPM → verify the header on the device.

import { decodeAudio, type DecodedAudio } from "./audio";
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
  state: JobState;
  progress: number; // 0..1
  message: string;
}

export interface UploaderHooks {
  onJob(job: ImportJob): void;
  onPad(block: PadBlock, audio: DecodedAudio): void;
}

let nextId = 1;
export const newJob = (file: File, pad: number, bpmX100: number | null): ImportJob =>
  ({ id: nextId++, file, pad, bpmX100, state: "queued", progress: 0, message: "в очереди" });

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
        update({ state: "decoding", message: "декодирование…" });
        const audio = await decodeAudio(job.file);
        const smp = buildSmp(audio.samples, audio.channels);
        this.log("info", `${label}: ${audio.note}, ${(audio.frames / 48000).toFixed(2)} с, ${(smp.length / 1048576).toFixed(2)} MB`);
        update({ state: "uploading", message: "передача…" });
        const t0 = performance.now();
        const block = await this.device.exclusive(async (d) => {
          let b = await d.importSmp(project1, job.pad, smp, sampleName(job.file.name), (done, total) =>
            update({ progress: done / total, message: `передача ${Math.round((done / total) * 100)} %` }));
          if (job.bpmX100 !== null) b = await d.setBpm(project1, job.pad, job.bpmX100);
          const head = parseSmpHeader(await d.readFile(samplePath(project1, job.pad), 512));
          if (!head?.digestOk || head.pcmBytes !== smp.length - 512) throw new Error("проверка заголовка на SP не прошла");
          return b;
        });
        const secs = (performance.now() - t0) / 1000;
        this.log("info", `${label}: готово за ${secs.toFixed(1)} с (${(smp.length / 1048576 / secs).toFixed(2)} MB/s)`);
        this.hooks.onPad(block, audio);
        update({ state: "done", progress: 1, message: "готово" });
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
