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
  negativePromptParam,
  referenceImages,
  referenceVideos,
  shotsParam,
  sourceVideoParam,
  workflow,
} from "../workflow-specs";
import { firstInput, inputDataUrl, inputHttpsUrl, inputsByRole, resolveInputs } from "../upload";

export const KLING_BASE_URL = "https://api-singapore.klingai.com";

/**
 * Kuaishou Kling — `text2video` / `image2video` (first+last frame, refs) /
 * `omni-video` (multi-shot, continuation) / `motion-control` / `avatar`.
 * Images accept base64 data URLs; source video/audio must be hosted URLs.
 */

interface KlingModel extends VideoModelInfo {
  readonly label: string;
}

const MODELS: KlingModel[] = [
  { id: "kling-v3", label: "Kling v3", workflows: ["t2v", "i2v", "flf2v", "ref2v", "v2v", "extend", "motion", "lipsync"], rates: [{ label: "Price", value: "$0.084 / s (720p) · $0.112 / s (1080p)" }] },
  { id: "kling-v3-turbo", label: "Kling v3 Turbo", workflows: ["t2v", "i2v", "flf2v"], rates: [{ label: "Price", value: "$0.112–0.14 / s" }] },
];

const DEFAULT_MODEL = "kling-v3";

const WF_INPUTS: Partial<Record<VideoWorkflow, VideoInputSlot[]>> = {
  i2v: [{ role: "first_frame", label: "First frame", accepts: ["image"], required: true }],
  flf2v: [
    { role: "first_frame", label: "First frame", accepts: ["image"], required: true },
    { role: "last_frame", label: "Last frame", accepts: ["image"] },
  ],
  ref2v: [referenceImages(4), referenceVideos(1)],
  v2v: [sourceVideoParam()],
  extend: [sourceVideoParam()],
  motion: [sourceVideoParam("Motion reference"), { role: "reference_image", label: "Subject image", accepts: ["image"], required: true }],
  lipsync: [{ role: "reference_image", label: "Portrait image", accepts: ["image"], required: true }, { role: "reference_audio", label: "Audio", accepts: ["audio"], required: true }],
};

function workflowsFor(model: KlingModel): VideoWorkflowSpec[] {
  return model.workflows.map((id) => workflow(id, WF_INPUTS[id] ?? [], id === "t2v" ? [shotsParam] : []));
}

function params(model: KlingModel): MediaParamSpec[] {
  return [
    { key: "duration", label: "Duration", kind: "range", min: 5, max: 10, step: 5, default: 5, unit: "s" },
    aspectParam(["16:9", "9:16", "1:1"], "16:9"),
    { key: "mode", label: "Quality", kind: "enum", options: ["std", "pro"].map((v) => ({ value: v, label: v })), default: "pro" },
    { key: "sound", label: "Generate audio", kind: "toggle", default: false },
    negativePromptParam,
  ];
}

export class KlingVideoAdapter implements VideoGenAdapter {
  readonly id = "kling";

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
    return { provider: "kling", model: info.id, workflows: workflowsFor(info), params: params(info) };
  }

  async generate(input: {
    request: VideoGenRequest;
    credentials: MediaAdapterCredentials;
    ctx: MediaGenContext;
  }): Promise<VideoGenerateResult> {
    const { request, credentials, ctx } = input;
    if (credentials.apiKey === undefined || credentials.apiKey.length === 0) {
      throw new MediaGenError(
        "Kling API key not configured — add one in Settings → Video Generation, or set KLING_API_KEY.",
        { retryable: false },
      );
    }
    const base = (credentials.baseUrl ?? KLING_BASE_URL).replace(/\/+$/, "");
    const headers = { authorization: `Bearer ${credentials.apiKey}`, ...(credentials.headers ?? {}) };
    const model = request.model ?? this.defaultModel();
    const inputs = resolveInputs(request.inputs, ctx);
    const { mode, path, body } = buildRequest(request, model, inputs);

    const submitted = (await postJson(this.fetchImpl, `${base}${path}`, body, {
      headers,
      signal: ctx.signal,
      label: "Kling video request",
    })) as { data?: { task_id?: unknown } } | undefined;
    const taskId = typeof submitted?.data?.task_id === "string" ? submitted.data.task_id : undefined;
    if (taskId === undefined) throw new MediaGenError("Kling did not return a task id.", { retryable: false });

    const task = await pollUntil<Record<string, unknown>>(
      async () => {
        const status = (await getJson(this.fetchImpl, `${base}/v1/videos/${mode}/${taskId}`, {
          headers,
          signal: ctx.signal,
          label: "Kling task poll",
        })) as { data?: { task_status?: unknown; task_status_msg?: unknown } } | undefined;
        const state = typeof status?.data?.task_status === "string" ? status.data.task_status : "submitted";
        if (state === "succeeded" || state === "succeed") return { done: true, value: (status?.data ?? {}) as Record<string, unknown> };
        if (state === "failed") {
          const message = typeof status?.data?.task_status_msg === "string" ? status.data.task_status_msg : "Kling generation failed.";
          return { done: true, error: message, retryable: false };
        }
        return { done: false };
      },
      { signal: ctx.signal, label: "Kling video generation", timeoutMs: 850_000 },
    );

    const url = taskVideoUrl(task);
    if (url === undefined) throw new MediaGenError("Kling returned no video.", { retryable: false });
    const video = await fetchVideoBytes(this.fetchImpl, url, {
      signal: ctx.signal,
      fallbackMime: "video/mp4",
      label: "Kling video download",
    });
    return { videos: [video] };
  }
}

