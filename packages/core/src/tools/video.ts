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
  type MediaGenConfig,
  type MediaParamValue,
  type SessionId,
  type VideoCapabilitiesResponse,
  type VideoGenRequest,
  type VideoInput,
  type VideoRole,
  type VideoWorkflow,
} from "@bai/shared";
import type { Tool, ToolContext, ToolResult } from "./registry";
import { fileExists, notFoundError, recordWrite, resolveInRoots, withFileMutationQueue } from "./fs-guard";

/** Everything the video tool needs from the composition root. */
export interface VideoToolDeps {
  enqueue(kind: "video.generate", sessionId: SessionId | undefined, input: unknown): Job;
  waitFor(jobId: JobId, signal?: AbortSignal): Promise<Job | undefined>;
  cancel(jobId: JobId): void;
  capabilities(provider?: string, model?: string): Promise<VideoCapabilitiesResponse>;
  defaults(): MediaGenConfig | undefined;
  readAsset(id: AssetId | string): { mime: string; bytes: Uint8Array } | undefined;
  saveAsset(bytes: Uint8Array, name: string, mime: string): AttachmentRef;
  assetsByJob(jobId: JobId): Asset[];
  roots(): string[];
}

const REFERENCE_MAX_BYTES = 100 * 1024 * 1024;

const EXT_KIND: Record<string, { kind: "image" | "video" | "audio"; mime: string }> = {
  png: { kind: "image", mime: "image/png" },
  jpg: { kind: "image", mime: "image/jpeg" },
  jpeg: { kind: "image", mime: "image/jpeg" },
  webp: { kind: "image", mime: "image/webp" },
  gif: { kind: "image", mime: "image/gif" },
  mp4: { kind: "video", mime: "video/mp4" },
  mov: { kind: "video", mime: "video/quicktime" },
  webm: { kind: "video", mime: "video/webm" },
  mkv: { kind: "video", mime: "video/x-matroska" },
  mp3: { kind: "audio", mime: "audio/mpeg" },
  wav: { kind: "audio", mime: "audio/wav" },
  m4a: { kind: "audio", mime: "audio/mp4" },
  ogg: { kind: "audio", mime: "audio/ogg" },
};

/**
 * video.generate — the agent-facing video workbench call. Names a workflow
 * (t2v/i2v/flf2v/ref2v/v2v/extend/upscale/motion/lipsync/reframe) plus
 * role-tagged references: first/last frames and reference images/videos/audio
 * as stored asset ids, workspace file paths, or hosted URLs. Uses the Video
 * Generation settings defaults and enqueues a real media job, waiting for it.
 * `save_to` also copies the results into the workspace. Permission is
 * fail-closed (unmatched → ask).
 */
