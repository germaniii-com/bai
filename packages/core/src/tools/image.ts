import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  coerceMediaParams,
  normalizeTags,
  type Asset,
  type AssetId,
  type AttachmentRef,
  type Job,
  type JobId,
  type MediaAssetRef,
  type MediaCapabilitiesResponse,
  type MediaGenConfig,
  type MediaGenRequest,
  type MediaParamValue,
  type SessionId,
} from "@bai/shared";
import type { Tool, ToolContext, ToolResult } from "./registry";
import { fileExists, notFoundError, recordWrite, resolveInRoots, withFileMutationQueue } from "./fs-guard";
import { IMAGE_MAX_BYTES, mediaFromName } from "../attachments";

/** Everything the image tool needs from the composition root. */
export interface ImageToolDeps {
  /** Enqueue an image generation job (the media queue). */
  enqueue(kind: "image.generate", sessionId: SessionId | undefined, input: unknown): Job;
  /** Await a job's terminal status (aborts resolve with the current row). */
  waitFor(jobId: JobId, signal?: AbortSignal): Promise<Job | undefined>;
  cancel(jobId: JobId): void;
  /** Resolved adapter model list + param vocab for a provider/model. */
  capabilities(provider?: string, model?: string): Promise<MediaCapabilitiesResponse>;
  /** config imageGen — the provider/account/model/params/tags defaults. */
  defaults(): MediaGenConfig | undefined;
  /** Read a stored asset's bytes (generated + reference assets). */
  readAsset(id: AssetId | string): { mime: string; bytes: Uint8Array } | undefined;
  /** Store reference bytes as an asset (returns the durable ref). */
  saveAsset(bytes: Uint8Array, name: string, mime: string): AttachmentRef;
  /** Assets produced by a job, in creation order. */
  assetsByJob(jobId: JobId): Asset[];
  /** Registered workspace roots (reference/save_to path scope). */
  roots(): string[];
}

/**
 * image.generate — the agent-facing image workbench call. Text-to-image from a
 * prompt, or image-to-image from a reference (a stored asset id or an image
 * file in the session workspace). Uses the Image Generation settings defaults
 * (provider/account/model + default params/tags) and enqueues a real media job,
 * waiting for it to finish. `save_to` also copies the results into the
 * workspace. Permission is fail-closed (unmatched → ask).
 */
