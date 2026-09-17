import type {
  MediaGenConfig,
  MediaParamValue,
  VideoCapabilitiesResponse,
  VideoGenRequest,
  VideoInput,
  VideoProviderInfo,
  VideoRole,
  VideoWorkflow,
} from "@bai/shared";
import { isVideoRole, isVideoWorkflow, normalizeTags } from "@bai/shared";
import type { Workbench } from "../workbench/types";
import type { GeneratedFile, JobExecutor, JobExecutorResult } from "../workbench/types";
import { MediaGenError } from "./media/adapter";
import {
  buildVideoAdapters,
  unionWorkflows,
  videoProviderDef,
  videoProviderInfos,
  type VideoProviderDef,
} from "./media/video-registry";
import type { VideoGenAdapter } from "./media/video-adapter";
import { looksLikeVideo, videoProbe } from "./media/video-dimensions";
import type { MediaRuntimeDeps } from "./image";

export interface VideoWorkbenchDeps {
  /** config videoGen accessor — provider/model/account fallbacks. */
  defaults?: () => MediaGenConfig | undefined;
  /** Provider credentials + asset reads; absent → stub-only. */
  runtime?: MediaRuntimeDeps;
  /** Fetch override for adapters (tests). */
  fetch?: typeof globalThis.fetch;
  /** File-defined video providers (`~/.config/bai/providers/`), hot-reloadable. */
  custom?: () => VideoProviderDef[];
}

/**
 * Video-generation modality. Workflow-driven: the request names a workflow
 * (`t2v`/`i2v`/`flf2v`/`ref2v`/…) plus role-tagged inputs, and the adapter for
 * the configured provider serves it. Mirrors the image workbench's pipeline
 * (job → executor → asset + DB row → events → gallery), with a longer job
 * timeout for the async providers. Every produced asset is self-describing —
 * its `meta.gen` carries the request so the page can reload it.
 */
export class VideoWorkbench implements Workbench {
  private readonly deps: VideoWorkbenchDeps;
  private readonly adapters: Map<string, VideoGenAdapter>;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(deps: VideoWorkbenchDeps = {}) {
    this.deps = deps;
    this.fetchImpl = deps.fetch ?? globalThis.fetch;
    this.adapters = buildVideoAdapters(this.fetchImpl);
  }

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

  /** The video provider picker's rows (label + workflows + models). */
  async providers(): Promise<VideoProviderInfo[]> {
    const infos = await videoProviderInfos(this.adapters);
    for (const def of this.deps.custom?.() ?? []) {
      const adapter = def.build(this.fetchImpl);
      const models = await adapter.listModels();
      infos.push({
        id: def.id,
        label: def.label,
        defaultModel: adapter.defaultModel(),
        workflows: unionWorkflows(models),
        models,
        source: "file",
        providerType: def.mediaOnly ? ["video"] : ["text", "video"],
        ...(def.filePath !== undefined ? { path: def.filePath } : {}),
      });
    }
    return infos;
  }

  /** The adapter for a provider id or alias; unknown providers fall back to stub. */
  private adapterFor(provider: string): VideoGenAdapter {
    const direct = this.adapters.get(provider);
    if (direct !== undefined) return direct;
    const aliased = videoProviderDef(provider);
    if (aliased !== undefined) {
      const adapter = this.adapters.get(aliased.id);
      if (adapter !== undefined) return adapter;
    }
    const custom = this.deps.custom?.().find((def) => def.id === provider);
    if (custom !== undefined) return custom.build(this.fetchImpl);
    return this.adapters.get("stub")!;
  }

  /** Curated model list + workflow/param vocabulary for the page's picker. */
  async capabilities(provider?: string, model?: string): Promise<VideoCapabilitiesResponse> {
    const configured = this.deps.defaults?.();
    const providerId = provider ?? configured?.provider ?? "stub";
    const adapter = this.adapterFor(providerId);
    const modelId = model ?? configured?.model ?? adapter.defaultModel();
    return {
      provider: providerId,
      model: modelId,
      models: await adapter.listModels(),
      capabilities: adapter.capabilities(modelId),
    };
  }

  jobExecutors() {
    const executor: JobExecutor = async (job, ctx) => {
      const request = parseRequest(job.input);
      const configured = this.deps.defaults?.();
      const provider = request.provider ?? configured?.provider ?? "stub";
      const account = request.account ?? configured?.account;
      const adapter = this.adapterFor(provider);
      const model = request.model ?? configured?.model ?? adapter.defaultModel();
      const resolved: VideoGenRequest = { ...request, model };
      ctx.describe?.({
        provider,
        model,
        ...(account !== undefined ? { account } : {}),
        mode: request.workflow,
      });
      ctx.progress(0.05);
      const credentials = this.deps.runtime
        ? await this.deps.runtime.resolveCredentials(provider, account)
        : {};
      const generated = await adapter.generate({
        request: resolved,
        credentials,
        ctx: {
          signal: ctx.signal,
          readAsset: (id) => this.deps.runtime?.readAsset(id),
        },
      });
      ctx.progress(0.9);
      if (ctx.signal.aborted) throw new MediaGenError("Generation cancelled.", { retryable: false });
      const costPerVideo =
        generated.costUsd !== undefined && generated.videos.length > 0
          ? generated.costUsd / generated.videos.length
          : undefined;
      const files: GeneratedFile[] = generated.videos.map((video) =>
        this.toFile(video, resolved, provider, account, costPerVideo, ctx.sessionId),
      );
      const result: JobExecutorResult = {
        output: {
          model,
          provider,
          workflow: request.workflow,
          count: files.length,
          ...(generated.costUsd !== undefined ? { costUsd: generated.costUsd } : {}),
        },
        files,
      };
      return result;
    };
    return { "video.generate": executor };
  }

