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
  referenceAudio,
  referenceImages,
  referenceVideos,
  resolutionParam,
  seedParam,
  sourceVideoParam,
  workflow,
} from "../workflow-specs";
import { firstInput, inputDataUrl, inputsByRole, resolveInputs } from "../upload";

export const SEEDANCE_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";

/**
 * ByteDance Seedance (Volcano Ark) — one async task; `content[]` carries text +
 * image/video/audio items (order = first, last) and accepts base64 data URIs
 * (or `asset://` ids). Native audio. 24 h result URLs.
 */

interface SeedanceModel extends VideoModelInfo {
  readonly label: string;
}

const MODELS: SeedanceModel[] = [
  { id: "doubao-seedance-2-0-260128", label: "Seedance 2.0", workflows: ["t2v", "i2v", "flf2v", "ref2v", "v2v", "extend"], rates: [{ label: "Price", value: "~$0.93 / 5s (1080p, tokens)" }] },
  { id: "doubao-seedance-2-5-260628", label: "Seedance 2.5", workflows: ["t2v", "i2v", "flf2v", "ref2v", "v2v", "extend"], rates: [{ label: "Price", value: "~$0.93 / 5s (1080p, tokens)" }] },
];

const DEFAULT_MODEL = "doubao-seedance-2-0-260128";

const WF_INPUTS: Partial<Record<VideoWorkflow, VideoInputSlot[]>> = {
  i2v: [{ role: "first_frame", label: "First frame", accepts: ["image"], required: true }],
  flf2v: [
    { role: "first_frame", label: "First frame", accepts: ["image"], required: true },
    { role: "last_frame", label: "Last frame", accepts: ["image"] },
  ],
  ref2v: [referenceImages(9), referenceVideos(3), referenceAudio(3)],
  v2v: [sourceVideoParam()],
  extend: [sourceVideoParam()],
};

function workflowsFor(model: SeedanceModel): VideoWorkflowSpec[] {
  return model.workflows.map((id) => workflow(id, WF_INPUTS[id] ?? []));
}

function params(): MediaParamSpec[] {
  return [durationParam(4, 15, 5), resolutionParam(["480p", "720p", "1080p", "2K"], "720p"), aspectParam(["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "adaptive"], "16:9"), generateAudioParam, seedParam];
}

export class SeedanceVideoAdapter implements VideoGenAdapter {
  readonly id = "seedance";

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
    return { provider: "seedance", model: info.id, workflows: workflowsFor(info), params: params() };
  }

  async generate(input: {
    request: VideoGenRequest;
    credentials: MediaAdapterCredentials;
    ctx: MediaGenContext;
  }): Promise<VideoGenerateResult> {
    const { request, credentials, ctx } = input;
    if (credentials.apiKey === undefined || credentials.apiKey.length === 0) {
      throw new MediaGenError(
        "Volcano Ark API key not configured — add one in Settings → Video Generation, or set ARK_API_KEY.",
        { retryable: false },
      );
    }
    const base = (credentials.baseUrl ?? SEEDANCE_BASE_URL).replace(/\/+$/, "");
    const headers = { authorization: `Bearer ${credentials.apiKey}`, ...(credentials.headers ?? {}) };
    const model = request.model ?? this.defaultModel();
    const inputs = resolveInputs(request.inputs, ctx);
    const body = buildBody(request, model, inputs);

    const submitted = (await postJson(this.fetchImpl, `${base}/contents/generations/tasks`, body, {
      headers,
      signal: ctx.signal,
      label: "Seedance video request",
    })) as { id?: unknown } | undefined;
    const taskId = typeof submitted?.id === "string" ? submitted.id : undefined;
    if (taskId === undefined) throw new MediaGenError("Seedance did not return a task id.", { retryable: false });

    const task = await pollUntil<Record<string, unknown>>(
      async () => {
        const status = (await getJson(this.fetchImpl, `${base}/contents/generations/tasks/${taskId}`, {
          headers,
          signal: ctx.signal,
          label: "Seedance task poll",
        })) as { status?: unknown; error?: { message?: unknown }; content?: unknown } | undefined;
        const state = typeof status?.status === "string" ? status.status : "running";
        if (state === "succeeded") return { done: true, value: status as Record<string, unknown> };
        if (state === "failed" || state === "expired" || state === "cancelled") {
          const message =
            typeof status?.error?.message === "string" ? status.error.message : `Seedance task ${state}.`;
          return { done: true, error: message, retryable: false };
        }
        return { done: false };
      },
      { signal: ctx.signal, label: "Seedance video generation", timeoutMs: 850_000 },
    );

    const content = task.content as Record<string, unknown> | undefined;
    const url = typeof content?.video_url === "string" ? content.video_url : undefined;
    if (url === undefined) throw new MediaGenError("Seedance returned no video.", { retryable: false });
    const video = await fetchVideoBytes(this.fetchImpl, url, {
      signal: ctx.signal,
      fallbackMime: "video/mp4",
      label: "Seedance video download",
    });
    return { videos: [video] };
  }
}

function buildBody(request: VideoGenRequest, model: string, inputs: ReturnType<typeof resolveInputs>): Record<string, unknown> {
  const params = request.params ?? {};
  const content: Record<string, unknown>[] = [{ type: "text", text: request.prompt }];
  const image = (url: string): Record<string, unknown> => ({ type: "image_url", image_url: { url } });
  const first = firstInput(inputs, "first_frame");
  const last = firstInput(inputs, "last_frame");
  if (first !== undefined) content.push(image(inputDataUrl(first)));
  if (last !== undefined) content.push(image(inputDataUrl(last)));
  if (first === undefined && last === undefined) {
    for (const ref of inputsByRole(inputs, "reference_image")) content.push(image(inputDataUrl(ref)));
  }
  for (const video of inputsByRole(inputs, "reference_video")) {
    content.push({ type: "video_url", video_url: { url: inputDataUrl(video) } });
  }
  const source = firstInput(inputs, "source_video");
  if (source !== undefined) content.push({ type: "video_url", video_url: { url: inputDataUrl(source) } });
  for (const audio of inputsByRole(inputs, "reference_audio")) {
    content.push({ type: "audio_url", audio_url: { url: inputDataUrl(audio) } });
  }

  const body: Record<string, unknown> = { model, content };
  if (typeof params.resolution === "string") body.resolution = params.resolution;
  if (typeof params.aspect_ratio === "string") body.ratio = params.aspect_ratio;
  if (typeof params.duration === "number") body.duration = Math.round(params.duration);
  if (typeof params.generate_audio === "boolean") body.generate_audio = params.generate_audio;
  if (typeof params.seed === "number") body.seed = Math.round(params.seed);
  return body;
}

function infoFor(model?: string): SeedanceModel {
  const id = model !== undefined && model.length > 0 ? model : DEFAULT_MODEL;
  return MODELS.find((m) => m.id === id) ?? { id, label: id, workflows: ["t2v", "i2v"] };
}