export function imageGenerateTool(deps: ImageToolDeps): Tool {
  return {
    name: "image.generate",
    origin: "builtin",
    description:
      "Generate an image from a text prompt (text-to-image) or transform a reference image (image-to-image). " +
      "Uses the configured image provider/model and default parameters unless overridden. Returns the generated " +
      "image assets (shown in the Image gallery); pass `save_to` to also write the files into the workspace.",
    schema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "What to generate — a detailed visual description." },
        workflow: {
          type: "string",
          enum: ["t2i", "i2i"],
          description: "t2i (text-to-image, default) or i2i (image-to-image; requires `reference`).",
        },
        reference: {
          type: "string",
          description: "For i2i: an image asset id (ast_…) or a path to an image file in the session workspace.",
        },
        model: { type: "string", description: "Optional model id override (else the configured default)." },
        params: {
          type: "object",
          additionalProperties: { type: ["string", "number", "boolean"] },
          description: "Provider parameters (aspect_ratio, resolution, quality, output_format, seed, …). Defaults apply.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Tags for the generated images (default tags from settings are added).",
        },
        count: { type: "integer", minimum: 1, description: "How many images (clamped to the model's max)." },
        save_to: {
          type: "string",
          description: "Optional directory in the session workspace to also write the generated files into.",
        },
      },
      required: ["prompt"],
    },
    async execute(rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
      const args = parseArgs(rawArgs);
      const cfg = deps.defaults();
      const mode = args.workflow ?? "t2i";

      // --- reference (i2i) ---
      const referenceAssetIds: string[] = [];
      if (mode === "i2i") {
        if (args.reference === undefined || args.reference.trim().length === 0) {
          throw new Error("image-to-image needs `reference`: an image asset id (ast_…) or a workspace image file path.");
        }
        referenceAssetIds.push(resolveReference(args.reference.trim(), ctx, deps));
      }

      // --- defaults + capability coercion ---
      const model = args.model !== undefined && args.model.trim().length > 0 ? args.model.trim() : cfg?.model;
      const caps = await deps.capabilities(cfg?.provider, model);
      const params = coerceMediaParams(caps.capabilities.params, {
        ...(cfg?.params ?? {}),
        ...(args.params ?? {}),
      });
      if (args.count !== undefined) {
        params.count = clampInt(Math.round(args.count), 1, Math.max(1, caps.capabilities.maxCount));
      }
      const tags = normalizeTags([...(cfg?.tags ?? []), ...(args.tags ?? [])]);

      const request: MediaGenRequest = {
        mode,
        prompt: args.prompt,
        ...(caps.model.length > 0 ? { model: caps.model } : {}),
        ...(Object.keys(params).length > 0 ? { params } : {}),
        ...(referenceAssetIds.length > 0 ? { referenceAssetIds } : {}),
        ...(tags.length > 0 ? { tags } : {}),
      };

      // --- run the media job and await it ---
      const job = deps.enqueue("image.generate", ctx.sessionId, request);
      const done = await deps.waitFor(job.id, ctx.signal);
      if (ctx.signal.aborted) {
        deps.cancel(job.id);
        throw new Error("Image generation cancelled (run interrupted).");
      }
      if (done === undefined) throw new Error("Image generation job disappeared before completing.");
      if (done.status === "cancelled") throw new Error("Image generation was cancelled.");
      if (done.status !== "done") throw new Error(`Image generation failed: ${done.error ?? "unknown error"}`);

      const assets = deps.assetsByJob(job.id);
      if (assets.length === 0) throw new Error("Image generation produced no images.");

      // --- optional: copy into the workspace (snapshot-covered) ---
      const written = args.save_to !== undefined && args.save_to.trim().length > 0
        ? await writeToWorkspace(args.save_to.trim(), args.prompt, assets, ctx, deps)
        : [];

      const refs = assets.map(assetRef);
      return {
        content: renderSummary(request, assets, written),
        meta: {
          title: `Generated ${assets.length} image${assets.length === 1 ? "" : "s"}`,
          assets: refs,
          jobId: job.id,
          model: caps.model,
          provider: caps.provider,
          ...(written.length > 0 ? { savedTo: written } : {}),
        },
      };
    },
  };
}

interface ImageToolArgs {
  prompt: string;
  workflow?: "t2i" | "i2i";
  reference?: string;
  model?: string;
  params?: Record<string, MediaParamValue>;
  tags?: string[];
  count?: number;
  save_to?: string;
}

function parseArgs(raw: unknown): ImageToolArgs {
  const obj = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  if (typeof obj.prompt !== "string" || obj.prompt.trim().length === 0) {
    throw new Error("`prompt` is required — describe the image you want.");
  }
  const workflow = obj.workflow === "i2i" ? "i2i" : obj.workflow === "t2i" ? "t2i" : undefined;
  const params: Record<string, MediaParamValue> = {};
  if (typeof obj.params === "object" && obj.params !== null) {
    for (const [key, value] of Object.entries(obj.params as Record<string, unknown>)) {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") params[key] = value;
    }
  }
  return {
    prompt: obj.prompt.trim(),
    ...(workflow !== undefined ? { workflow } : {}),
    ...(typeof obj.reference === "string" ? { reference: obj.reference } : {}),
    ...(typeof obj.model === "string" ? { model: obj.model } : {}),
    ...(Object.keys(params).length > 0 ? { params } : {}),
    ...(Array.isArray(obj.tags) ? { tags: obj.tags.filter((t): t is string => typeof t === "string") } : {}),
    ...(typeof obj.count === "number" && Number.isFinite(obj.count) ? { count: obj.count } : {}),
    ...(typeof obj.save_to === "string" ? { save_to: obj.save_to } : {}),
  };
}

