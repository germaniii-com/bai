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
  referenceAudio,
  referenceImages,
  referenceVideos,
  resolutionParam,
  seedParam,
  sourceVideoParam,
  workflow,
} from "../workflow-specs";
import { firstInput, inputDataUrl, inputsByRole, resolveInputs } from "../upload";

export const WAN_BASE_URL = "https://dashscope.aliyuncs.com";

/**
 * Alibaba Wan (Model Studio / DashScope) — one async video-synthesis task with
 * a `media[]` array of `{type,url}` (first_frame/last_frame/reference_* and a
 * reference-video extension mode). Images and small videos ride data URIs.
 */

interface WanModel extends VideoModelInfo {
  readonly label: string;
}

const MODELS: WanModel[] = [
  { id: "wan3.0-video", label: "Wan 3.0 Video", workflows: ["t2v", "i2v", "flf2v", "ref2v", "v2v", "extend"], rates: [{ label: "Price", value: "$0.05–0.20 / s (res-based)" }] },
  { id: "wan3.0-video-prime", label: "Wan 3.0 Video Prime", workflows: ["t2v", "i2v", "flf2v", "ref2v", "v2v", "extend"], rates: [{ label: "Price", value: "higher tier (res-based)" }] },
];

const DEFAULT_MODEL = "wan3.0-video";

const WF_INPUTS: Partial<Record<VideoWorkflow, VideoInputSlot[]>> = {
  i2v: [{ role: "first_frame", label: "First frame", accepts: ["image"], required: true }],
  flf2v: [
    { role: "first_frame", label: "First frame", accepts: ["image"], required: true },
    { role: "last_frame", label: "Last frame", accepts: ["image"] },
  ],
  ref2v: [referenceImages(10), referenceVideos(5), referenceAudio(5)],
  v2v: [sourceVideoParam()],
  extend: [sourceVideoParam()],
};

function workflowsFor(model: WanModel): VideoWorkflowSpec[] {
  return model.workflows.map((id) => workflow(id, WF_INPUTS[id] ?? []));
}

function params(): MediaParamSpec[] {
  return [durationParam(2, 30, 5), resolutionParam(["480P", "720P", "1080P"], "1080P"), aspectParam(["16:9", "9:16", "1:1", "4:3", "3:4"], "16:9"), seedParam];
}

export class WanVideoAdapter implements VideoGenAdapter {
  readonly id = "wan";

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
    return { provider: "wan", model: info.id, workflows: workflowsFor(info), params: params() };
  }

  async generate(input: {
    request: VideoGenRequest;
    credentials: MediaAdapterCredentials;
    ctx: MediaGenContext;
  }): Promise<VideoGenerateResult> {
    const { request, credentials, ctx } = input;
    if (credentials.apiKey === undefined || credentials.apiKey.length === 0) {
      throw new MediaGenError(
        "DashScope API key not configured — add one in Settings → Video Generation, or set DASHSCOPE_API_KEY.",
        { retryable: false },
      );
    }
    const base = (credentials.baseUrl ?? WAN_BASE_URL).replace(/\/+$/, "");
    const headers = {
      authorization: `Bearer ${credentials.apiKey}`,
      "x-dashscope-async": "enable",
      ...(credentials.headers ?? {}),
    };
    const model = request.model ?? this.defaultModel();
    const inputs = resolveInputs(request.inputs, ctx);
    const body = buildBody(request, model, inputs);

    const submitted = (await postJson(this.fetchImpl, `${base}/api/v1/services/aigc/video-generation/video-synthesis`, body, {
      headers,
      signal: ctx.signal,
      label: "Wan video request",
    })) as { output?: { task_id?: unknown } } | undefined;
    const taskId = typeof submitted?.output?.task_id === "string" ? submitted.output.task_id : undefined;
    if (taskId === undefined) throw new MediaGenError("Wan did not return a task id.", { retryable: false });

    const task = await pollUntil<Record<string, unknown>>(
      async () => {
        const status = (await getJson(this.fetchImpl, `${base}/api/v1/tasks/${taskId}`, {
          headers,
          signal: ctx.signal,
          label: "Wan task poll",
        })) as { output?: { task_status?: unknown; message?: unknown; video_url?: unknown } } | undefined;
        const state = typeof status?.output?.task_status === "string" ? status.output.task_status : "PENDING";
        if (state === "SUCCEEDED") return { done: true, value: (status?.output ?? {}) as Record<string, unknown> };
        if (state === "FAILED" || state === "CANCELED") {
          const message = typeof status?.output?.message === "string" ? status.output.message : `Wan task ${state}.`;
          return { done: true, error: message, retryable: false };
        }
        return { done: false };
      },
      { signal: ctx.signal, label: "Wan video generation", timeoutMs: 850_000 },
    );

    const url = typeof task.video_url === "string" ? task.video_url : undefined;
    if (url === undefined) throw new MediaGenError("Wan returned no video.", { retryable: false });
    const video = await fetchVideoBytes(this.fetchImpl, url, {
      signal: ctx.signal,
      fallbackMime: "video/mp4",
      label: "Wan video download",
    });
    return { videos: [video] };
  }
}

function buildBody(request: VideoGenRequest, model: string, inputs: ReturnType<typeof resolveInputs>): Record<string, unknown> {
  const params = request.params ?? {};
  const media: Record<string, unknown>[] = [];
  const first = firstInput(inputs, "first_frame");
  const last = firstInput(inputs, "last_frame");
  const source = firstInput(inputs, "source_video");
  if (first !== undefined) media.push({ type: "first_frame", url: inputDataUrl(first) });
  if (last !== undefined) media.push({ type: "last_frame", url: inputDataUrl(last) });
  if (first === undefined && last === undefined) {
    for (const ref of inputsByRole(inputs, "reference_image")) media.push({ type: "reference_image", url: inputDataUrl(ref) });
    for (const video of inputsByRole(inputs, "reference_video")) media.push({ type: "reference_video", url: inputDataUrl(video) });
    for (const audio of inputsByRole(inputs, "reference_audio")) media.push({ type: "reference_audio", url: inputDataUrl(audio) });
    if (source !== undefined) media.push({ type: "reference_video", url: inputDataUrl(source) });
  }

  const parameters: Record<string, unknown> = {};
  if (typeof params.resolution === "string") parameters.resolution = params.resolution;
  if (typeof params.aspect_ratio === "string") parameters.ratio = source !== undefined || first === undefined ? "adaptive" : params.aspect_ratio;
  if (typeof params.duration === "number") parameters.duration = Math.round(params.duration);
  if (typeof params.seed === "number") parameters.seed = Math.round(params.seed);
  return { model, input: { prompt: request.prompt, ...(media.length > 0 ? { media } : {}) }, parameters };
}

function infoFor(model?: string): WanModel {
  const id = model !== undefined && model.length > 0 ? model : DEFAULT_MODEL;
  return MODELS.find((m) => m.id === id) ?? { id, label: id, workflows: ["t2v", "i2v"] };
}
