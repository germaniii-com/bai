import type {
  MediaParamSpec,
  VideoCapabilities,
  VideoGenRequest,
  VideoInputSlot,
  VideoModelInfo,
  VideoWorkflow,
  VideoWorkflowSpec,
} from "@bai/shared";
import { MediaGenError, type MediaAdapterCredentials, type MediaGenContext } from "../adapter";
import type { VideoGenAdapter, VideoGenerateResult } from "../video-adapter";
import { getJson, postJson, pollUntil, toDataUrl } from "../http";
import { fetchVideoBytes } from "../video-http";
import {
  aspectParam,
  durationParam,
  referenceImages,
  resolutionParam,
  seedParam,
  sourceVideoParam,
  upscaleFactorParam,
  workflow,
} from "../workflow-specs";
import { firstInput, inputBytes, inputsByRole, resolveInputs, uploadRunwayFile, type ResolvedInput } from "../upload";

export const RUNWAY_BASE_URL = "https://api.dev.runwayml.com";
const RUNWAY_VERSION = "2024-11-06";

/**
 * Runway — one tasks API. `text_to_video` / `image_to_video` (Gen-4.5, Veo,
 * Seedance, Hailuo) / `video_to_video` (Aleph) / `video_upscale`. Inputs accept
 * a data URI up to a small cap, otherwise an ephemeral `/v1/uploads` hop.
 */

interface RunwayModel extends VideoModelInfo {
  readonly label: string;
}

const MODELS: RunwayModel[] = [
  { id: "gen4.5", label: "Gen-4.5", workflows: ["t2v", "i2v"], rates: [{ label: "Price", value: "12 cr/s ($0.12 / s)" }] },
  { id: "veo3.1", label: "Veo 3.1 (Runway)", workflows: ["t2v", "i2v", "flf2v", "ref2v"], rates: [{ label: "Price", value: "40 cr/s audio · 20 cr/s" }] },
  { id: "seedance2", label: "Seedance 2 (Runway)", workflows: ["t2v", "i2v", "flf2v", "ref2v", "v2v"], rates: [{ label: "Price", value: "36–150 cr/s" }] },
  { id: "hailuo3", label: "Hailuo 3 (Runway)", workflows: ["t2v", "i2v", "flf2v", "ref2v"], rates: [{ label: "Price", value: "10–15 cr/s" }] },
  { id: "aleph2", label: "Aleph 2 (edit)", workflows: ["v2v"], rates: [{ label: "Price", value: "per-second credits" }] },
  { id: "magnific_video_upscaler_creative", label: "Magnific Upscaler", workflows: ["upscale"], rates: [{ label: "Price", value: "per-frame credits" }] },
];

const DEFAULT_MODEL = "gen4.5";

const WF_INPUTS: Partial<Record<VideoWorkflow, VideoInputSlot[]>> = {
  i2v: [{ role: "first_frame", label: "First frame", accepts: ["image"], required: true }],
  flf2v: [
    { role: "first_frame", label: "First frame", accepts: ["image"], required: true },
    { role: "last_frame", label: "Last frame", accepts: ["image"] },
  ],
  ref2v: [referenceImages(3)],
  v2v: [sourceVideoParam()],
  upscale: [sourceVideoParam()],
};

function workflowsFor(model: RunwayModel): VideoWorkflowSpec[] {
  return model.workflows.map((id) => workflow(id, WF_INPUTS[id] ?? [], id === "upscale" ? [upscaleFactorParam] : []));
}

function paramsFor(model: RunwayModel): MediaParamSpec[] {
  if (model.workflows.length === 1 && model.workflows[0] === "upscale") return [];
  return [durationParam(2, 10, 5), resolutionParam(["720p", "1080p"], "720p"), aspectParam(["16:9", "9:16", "1:1"], "16:9"), seedParam];
}

const RATIOS: Record<string, string> = { "16:9": "1280:720", "9:16": "720:1280", "1:1": "960:960" };

export class RunwayVideoAdapter implements VideoGenAdapter {
  readonly id = "runway";

  constructor(private readonly fetchImpl: typeof globalThis.fetch = globalThis.fetch) {}

  defaultModel(): string {
    return DEFAULT_MODEL;
  }

  async listModels(): Promise<VideoModelInfo[]> {
    return MODELS.map((m) => ({
      id: m.id,
      label: m.label,
      workflows: m.workflows,
      ...(m.rates !== undefined ? { rates: m.rates } : {}),
    }));
  }

  capabilities(model?: string): VideoCapabilities {
    const info = infoFor(model);
    return { provider: "runway", model: info.id, workflows: workflowsFor(info), params: paramsFor(info) };
  }

