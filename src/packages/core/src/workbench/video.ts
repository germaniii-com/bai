import type { Workbench } from "../workbench/types";
import type { GeneratedFile, JobExecutor, JobExecutorResult } from "../workbench/types";

export interface VideoGenRequest {
  prompt: string;
  model?: string;
  durationSeconds?: number;
  resolution?: string;
}

/**
 * Video-generation modality — structured stub in Phase 0. Mirrors the image
 * workbench's pipeline exactly; produces a tiny placeholder clip so the
 * queue/gallery/events path is exercisable before any vendor key exists.
 * Real adapters (Veo/Runway/Kling/Luma/Seedance via fal.ai first) land in
 * Phase 5+.
 */
export class VideoWorkbench implements Workbench {
  name() {
    return "video" as const;
  }

  label() {
    return "Video";
  }

  tools() {
    return [];
  }

  jobTypes() {
    return ["video.generate" as const];
  }

  assetKinds() {
    return ["video" as const];
  }

  jobExecutors() {
    const executor: JobExecutor = async (job, ctx) => {
      const req = parseRequest(job.input);
      ctx.progress(0.25);
      if (ctx.signal.aborted) throw new Error("cancelled");
      ctx.progress(0.75);
      // Placeholder clip: a small deterministic descriptor file. Honest about
      // being a stub via meta.placeholder — galleries render the poster path.
      const descriptor = JSON.stringify({
        placeholder: true,
        prompt: req.prompt,
        model: req.model ?? "stub",
        durationSeconds: req.durationSeconds ?? 4,
        resolution: req.resolution ?? "640x360",
      });
      const files: GeneratedFile[] = [
        {
          kind: "video",
          mime: "video/mp4",
          ext: "mp4",
          bytes: new TextEncoder().encode(descriptor),
          meta: { prompt: req.prompt, model: req.model ?? "stub", placeholder: true },
        },
      ];
      const result: JobExecutorResult = { output: { model: req.model ?? "stub" }, files };
      return result;
    };
    return { "video.generate": executor };
  }

  routes() {
    return [];
  }
}

function parseRequest(input: unknown): VideoGenRequest {
  const obj = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  return {
    prompt: typeof obj.prompt === "string" ? obj.prompt : "placeholder",
    ...(typeof obj.model === "string" ? { model: obj.model } : {}),
    ...(typeof obj.durationSeconds === "number" ? { durationSeconds: obj.durationSeconds } : {}),
    ...(typeof obj.resolution === "string" ? { resolution: obj.resolution } : {}),
  };
}