function buildRequest(
  request: VideoGenRequest,
  model: string,
  inputs: ReturnType<typeof resolveInputs>,
): { mode: string; path: string; body: Record<string, unknown> } {
  const params = request.params ?? {};
  const common: Record<string, unknown> = { model_name: model, prompt: request.prompt };
  if (typeof params.negative_prompt === "string" && params.negative_prompt.length > 0) common.negative_prompt = params.negative_prompt;
  if (typeof params.duration === "number") common.duration = Math.round(params.duration);
  if (typeof params.aspect_ratio === "string") common.aspect_ratio = params.aspect_ratio;
  if (typeof params.mode === "string") common.mode = params.mode;
  if (typeof params.sound === "boolean") common.sound = params.sound;
  const shots = params.shots;
  if (Array.isArray(shots) && shots.length > 0) {
    common.multi_shot = true;
    common.shot_type = "customize";
    common.multi_prompt = shots.map((prompt, index) => ({ index: index + 1, prompt }));
  }

  const first = firstInput(inputs, "first_frame");
  const last = firstInput(inputs, "last_frame");
  const refs = inputsByRole(inputs, "reference_image");
  const source = firstInput(inputs, "source_video");
  const refVideo = firstInput(inputs, "reference_video");
  const audio = firstInput(inputs, "reference_audio");

  if (request.workflow === "motion" && source !== undefined) {
    return { mode: "motion-control", path: "/v1/videos/motion-control", body: { ...common, video_url: inputHttpsUrl(source), image_url: refs[0] !== undefined ? inputDataUrl(refs[0]) : undefined } };
  }
  if (request.workflow === "lipsync" && audio !== undefined) {
    return { mode: "avatar", path: "/v1/videos/avatar", body: { ...common, image: refs[0] !== undefined ? inputDataUrl(refs[0]) : undefined, audio: inputHttpsUrl(audio) } };
  }
  if ((request.workflow === "v2v" || request.workflow === "extend") && source !== undefined) {
    return { mode: "omni-video", path: "/v1/videos/omni-video", body: { ...common, video_url: inputHttpsUrl(source) } };
  }
  if (request.workflow === "t2v") {
    return { mode: "text2video", path: "/v1/videos/text2video", body: common };
  }
  // i2v / flf2v / ref2v
  const body: Record<string, unknown> = { ...common };
  if (first !== undefined) body.image = inputDataUrl(first);
  else if (refs[0] !== undefined) body.image = inputDataUrl(refs[0]);
  if (last !== undefined) body.image_tail = inputDataUrl(last);
  if (refVideo !== undefined) body.video_url = inputHttpsUrl(refVideo);
  return { mode: "image2video", path: "/v1/videos/image2video", body };
}

function taskVideoUrl(task: Record<string, unknown>): string | undefined {
  const result = task.task_result as Record<string, unknown> | undefined;
  const videos = result?.videos;
  if (Array.isArray(videos)) {
    for (const entry of videos) {
      if (typeof entry === "object" && entry !== null) {
        const url = (entry as { url?: unknown }).url;
        if (typeof url === "string" && url.length > 0) return url;
      } else if (typeof entry === "string" && entry.length > 0) {
        return entry;
      }
    }
  }
  return undefined;
}

function infoFor(model?: string): KlingModel {
  const id = model !== undefined && model.length > 0 ? model : DEFAULT_MODEL;
  return MODELS.find((m) => m.id === id) ?? { id, label: id, workflows: ["t2v", "i2v"] };
}
