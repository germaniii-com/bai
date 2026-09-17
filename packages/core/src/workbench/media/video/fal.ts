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
import { getJson, postJson, pollUntil } from "../http";
import { fetchVideoBytes } from "../video-http";
import {
  aspectParam,
  durationParam,
  generateAudioParam,
  referenceImages,
  referenceVideos,
  resolutionParam,
  seedParam,
  shotsParam,
  sourceVideoParam,
  upscaleFactorParam,
  targetFpsParam,
  workflow,
} from "../workflow-specs";
import { firstInput, inputBytes, inputsByRole, resolveInputs, uploadFalFile, type ResolvedInput } from "../upload";

export const FAL_VIDEO_BASE = "https://queue.fal.run";

/**
 * fal.ai — one async queue protocol for every hosted video model: submit
 * `POST {base}/{model}` (auth `Authorization: Key`), poll `status_url`
 * (IN_QUEUE → IN_PROGRESS → COMPLETED), fetch `response_url`, download the
 * result. fal inputs are URL-based, so local references are uploaded through
 * fal's storage API first.
 */

interface FalModel extends VideoModelInfo {
  readonly label: string;
}

const MODELS: FalModel[] = [
  { id: "fal-ai/veo3.1", label: "Veo 3.1", workflows: ["t2v", "i2v", "flf2v", "ref2v"], rates: [{ label: "Price", value: "$0.40 / s" }] },
  { id: "fal-ai/kling-video/v3/pro/text-to-video", label: "Kling v3 Pro (T2V)", workflows: ["t2v"], rates: [{ label: "Price", value: "$0.084–0.42 / s" }] },
  { id: "fal-ai/kling-video/v3/pro/image-to-video", label: "Kling v3 Pro (I2V)", workflows: ["i2v", "flf2v", "ref2v", "motion"], rates: [{ label: "Price", value: "$0.084–0.42 / s" }] },
  { id: "bytedance/seedance-2.0/text-to-video", label: "Seedance 2.0 (T2V)", workflows: ["t2v"], rates: [{ label: "Price", value: "~$0.93 / 5s (1080p)" }] },
  { id: "bytedance/seedance-2.0/image-to-video", label: "Seedance 2.0 (I2V)", workflows: ["i2v", "flf2v"], rates: [{ label: "Price", value: "~$0.93 / 5s (1080p)" }] },
  { id: "bytedance/seedance-2.0/reference-to-video", label: "Seedance 2.0 (Ref)", workflows: ["ref2v", "v2v", "extend"], rates: [{ label: "Price", value: "token-based (per output)" }] },
  { id: "fal-ai/luma-dream-machine/ray-2", label: "Luma Ray 2", workflows: ["t2v", "i2v"], rates: [{ label: "Price", value: "$0.30 / 5s · $1.20 / 5s (1080p)" }] },
  { id: "fal-ai/minimax/video-01", label: "MiniMax Video-01", workflows: ["t2v", "i2v", "flf2v"], rates: [{ label: "Price", value: "$0.05–0.13 / s" }] },
  { id: "fal-ai/wan/v2.2-a14b/text-to-video", label: "Wan 2.2 (T2V)", workflows: ["t2v", "extend"], rates: [{ label: "Price", value: "$0.05–0.20 / s" }] },
  { id: "fal-ai/wan/v2.2-a14b/image-to-video", label: "Wan 2.2 (I2V)", workflows: ["i2v", "flf2v", "ref2v"], rates: [{ label: "Price", value: "$0.05–0.20 / s" }] },
  { id: "fal-ai/topaz/upscale/video", label: "Topaz Video Upscale", workflows: ["upscale"], rates: [{ label: "Price", value: "per second (model-based)" }] },
];

const DEFAULT_MODEL = "fal-ai/veo3.1";

const WF_INPUTS: Partial<Record<VideoWorkflow, VideoInputSlot[]>> = {
  i2v: [{ role: "first_frame", label: "First frame", accepts: ["image"], required: true }],
  flf2v: [
    { role: "first_frame", label: "First frame", accepts: ["image"], required: true },
    { role: "last_frame", label: "Last frame", accepts: ["image"] },
  ],
  ref2v: [referenceImages(4), referenceVideos(1)],
  v2v: [sourceVideoParam()],
  extend: [sourceVideoParam()],
  upscale: [sourceVideoParam()],
  motion: [sourceVideoParam(), { role: "reference_image", label: "Subject image", accepts: ["image"], required: true }],
};

function workflowsFor(model: FalModel): VideoWorkflowSpec[] {
  return model.workflows.map((id) => {
    const extra: MediaParamSpec[] =
      id === "upscale" ? [upscaleFactorParam, targetFpsParam] : id === "t2v" && model.id.includes("kling") ? [shotsParam] : [];
    return workflow(id, WF_INPUTS[id] ?? [], extra);
  });
}

function paramsFor(model: FalModel): MediaParamSpec[] {
  const base: MediaParamSpec[] = [];
  if (!model.workflows.every((w) => w === "upscale")) {
    base.push(durationParam(1, 15, 6), resolutionParam(["480p", "720p", "1080p", "4k"], "720p"), aspectParam(), generateAudioParam, seedParam);
  }
  return base;
}

