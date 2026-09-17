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
import { encodeB64, getJson, postJson, pollUntil } from "../http";
import { fetchVideoBytes } from "../video-http";
import {
  aspectParam,
  durationParam,
  editStrengthParam,
  resolutionParam,
  sourceVideoParam,
  workflow,
} from "../workflow-specs";
import { firstInput, inputBytes, resolveInputs, type ResolvedInput } from "../upload";

export const LUMA_BASE_URL = "https://agents.lumalabs.ai";

/**
 * Luma (Agents API) — `type: video | video_edit | video_reframe`. Accepts inline
 * base64 (`{data, media_type}`) for local bytes, so references work without a
 * public URL. Legacy Dream Machine (URL-only) is not used.
 */

interface LumaModel extends VideoModelInfo {
  readonly label: string;
}

const MODELS: LumaModel[] = [
  { id: "ray-3.2", label: "Ray 3.2", workflows: ["t2v", "i2v", "flf2v", "v2v", "reframe"], rates: [{ label: "Price", value: "$0.30 / 5s (720p) · $1.20 / 5s (1080p)" }] },
  { id: "ray-flash-3.2", label: "Ray Flash 3.2", workflows: ["t2v", "i2v"], rates: [{ label: "Price", value: "$0.15 / 5s (540p)" }] },
];

const DEFAULT_MODEL = "ray-3.2";

const WF_INPUTS: Partial<Record<VideoWorkflow, VideoInputSlot[]>> = {
  i2v: [{ role: "first_frame", label: "First frame", accepts: ["image"], required: true }],
  flf2v: [
    { role: "first_frame", label: "First frame", accepts: ["image"], required: true },
    { role: "last_frame", label: "Last frame", accepts: ["image"] },
  ],
  v2v: [sourceVideoParam()],
  reframe: [sourceVideoParam()],
};

function workflowsFor(model: LumaModel): VideoWorkflowSpec[] {
  return model.workflows.map((id) => workflow(id, WF_INPUTS[id] ?? [], id === "v2v" ? [editStrengthParam] : id === "reframe" ? [aspectParam()] : []));
}

function paramsFor(model: LumaModel): MediaParamSpec[] {
  if (model.workflows.length === 1 && model.workflows[0] === "reframe") return [];
  return [durationParam(5, 9, 5), resolutionParam(["540p", "720p", "1080p"], "720p"), aspectParam()];
}

export class LumaVideoAdapter implements VideoGenAdapter {
  readonly id = "luma";

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
    return { provider: "luma", model: info.id, workflows: workflowsFor(info), params: paramsFor(info) };
  }

  async generate(input: {
    request: VideoGenRequest;
    credentials: MediaAdapterCredentials;
    ctx: MediaGenContext;
  }): Promise<VideoGenerateResult> {
    const { request, credentials, ctx } = input;
    if (credentials.apiKey === undefined || credentials.apiKey.length === 0) {
      throw new MediaGenError(
        "Luma API key not configured — add one in Settings → Video Generation, or set LUMA_API_KEY.",
        { retryable: false },
      );
    }
    const base = (credentials.baseUrl ?? LUMA_BASE_URL).replace(/\/+$/, "");
    const headers = { authorization: `Bearer ${credentials.apiKey}`, ...(credentials.headers ?? {}) };
    const model = request.model ?? this.defaultModel();
    const inputs = resolveInputs(request.inputs, ctx);
    const body = buildBody(request, model, inputs);

    const submitted = (await postJson(this.fetchImpl, `${base}/v1/generations`, body, {
      headers,
      signal: ctx.signal,
      label: "Luma generation request",
    })) as { id?: unknown } | undefined;
    const id = typeof submitted?.id === "string" ? submitted.id : undefined;
    if (id === undefined) throw new MediaGenError("Luma did not return a generation id.", { retryable: false });

    const generation = await pollUntil<Record<string, unknown>>(
      async () => {
        const status = (await getJson(this.fetchImpl, `${base}/v1/generations/${id}`, {
          headers,
          signal: ctx.signal,
          label: "Luma generation poll",
        })) as Record<string, unknown> | undefined;
        const state = typeof status?.state === "string" ? status.state : typeof status?.status === "string" ? status.status : "queued";
        if (state === "completed" || state === "succeeded") return { done: true, value: status ?? {} };
        if (state === "failed" || state === "error") {
          const reason = typeof status?.failure_reason === "string" ? status.failure_reason : "Luma generation failed.";
          return { done: true, error: reason, retryable: false };
        }
        return { done: false };
      },
      { signal: ctx.signal, label: "Luma video generation", timeoutMs: 850_000 },
    );

    const url = extractUrl(generation);
    if (url === undefined) throw new MediaGenError("Luma returned no video.", { retryable: false });
    const video = await fetchVideoBytes(this.fetchImpl, url, {
      signal: ctx.signal,
      fallbackMime: "video/mp4",
      label: "Luma video download",
    });
    return { videos: [video] };
  }
}

function buildBody(request: VideoGenRequest, model: string, inputs: ResolvedInput[]): Record<string, unknown> {
  const params = request.params ?? {};
  const common: Record<string, unknown> = { model, prompt: request.prompt };
  if (typeof params.resolution === "string") common.resolution = params.resolution;
  if (typeof params.duration === "number") common.duration = `${Math.round(params.duration)}s`;
  if (typeof params.aspect_ratio === "string") common.aspect_ratio = params.aspect_ratio;

  const first = firstInput(inputs, "first_frame");
  const last = firstInput(inputs, "last_frame");
  const source = firstInput(inputs, "source_video");
  const media = (value: ResolvedInput): Record<string, unknown> => ({ media_type: value.mime, data: encodeB64(inputBytes(value)) });

  if (request.workflow === "v2v" && source !== undefined) {
    return { ...common, type: "video_edit", source: media(source), video: { edit: { strength: typeof params.strength === "string" ? params.strength : "flex" } } };
  }
  if (request.workflow === "reframe" && source !== undefined) {
    return { ...common, type: "video_reframe", source: media(source) };
  }
  const video: Record<string, unknown> = {};
  if (first !== undefined) video.start_frame = media(first);
  if (last !== undefined) video.end_frame = media(last);
  return { ...common, type: "video", video };
}

function extractUrl(generation: Record<string, unknown>): string | undefined {
  const assets = generation.assets as Record<string, unknown> | undefined;
  if (typeof assets?.video === "string" && assets.video.length > 0) return assets.video;
  const output = generation.output as Record<string, unknown> | undefined;
  if (typeof output?.url === "string" && output.url.length > 0) return output.url;
  const video = generation.video as Record<string, unknown> | undefined;
  if (typeof video?.url === "string" && video.url.length > 0) return video.url;
  return undefined;
}

function infoFor(model?: string): LumaModel {
  const id = model !== undefined && model.length > 0 ? model : DEFAULT_MODEL;
  return MODELS.find((m) => m.id === id) ?? { id, label: id, workflows: ["t2v", "i2v"] };
}