  async generate(input: {
    request: VideoGenRequest;
    credentials: MediaAdapterCredentials;
    ctx: MediaGenContext;
  }): Promise<VideoGenerateResult> {
    const { request, credentials, ctx } = input;
    if (credentials.apiKey === undefined || credentials.apiKey.length === 0) {
      throw new MediaGenError(
        "Runway API key not configured — add one in Settings → Video Generation, or set RUNWAYML_API_SECRET.",
        { retryable: false },
      );
    }
    const base = (credentials.baseUrl ?? RUNWAY_BASE_URL).replace(/\/+$/, "");
    const headers = {
      authorization: `Bearer ${credentials.apiKey}`,
      "x-runway-version": RUNWAY_VERSION,
      ...(credentials.headers ?? {}),
    };
    const model = request.model ?? this.defaultModel();
    const inputs = resolveInputs(request.inputs, ctx);
    const asUri = async (value: ResolvedInput): Promise<string> => {
      if (value.url !== undefined && value.url.length > 0) return value.url;
      const bytes = inputBytes(value);
      const limit = value.mime.startsWith("video/") ? 16 * 1024 * 1024 : 5 * 1024 * 1024;
      if (bytes.byteLength <= limit) return toDataUrl(value.mime, bytes);
      return uploadRunwayFile(this.fetchImpl, credentials.apiKey!, base, bytes, value.mime, `${value.role}.bin`, ctx.signal);
    };

    const { path, body } = await buildRequest(this.fetchImpl, base, request, model, inputs, asUri, ctx);
    const submitted = (await postJson(this.fetchImpl, `${base}${path}`, body, {
      headers,
      signal: ctx.signal,
      label: "Runway video request",
    })) as { id?: unknown } | undefined;
    const id = typeof submitted?.id === "string" ? submitted.id : undefined;
    if (id === undefined) throw new MediaGenError("Runway did not return a task id.", { retryable: false });

    const task = await pollUntil<Record<string, unknown>>(
      async () => {
        const status = (await getJson(this.fetchImpl, `${base}/v1/tasks/${id}`, {
          headers,
          signal: ctx.signal,
          label: "Runway task poll",
        })) as Record<string, unknown> | undefined;
        const state = typeof status?.status === "string" ? status.status : "PENDING";
        if (state === "SUCCEEDED") return { done: true, value: status ?? {} };
        if (state === "FAILED" || state === "CANCELED") {
          const failure = typeof status?.failure === "string" ? status.failure : `Runway task ${state}.`;
          return { done: true, error: failure, retryable: false };
        }
        return { done: false };
      },
      { signal: ctx.signal, label: "Runway video generation", timeoutMs: 850_000 },
    );

    const output = task.output;
    const url = Array.isArray(output) ? output.find((u): u is string => typeof u === "string" && u.length > 0) : typeof output === "string" ? output : undefined;
    if (url === undefined) throw new MediaGenError("Runway returned no video.", { retryable: false });
    const video = await fetchVideoBytes(this.fetchImpl, url, {
      signal: ctx.signal,
      fallbackMime: "video/mp4",
      label: "Runway video download",
    });
    return { videos: [video] };
  }
}

type UriFn = (value: ResolvedInput) => Promise<string>;

async function buildRequest(
  fetchImpl: typeof globalThis.fetch,
  base: string,
  request: VideoGenRequest,
  model: string,
  inputs: ResolvedInput[],
  asUri: UriFn,
  ctx: MediaGenContext,
): Promise<{ path: string; body: Record<string, unknown> }> {
  const params = request.params ?? {};
  const ratio = typeof params.aspect_ratio === "string" ? (RATIOS[params.aspect_ratio] ?? params.aspect_ratio) : undefined;
  const duration = typeof params.duration === "number" ? Math.max(2, Math.round(params.duration)) : undefined;
  const seed = typeof params.seed === "number" ? Math.round(params.seed) : undefined;

  if (request.workflow === "v2v") {
    const source = await asUri(firstInput(inputs, "source_video")!);
    return { path: "/v1/video_to_video", body: { model, promptText: request.prompt, videoUri: source } };
  }
  if (request.workflow === "upscale") {
    const source = await asUri(firstInput(inputs, "source_video")!);
    const body: Record<string, unknown> = { model, videoUri: source };
    if (typeof params.upscale_factor === "number") body.upscaleFactor = params.upscale_factor;
    return { path: "/v1/video_upscale", body };
  }

  const images: Record<string, unknown>[] = [];
  const first = firstInput(inputs, "first_frame");
  const last = firstInput(inputs, "last_frame");
  const refs = inputsByRole(inputs, "reference_image");
  if (first !== undefined) images.push({ uri: await asUri(first), position: "first" });
  if (last !== undefined && model !== "gen4.5") images.push({ uri: await asUri(last), position: "last" });
  for (const r of refs) images.push({ uri: await asUri(r) });

  const isI2v = request.workflow !== "t2v" && images.length > 0;
  if (!isI2v) {
    const body: Record<string, unknown> = { model, promptText: request.prompt };
    if (ratio !== undefined) body.ratio = ratio;
    if (duration !== undefined) body.duration = duration;
    if (seed !== undefined) body.seed = seed;
    return { path: "/v1/text_to_video", body };
  }
  const body: Record<string, unknown> = { model, promptText: request.prompt, promptImage: images };
  if (ratio !== undefined) body.ratio = ratio;
  if (duration !== undefined) body.duration = duration;
  if (seed !== undefined) body.seed = seed;
  void fetchImpl;
  void base;
  void ctx;
  return { path: "/v1/image_to_video", body };
}

function infoFor(model?: string): RunwayModel {
  const id = model !== undefined && model.length > 0 ? model : DEFAULT_MODEL;
  return MODELS.find((m) => m.id === id) ?? { id, label: id, workflows: ["t2v", "i2v"] };
}