export class FalVideoAdapter implements VideoGenAdapter {
  readonly id = "fal";

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
    return { provider: "fal", model: info.id, workflows: workflowsFor(info), params: paramsFor(info) };
  }

  async generate(input: {
    request: VideoGenRequest;
    credentials: MediaAdapterCredentials;
    ctx: MediaGenContext;
  }): Promise<VideoGenerateResult> {
    const { request, credentials, ctx } = input;
    if (credentials.apiKey === undefined || credentials.apiKey.length === 0) {
      throw new MediaGenError(
        "fal.ai API key not configured — add one in Settings → Video Generation, or set FAL_KEY.",
        { retryable: false },
      );
    }
    const base = (credentials.baseUrl ?? FAL_VIDEO_BASE).replace(/\/+$/, "");
    const headers = { authorization: `Key ${credentials.apiKey}`, ...(credentials.headers ?? {}) };
    const model = request.model ?? this.defaultModel();
    const inputs = resolveInputs(request.inputs, ctx);
    const upload = async (value: ResolvedInput): Promise<string> => {
      if (value.url !== undefined && value.url.length > 0) return value.url;
      const bytes = inputBytes(value);
      return uploadFalFile(this.fetchImpl, credentials.apiKey!, bytes, value.mime, `${value.role}.bin`, ctx.signal);
    };
    const payload = await buildPayload(request, model, inputs, upload);

    const submitted = (await postJson(this.fetchImpl, `${base}/${model}`, payload, {
      headers,
      signal: ctx.signal,
      label: "fal.ai video request",
    })) as { status_url?: unknown; response_url?: unknown } | undefined;
    const statusUrl = typeof submitted?.status_url === "string" ? submitted.status_url : undefined;
    const responseUrl = typeof submitted?.response_url === "string" ? submitted.response_url : undefined;
    if (statusUrl === undefined || responseUrl === undefined) {
      throw new MediaGenError("fal.ai did not return queue URLs.", { retryable: false });
    }

    await pollUntil<true>(
      async () => {
        const status = (await getJson(this.fetchImpl, statusUrl, {
          headers,
          signal: ctx.signal,
          label: "fal.ai video poll",
        })) as { status?: unknown; error?: unknown } | undefined;
        const state = typeof status?.status === "string" ? status.status : "IN_QUEUE";
        if (state === "COMPLETED") {
          if (typeof status?.error === "string" && status.error.length > 0) {
            return { done: true, error: status.error, retryable: false };
          }
          return { done: true, value: true as const };
        }
        return { done: false };
      },
      { signal: ctx.signal, label: "fal.ai video generation", timeoutMs: 850_000 },
    );

    const result = (await getJson(this.fetchImpl, responseUrl, {
      headers,
      signal: ctx.signal,
      label: "fal.ai video result",
    })) as Record<string, unknown> | undefined;
    const urls = extractVideoUrls(result);
    if (urls.length === 0) throw new MediaGenError("fal.ai returned no video for this request.", { retryable: false });
    const video = await fetchVideoBytes(this.fetchImpl, urls[0]!, {
      signal: ctx.signal,
      fallbackMime: "video/mp4",
      label: "fal.ai video download",
    });
    return { videos: [video] };
  }
}

type UploadFn = (value: ResolvedInput) => Promise<string>;

async function buildPayload(
  request: VideoGenRequest,
  model: string,
  inputs: ResolvedInput[],
  upload: UploadFn,
): Promise<Record<string, unknown>> {
  const params = request.params ?? {};
  const payload: Record<string, unknown> = { prompt: request.prompt };
  for (const key of ["resolution", "aspect_ratio", "negative_prompt"] as const) {
    const value = params[key];
    if (typeof value === "string" && value.length > 0) payload[key] = value;
  }
  if (typeof params.duration === "number") payload.duration = `${Math.max(1, Math.round(params.duration))}s`;
  if (typeof params.seed === "number") payload.seed = Math.round(params.seed);
  if (typeof params.generate_audio === "boolean") payload.generate_audio = params.generate_audio;
  if (typeof params.upscale_factor === "number") payload.upscale_factor = params.upscale_factor;
  if (typeof params.target_fps === "number") payload.target_fps = Math.round(params.target_fps);
  if (request.workflow === "upscale" || request.workflow === "v2v") payload.sync_mode = false;

  const kling = model.includes("kling");
  const first = firstInput(inputs, "first_frame");
  const last = firstInput(inputs, "last_frame");
  if (first !== undefined) {
    payload[kling ? "start_image_url" : "image_url"] = await upload(first);
  }
  if (last !== undefined) {
    payload[kling ? "end_image_url" : "tail_image_url"] = await upload(last);
  }
  const refs = inputsByRole(inputs, "reference_image");
  if (refs.length > 0) payload.reference_image_urls = await Promise.all(refs.map((r) => upload(r)));
  const videos = inputsByRole(inputs, "reference_video");
  if (videos.length > 0) payload.video_url = await upload(videos[0]!);
  const source = firstInput(inputs, "source_video");
  if (source !== undefined) payload.video_url = await upload(source);
  const audio = firstInput(inputs, "reference_audio");
  if (audio !== undefined) payload.audio_url = await upload(audio);

  const shots = params.shots;
  if (Array.isArray(shots) && shots.length > 0) {
    payload.multi_prompt = shots.map((prompt) => ({ prompt }));
    payload.shot_type = "customize";
  }
  return payload;
}

function extractVideoUrls(result: Record<string, unknown> | undefined): string[] {
  const urls: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value === "string" && value.length > 0) urls.push(value);
    else if (typeof value === "object" && value !== null) {
      const url = (value as { url?: unknown }).url;
      if (typeof url === "string" && url.length > 0) urls.push(url);
    }
  };
  if (result !== undefined) {
    push(result.video);
    push(result.video_url);
    if (Array.isArray(result.videos)) for (const v of result.videos) push(v);
    if (Array.isArray(result.data)) for (const v of result.data) push(v);
  }
  return urls;
}

function infoFor(model?: string): FalModel {
  const id = model !== undefined && model.length > 0 ? model : DEFAULT_MODEL;
  return MODELS.find((m) => m.id === id) ?? { id, label: id, workflows: ["t2v", "i2v"] };
}