  private toFile(
    video: {
      mime: string;
      ext: string;
      bytes: Uint8Array;
      durationSeconds?: number;
      width?: number;
      height?: number;
    },
    request: VideoGenRequest,
    provider: string,
    account: string | undefined,
    costUsd?: number,
    sessionId?: string,
  ): GeneratedFile {
    if (!looksLikeVideo(video.bytes, video.mime)) {
      throw new MediaGenError(`Provider returned a non-video payload (${video.mime}).`, { retryable: false });
    }
    const probe = videoProbe(video.bytes, video.mime);
    const durationSeconds = video.durationSeconds ?? probe?.durationSeconds;
    const width = video.width ?? probe?.width;
    const height = video.height ?? probe?.height;
    const params = request.params ?? {};
    const meta: Record<string, unknown> = {
      // Self-describing: the exact request reloads into the form.
      gen: { ...request, provider, ...(account !== undefined ? { account } : {}) },
      prompt: request.prompt,
      workflow: request.workflow,
      model: request.model,
      provider,
      ...(account !== undefined ? { account } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(request.tags !== undefined && request.tags.length > 0 ? { tags: request.tags } : {}),
      ...(typeof params.aspect_ratio === "string" ? { aspectRatio: params.aspect_ratio } : {}),
      ...(typeof params.resolution === "string" ? { resolution: params.resolution } : {}),
      ...(durationSeconds !== undefined ? { durationSeconds } : {}),
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
      ...(costUsd !== undefined ? { costUsd } : {}),
      ...(provider === "stub" ? { placeholder: true } : {}),
    };
    return { kind: "video", mime: video.mime, ext: video.ext, bytes: video.bytes, meta };
  }

  routes() {
    return [];
  }
}

/** Tolerant input parser for a `VideoGenRequest`. */
export function parseVideoRequest(input: unknown): VideoGenRequest {
  const obj = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const params: Record<string, MediaParamValue> = {};
  if (typeof obj.params === "object" && obj.params !== null) {
    for (const [key, value] of Object.entries(obj.params as Record<string, unknown>)) {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") params[key] = value;
      else if (Array.isArray(value) && value.every((v) => typeof v === "string")) params[key] = value as string[];
    }
  }
  const inputs: VideoInput[] = [];
  if (Array.isArray(obj.inputs)) {
    for (const entry of obj.inputs) {
      if (typeof entry !== "object" || entry === null) continue;
      const rec = entry as Record<string, unknown>;
      if (!isVideoRole(rec.role)) continue;
      const input: VideoInput = { role: rec.role };
      if (typeof rec.assetId === "string" && rec.assetId.length > 0) input.assetId = rec.assetId;
      if (typeof rec.url === "string" && rec.url.length > 0) input.url = rec.url;
      if (typeof rec.tag === "string" && rec.tag.length > 0) input.tag = rec.tag;
      if (typeof rec.timestampSeconds === "number") input.timestampSeconds = rec.timestampSeconds;
      if (input.assetId !== undefined || input.url !== undefined) inputs.push(input);
    }
  }
  const tags = normalizeTags(
    Array.isArray(obj.tags) ? obj.tags.filter((t): t is string => typeof t === "string") : undefined,
  );
  const workflow: VideoWorkflow = isVideoWorkflow(obj.workflow) ? obj.workflow : "t2v";
  return {
    workflow,
    prompt: typeof obj.prompt === "string" ? obj.prompt : "",
    ...(typeof obj.model === "string" && obj.model.length > 0 ? { model: obj.model } : {}),
    ...(typeof obj.provider === "string" && obj.provider.length > 0 ? { provider: obj.provider } : {}),
    ...(typeof obj.account === "string" && obj.account.length > 0 ? { account: obj.account } : {}),
    ...(Object.keys(params).length > 0 ? { params } : {}),
    ...(inputs.length > 0 ? { inputs } : {}),
    ...(tags.length > 0 ? { tags } : {}),
  };
}

const parseRequest = parseVideoRequest;

/** The role for a named tool argument (image/video references). */
export function roleForArg(name: string): VideoRole | undefined {
  switch (name) {
    case "first_frame":
      return "first_frame";
    case "last_frame":
      return "last_frame";
    case "reference_images":
    case "reference_image":
      return "reference_image";
    case "reference_videos":
    case "reference_video":
      return "reference_video";
    case "reference_audio":
    case "audio":
      return "reference_audio";
    case "source_video":
      return "source_video";
    default:
      return undefined;
  }
}