export function videoGenerateTool(deps: VideoToolDeps): Tool {
  return {
    name: "video.generate",
    origin: "builtin",
    description:
      "Generate or transform a video. Pick a workflow: t2v (text), i2v (first frame), flf2v (first + last frame), " +
      "ref2v (reference images), v2v (edit a source video), extend, upscale, motion, lipsync, or reframe. " +
      "References are stored asset ids (ast_…), workspace file paths, or hosted URLs. Returns the generated video " +
      "assets (shown in the Video gallery); pass `save_to` to also write the files into the workspace.",
    schema: {
      type: "object",
      properties: {
        workflow: {
          type: "string",
          enum: ["t2v", "i2v", "flf2v", "ref2v", "v2v", "extend", "upscale", "motion", "lipsync", "reframe"],
          description:
            "t2v | i2v | flf2v | ref2v | v2v | extend | upscale | motion | lipsync | reframe. Inferred when omitted.",
        },
        prompt: { type: "string", description: "What to generate — a detailed description (omit for pure upscale)." },
        first_frame: { type: "string", description: "First-frame image (asset id, workspace path, or URL)." },
        last_frame: { type: "string", description: "Last-frame image (asset id, workspace path, or URL)." },
        reference_images: { type: "array", items: { type: "string" }, description: "Reference images (subject/style)." },
        reference_videos: { type: "array", items: { type: "string" }, description: "Reference videos (motion/style)." },
        reference_audio: { type: "string", description: "Reference audio (voice/music)." },
        source_video: { type: "string", description: "Source video for v2v/extend/upscale (asset id, path, or URL)." },
        model: { type: "string", description: "Optional model id override (else the configured default)." },
        params: {
          type: "object",
          additionalProperties: { type: ["string", "number", "boolean", "array"] },
          description: "Provider parameters (duration, resolution, aspect_ratio, seed, shots, …). Defaults apply.",
        },
        tags: { type: "array", items: { type: "string" }, description: "Tags for the generated videos." },
        save_to: {
          type: "string",
          description: "Optional directory in the session workspace to also write the generated files into.",
        },
      },
      required: [],
    },
    async execute(rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
      const args = parseArgs(rawArgs);
      const cfg = deps.defaults();
      const workflow = args.workflow ?? inferWorkflow(args);

      const inputs: VideoInput[] = [];
      const add = (role: VideoRole, value: string | undefined): void => {
        if (value === undefined || value.trim().length === 0) return;
        inputs.push(resolveInput(role, value.trim(), ctx, deps));
      };
      add("first_frame", args.first_frame);
      add("last_frame", args.last_frame);
      add("source_video", args.source_video);
      add("reference_audio", args.reference_audio);
      for (const ref of args.reference_images ?? []) add("reference_image", ref);
      for (const ref of args.reference_videos ?? []) add("reference_video", ref);

      const model = args.model !== undefined && args.model.trim().length > 0 ? args.model.trim() : cfg?.model;
      const caps = await deps.capabilities(cfg?.provider, model);
      const spec = caps.capabilities.workflows.find((w) => w.id === workflow);
      const params = coerceMediaParams(
        [...caps.capabilities.params, ...(spec?.params ?? [])],
        { ...(cfg?.params ?? {}), ...(args.params ?? {}) },
      );
      const tags = normalizeTags([...(cfg?.tags ?? []), ...(args.tags ?? [])]);

      const request: VideoGenRequest = {
        workflow,
        prompt: args.prompt,
        ...(caps.model.length > 0 ? { model: caps.model } : {}),
        ...(Object.keys(params).length > 0 ? { params } : {}),
        ...(inputs.length > 0 ? { inputs } : {}),
        ...(tags.length > 0 ? { tags } : {}),
      };

      const job = deps.enqueue("video.generate", ctx.sessionId, request);
      const done = await deps.waitFor(job.id, ctx.signal);
      if (ctx.signal.aborted) {
        deps.cancel(job.id);
        throw new Error("Video generation cancelled (run interrupted).");
      }
      if (done === undefined) throw new Error("Video generation job disappeared before completing.");
      if (done.status === "cancelled") throw new Error("Video generation was cancelled.");
      if (done.status !== "done") throw new Error(`Video generation failed: ${done.error ?? "unknown error"}`);

      const assets = deps.assetsByJob(job.id);
      if (assets.length === 0) throw new Error("Video generation produced no videos.");

      const written =
        args.save_to !== undefined && args.save_to.trim().length > 0
          ? await writeToWorkspace(args.save_to.trim(), args.prompt, assets, ctx, deps)
          : [];

      const refs = assets.map(assetRef);
      return {
        content: renderSummary(request, assets, written),
        meta: {
          title: `Generated ${assets.length} video${assets.length === 1 ? "" : "s"}`,
          assets: refs,
          jobId: job.id,
          model: caps.model,
          provider: caps.provider,
          workflow,
          ...(written.length > 0 ? { savedTo: written } : {}),
        },
      };
    },
  };
}

interface VideoToolArgs {
  workflow?: VideoWorkflow;
  prompt: string;
  first_frame?: string;
  last_frame?: string;
  reference_images?: string[];
  reference_videos?: string[];
  reference_audio?: string;
  source_video?: string;
  model?: string;
  params?: Record<string, MediaParamValue>;
  tags?: string[];
  save_to?: string;
}

function parseArgs(raw: unknown): VideoToolArgs {
  const obj = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const params: Record<string, MediaParamValue> = {};
  if (typeof obj.params === "object" && obj.params !== null) {
    for (const [key, value] of Object.entries(obj.params as Record<string, unknown>)) {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") params[key] = value;
      else if (Array.isArray(value) && value.every((v) => typeof v === "string")) params[key] = value as string[];
    }
  }
  const strList = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : undefined;
  return {
    ...(typeof obj.workflow === "string" ? { workflow: obj.workflow as VideoWorkflow } : {}),
    prompt: typeof obj.prompt === "string" ? obj.prompt.trim() : "",
    ...(typeof obj.first_frame === "string" ? { first_frame: obj.first_frame } : {}),
    ...(typeof obj.last_frame === "string" ? { last_frame: obj.last_frame } : {}),
    ...(strList(obj.reference_images) !== undefined ? { reference_images: strList(obj.reference_images) } : {}),
    ...(strList(obj.reference_videos) !== undefined ? { reference_videos: strList(obj.reference_videos) } : {}),
    ...(typeof obj.reference_audio === "string" ? { reference_audio: obj.reference_audio } : {}),
    ...(typeof obj.source_video === "string" ? { source_video: obj.source_video } : {}),
    ...(typeof obj.model === "string" ? { model: obj.model } : {}),
    ...(Object.keys(params).length > 0 ? { params } : {}),
    ...(Array.isArray(obj.tags) ? { tags: obj.tags.filter((t): t is string => typeof t === "string") } : {}),
    ...(typeof obj.save_to === "string" ? { save_to: obj.save_to } : {}),
  };
}

