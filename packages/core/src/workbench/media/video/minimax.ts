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
  resolutionParam,
  workflow,
} from "../workflow-specs";
import { firstInput, inputDataUrl, inputHttpsUrl, inputsByRole, resolveInputs } from "../upload";

export const MINIMAX_VIDEO_BASE = "https://api.minimax.io";

/**
 * MiniMax Hailuo/H3 — one async task API with a typed multimodal `content[]`
 * array where every asset carries an explicit `role` (first_frame, last_frame,
 * reference_image/video/audio). Images accept base64 data URLs; videos/audio
 * must be hosted URLs.
 */

interface MmModel extends VideoModelInfo {
  readonly label: string;
}

const MODELS: MmModel[] = [
  { id: "MiniMax-H3", label: "MiniMax H3", workflows: ["t2v", "i2v", "flf2v", "ref2v"], rates: [{ label: "Price", value: "$0.08 / s (768P) · $0.13 / s (2K)" }] },
  { id: "MiniMax-H3-Max", label: "MiniMax H3 Max", workflows: ["t2v", "i2v", "flf2v"], rates: [{ label: "Price", value: "$0.05 / s (480P) · $0.08 / s (768P)" }] },
];

const DEFAULT_MODEL = "MiniMax-H3";

const WF_INPUTS: Partial<Record<VideoWorkflow, VideoInputSlot[]>> = {
  i2v: [{ role: "first_frame", label: "First frame", accepts: ["image"], required: true }],
  flf2v: [
    { role: "first_frame", label: "First frame", accepts: ["image"], required: true },
    { role: "last_frame", label: "Last frame", accepts: ["image"] },
  ],
  ref2v: [referenceImages(9), referenceAudio(3)],
};

function workflowsFor(model: MmModel): VideoWorkflowSpec[] {
  return model.workflows.map((id) => workflow(id, WF_INPUTS[id] ?? []));
}

function params(): MediaParamSpec[] {
  return [durationParam(4, 15, 6), resolutionParam(["480P", "768P", "2K"], "768P"), aspectParam(["16:9", "9:16", "1:1"], "16:9")];
}

export class MinimaxVideoAdapter implements VideoGenAdapter {
  readonly id = "minimax-video";

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
    return { provider: "minimax-video", model: info.id, workflows: workflowsFor(info), params: params() };
  }

  async generate(input: {
    request: VideoGenRequest;
    credentials: MediaAdapterCredentials;
    ctx: MediaGenContext;
  }): Promise<VideoGenerateResult> {
    const { request, credentials, ctx } = input;
    if (credentials.apiKey === undefined || credentials.apiKey.length === 0) {
      throw new MediaGenError(
        "MiniMax API key not configured — add one in Settings → Video Generation, or set MINIMAX_API_KEY.",
        { retryable: false },
      );
    }
    const base = (credentials.baseUrl ?? MINIMAX_VIDEO_BASE).replace(/\/+$/, "");
    const headers = { authorization: `Bearer ${credentials.apiKey}`, ...(credentials.headers ?? {}) };
    const model = request.model ?? this.defaultModel();
    const inputs = resolveInputs(request.inputs, ctx);
    const body = buildBody(request, model, inputs);

    const submitted = (await postJson(this.fetchImpl, `${base}/v2/video_generation`, body, {
      headers,
      signal: ctx.signal,
      label: "MiniMax video request",
    })) as { task_id?: unknown } | undefined;
    const taskId = typeof submitted?.task_id === "string" ? submitted.task_id : undefined;
    if (taskId === undefined) throw new MediaGenError("MiniMax did not return a task id.", { retryable: false });

    const task = await pollUntil<Record<string, unknown>>(
      async () => {
        const status = (await getJson(this.fetchImpl, `${base}/v2/query/video_generation/${taskId}`, {
          headers,
          signal: ctx.signal,
          label: "MiniMax task poll",
        })) as { task?: { status?: unknown; content?: unknown } } | undefined;
        const state = typeof status?.task?.status === "string" ? status.task.status : "processing";
        if (state === "succeeded" || state === "Success") return { done: true, value: (status?.task ?? {}) as Record<string, unknown> };
        if (state === "failed" || state === "cancelled") {
          return { done: true, error: `MiniMax task ${state}.`, retryable: false };
        }
        return { done: false };
      },
      { signal: ctx.signal, label: "MiniMax video generation", timeoutMs: 850_000 },
    );

    const content = task.content as Record<string, unknown> | undefined;
    const url = typeof content?.url === "string" ? content.url : undefined;
    if (url === undefined) throw new MediaGenError("MiniMax returned no video.", { retryable: false });
    const video = await fetchVideoBytes(this.fetchImpl, url, {
      signal: ctx.signal,
      fallbackMime: "video/mp4",
      label: "MiniMax video download",
    });
    return { videos: [video] };
  }
}

function buildBody(request: VideoGenRequest, model: string, inputs: ReturnType<typeof resolveInputs>): Record<string, unknown> {
  const params = request.params ?? {};
  const content: Record<string, unknown>[] = [{ type: "text", text: request.prompt }];
  const image = (role: string, url: string): Record<string, unknown> => ({ type: "image_url", image_url: { url }, role });
  const first = firstInput(inputs, "first_frame");
  const last = firstInput(inputs, "last_frame");
  if (first !== undefined) content.push(image("first_frame", inputDataUrl(first)));
  if (last !== undefined) content.push(image("last_frame", inputDataUrl(last)));
  if (first === undefined && last === undefined) {
    for (const ref of inputsByRole(inputs, "reference_image")) content.push(image("reference_image", inputDataUrl(ref)));
  }
  for (const video of inputsByRole(inputs, "reference_video")) {
    content.push({ type: "video_url", video_url: { url: inputHttpsUrl(video) }, role: "reference_video" });
  }
  for (const audio of inputsByRole(inputs, "reference_audio")) {
    content.push({ type: "audio_url", audio_url: { url: inputHttpsUrl(audio) }, role: "reference_audio" });
  }

  const body: Record<string, unknown> = { model, content };
  if (typeof params.duration === "number") body.duration = Math.round(params.duration);
  if (typeof params.resolution === "string") body.resolution = params.resolution;
  if (typeof params.aspect_ratio === "string") {
    // Ratio must be "adaptive" for image-driven requests.
    body.ratio = first !== undefined || last !== undefined ? "adaptive" : params.aspect_ratio;
  }
  return body;
}

function infoFor(model?: string): MmModel {
  const id = model !== undefined && model.length > 0 ? model : DEFAULT_MODEL;
  return MODELS.find((m) => m.id === id) ?? { id, label: id, workflows: ["t2v", "i2v"] };
}