/** Resolve an i2i reference to a stored asset id (asset id or workspace file). */
function resolveReference(reference: string, ctx: ToolContext, deps: ImageToolDeps): string {
  if (reference.startsWith("ast_")) {
    if (deps.readAsset(reference) === undefined) throw new Error(`Unknown image asset: ${reference}`);
    return reference;
  }
  const abs = resolveInRoots(ctx, deps.roots(), reference);
  if (!fileExists(abs)) throw notFoundError(abs);
  const media = mediaFromName(path.basename(abs));
  if (media === undefined || media.kind !== "image") {
    throw new Error(`Reference is not a supported image (PNG, JPG, GIF, WebP): ${abs}`);
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(readFileSync(abs));
  } catch (err) {
    throw new Error(`Could not read reference image: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (bytes.byteLength > IMAGE_MAX_BYTES) {
    throw new Error(`Reference image is too large (max 10 MB): ${abs}`);
  }
  return deps.saveAsset(bytes, path.basename(abs), media.mime).id;
}

/** Copy generated assets into a workspace directory (atomic per file). */
async function writeToWorkspace(
  saveTo: string,
  prompt: string,
  assets: Asset[],
  ctx: ToolContext,
  deps: ImageToolDeps,
): Promise<string[]> {
  const dir = resolveInRoots(ctx, deps.roots(), saveTo);
  mkdirSync(dir, { recursive: true });
  const slug = slugify(prompt);
  const written: string[] = [];
  let n = 0;
  for (const asset of assets) {
    n += 1;
    const target = path.join(dir, `${slug}-${n}.${extForMime(asset.mime)}`);
    const data = deps.readAsset(asset.id);
    if (data === undefined) continue;
    await withFileMutationQueue(target, () => {
      writeFileSync(target, data.bytes);
      recordWrite(target);
    });
    written.push(target);
  }
  return written;
}

function renderSummary(request: MediaGenRequest, assets: Asset[], written: string[]): string {
  const header = `Generated ${assets.length} image${assets.length === 1 ? "" : "s"} (${request.mode.toUpperCase()}${
    request.model !== undefined ? ` · ${request.model}` : ""
  }).`;
  const lines = assets.map((asset) => {
    const w = typeof asset.meta.width === "number" ? asset.meta.width : undefined;
    const h = typeof asset.meta.height === "number" ? asset.meta.height : undefined;
    const dims = w !== undefined && h !== undefined ? ` (${w}×${h})` : "";
    return `- ${asset.id}${dims} — ${asset.path}`;
  });
  const saved = written.length > 0 ? `\nWrote ${written.length} file(s) to the workspace:\n${written.map((p) => `- ${p}`).join("\n")}` : "";
  return `${header}\n${lines.join("\n")}${saved}`;
}

function assetRef(asset: Asset): MediaAssetRef {
  const width = typeof asset.meta.width === "number" ? asset.meta.width : undefined;
  const height = typeof asset.meta.height === "number" ? asset.meta.height : undefined;
  const prompt = typeof asset.meta.prompt === "string" && asset.meta.prompt.length > 0 ? asset.meta.prompt : undefined;
  return {
    id: asset.id,
    name: prompt !== undefined ? (prompt.length > 60 ? `${prompt.slice(0, 60)}…` : prompt) : asset.id.slice(-6),
    mime: asset.mime,
    bytes: asset.bytes,
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
  };
}

function extForMime(mime: string): string {
  switch (mime) {
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/svg+xml":
      return "svg";
    case "image/gif":
      return "gif";
    default:
      return "png";
  }
}

function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug.length > 0 ? slug : "image";
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
