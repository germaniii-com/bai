import type { Workbench } from "../workbench/types";
import type { GeneratedFile, JobExecutor, JobExecutorResult } from "../workbench/types";
import { fnv1a, solidPng } from "../jobs/png";

export interface ImageGenRequest {
  prompt: string;
  model?: string;
  size?: string;
  count?: number;
}

/**
 * Image-generation modality — structured stub in Phase 0. The pipeline is
 * real: prompt → job row → executor → asset file + DB row → events →
 * galleries. The stub adapter renders a deterministic placeholder PNG; the
 * fal.ai adapter (Phase 5) plugs in behind the same interface.
 */
export class ImageWorkbench implements Workbench {
  name() {
    return "image" as const;
  }

  label() {
    return "Image";
  }

  tools() {
    return [];
  }

  jobTypes() {
    return ["image.generate" as const];
  }

  assetKinds() {
    return ["image" as const];
  }

  jobExecutors() {
    const executor: JobExecutor = async (job, ctx) => {
      const req = parseRequest(job.input);
      ctx.progress(0.1);
      const files: GeneratedFile[] = [];
      const count = Math.min(Math.max(req.count ?? 1, 1), 4);
      for (let i = 0; i < count; i++) {
        if (ctx.signal.aborted) throw new Error("cancelled");
        const seed = fnv1a(`${req.prompt}#${i}`);
        const rgb: [number, number, number] = [
          (seed & 0xff) as number,
          ((seed >> 8) & 0xff) as number,
          ((seed >> 16) & 0xff) as number,
        ];
        const [w, h] = parseSize(req.size);
        files.push({
          kind: "image",
          mime: "image/png",
          ext: "png",
          bytes: solidPng(w, h, rgb),
          meta: { prompt: req.prompt, model: req.model ?? "stub", seed, width: w, height: h, placeholder: true },
        });
        ctx.progress((i + 1) / count);
      }
      const result: JobExecutorResult = {
        output: { model: req.model ?? "stub", count: files.length },
        files,
      };
      return result;
    };
    return { "image.generate": executor };
  }

  routes() {
    return [];
  }
}

function parseRequest(input: unknown): ImageGenRequest {
  const obj = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  return {
    prompt: typeof obj.prompt === "string" ? obj.prompt : "placeholder",
    ...(typeof obj.model === "string" ? { model: obj.model } : {}),
    ...(typeof obj.size === "string" ? { size: obj.size } : {}),
    ...(typeof obj.count === "number" ? { count: obj.count } : {}),
  };
}

function parseSize(size?: string): [number, number] {
  const match = size?.match(/^(\d+)x(\d+)$/);
  if (!match) return [256, 256];
  const w = Number(match[1]);
  const h = Number(match[2]);
  return [Math.min(w, 1024), Math.min(h, 1024)];
}