/** Infer the workflow from the supplied inputs when the caller omits it. */
function inferWorkflow(args: VideoToolArgs): VideoWorkflow {
  if (args.source_video !== undefined) return "v2v";
  if (args.first_frame !== undefined && args.last_frame !== undefined) return "flf2v";
  if (args.first_frame !== undefined) return "i2v";
  if ((args.reference_images?.length ?? 0) > 0) return "ref2v";
  if (args.reference_audio !== undefined) return "lipsync";
  return "t2v";
}

/** Resolve one reference to an asset id (stored), a workspace file, or a URL. */
function resolveInput(role: VideoRole, value: string, ctx: ToolContext, deps: VideoToolDeps): VideoInput {
  if (value.startsWith("http://") || value.startsWith("https://")) return { role, url: value };
  if (value.startsWith("ast_")) {
    if (deps.readAsset(value) === undefined) throw new Error(`Unknown media asset: ${value}`);
    return { role, assetId: value };
  }
  const abs = resolveInRoots(ctx, deps.roots(), value);
  if (!fileExists(abs)) throw notFoundError(abs);
  const name = path.basename(abs);
  const kind = kindForName(name);
  if (kind === undefined) {
    throw new Error(`Reference is not a supported image/video/audio file: ${abs}`);
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(readFileSync(abs));
  } catch (err) {
    throw new Error(`Could not read reference: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (bytes.byteLength > REFERENCE_MAX_BYTES) throw new Error(`Reference is too large (max 100 MB): ${abs}`);
  return { role, assetId: deps.saveAsset(bytes, name, kind.mime).id };
}

function kindForName(name: string): { kind: "image" | "video" | "audio"; mime: string } | undefined {
  const ext = name.toLowerCase().split(".").pop();
  return ext !== undefined ? EXT_KIND[ext] : undefined;
}

async function writeToWorkspace(
  saveTo: string,
  prompt: string,
  assets: Asset[],
  ctx: ToolContext,
  deps: VideoToolDeps,
): Promise<string[]> {
  const dir = resolveInRoots(ctx, deps.roots(), saveTo);
  mkdirSync(dir, { recursive: true });
  const slug = slugify(prompt.length > 0 ? prompt : "video");
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

function renderSummary(request: VideoGenRequest, assets: Asset[], written: string[]): string {
  const header = `Generated ${assets.length} video${assets.length === 1 ? "" : "s"} (${request.workflow.toUpperCase()}${
    request.model !== undefined ? ` · ${request.model}` : ""
  }).`;
  const lines = assets.map((asset) => {
    const duration = typeof asset.meta.durationSeconds === "number" ? ` ${Math.round(asset.meta.durationSeconds)}s` : "";
    return `- ${asset.id}${duration} — ${asset.path}`;
  });
  const saved =
    written.length > 0 ? `\nWrote ${written.length} file(s) to the workspace:\n${written.map((p) => `- ${p}`).join("\n")}` : "";
  return `${header}\n${lines.join("\n")}${saved}`;
}

function assetRef(asset: Asset): MediaAssetRef {
  const width = typeof asset.meta.width === "number" ? asset.meta.width : undefined;
  const height = typeof asset.meta.height === "number" ? asset.meta.height : undefined;
  const duration = typeof asset.meta.durationSeconds === "number" ? asset.meta.durationSeconds : undefined;
  const prompt = typeof asset.meta.prompt === "string" && asset.meta.prompt.length > 0 ? asset.meta.prompt : undefined;
  return {
    id: asset.id,
    name: prompt !== undefined ? (prompt.length > 60 ? `${prompt.slice(0, 60)}…` : prompt) : asset.id.slice(-6),
    mime: asset.mime,
    bytes: asset.bytes,
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    ...(duration !== undefined ? { durationSeconds: duration } : {}),
  };
}

function extForMime(mime: string): string {
  switch (mime) {
    case "video/webm":
      return "webm";
    case "video/quicktime":
      return "mov";
    case "video/x-matroska":
      return "mkv";
    default:
      return "mp4";
  }
}

function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug.length > 0 ? slug : "video";
}
