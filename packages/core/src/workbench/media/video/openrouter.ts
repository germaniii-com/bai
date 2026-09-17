import type {
  MediaParamSpec,
  VideoCapabilities,
  VideoGenRequest,
  VideoInputSlot,
  VideoModelInfo,
  VideoWorkflow,
  VideoWorkflowSpec,
} from "@bai/shared";
import { VIDEO_WORKFLOW_LABELS } from "@bai/shared";
import { MediaGenError, type MediaAdapterCredentials, type MediaGenContext } from "../adapter";
import type { VideoGenAdapter, VideoGenerateResult } from "../video-adapter";
import { getJson, postJson, pollUntil } from "../http";
import { fetchVideoBytes } from "../video-http";
import {
  aspectParam,
  durationParam,
  generateAudioParam,
  referenceImages,
  resolutionParam,
  seedParam,
  workflow,
} from "../workflow-specs";
import { firstInput, inputHttpsUrl, inputsByRole, resolveInputs, type ResolvedInput } from "../upload";

export const OPENROUTER_VIDEO_BASE = "https://openrouter.ai/api/v1";

/**
 * OpenRouter's async Video API (`POST /videos` → poll `polling_url` → download
 * `unsigned_urls[0]`). Image inputs are **HTTPS-URL only** (no base64/data-URL),
 * so this adapter supports reference workflows only when the caller supplies a
 * URL; local-asset references fail with a clear message. Reports `usage.cost`.
 */

interface OrModel extends VideoModelInfo {
  readonly label: string;
}

const MODELS: OrModel[] = [
  { id: "google/veo-3.1", label: "Veo 3.1", workflows: ["t2v", "i2v", "flf2v", "ref2v"], rates: [{ label: "Price", value: "$0.40 / s · $0.60 / s (4K)" }] },
  { id: "google/veo-3.1-fast", label: "Veo 3.1 Fast", workflows: ["t2v", "i2v", "flf2v", "ref2v"], rates: [{ label: "Price", value: "$0.10–0.30 / s" }] },
  { id: "bytedance/seedance-2.0", label: "Seedance 2.0", workflows: ["t2v", "i2v", "flf2v", "ref2v"], rates: [{ label: "Price", value: "~$0.93 / 5s (1080p)" }] },
  { id: "bytedance/seedance-2.5", label: "Seedance 2.5", workflows: ["t2v", "i2v", "flf2v", "ref2v"], rates: [{ label: "Price", value: "token-based (per output)" }] },
  { id: "minimax/hailuo-3", label: "Hailuo 3", workflows: ["t2v", "i2v", "flf2v"], rates: [{ label: "Price", value: "$0.08–0.13 / s" }] },
  { id: "kwaivgi/kling-v3.0-pro", label: "Kling 3.0 Pro", workflows: ["t2v", "i2v", "flf2v", "ref2v"], rates: [{ label: "Price", value: "$0.084–0.42 / s" }] },
  { id: "runway/gen-4.5", label: "Runway Gen-4.5", workflows: ["t2v", "i2v"], rates: [{ label: "Price", value: "$0.12 / s" }] },
  { id: "alibaba/wan-3.0", label: "Wan 3.0", workflows: ["t2v", "i2v", "flf2v", "ref2v"], rates: [{ label: "Price", value: "$0.05–0.20 / s" }] },
  { id: "x-ai/grok-imagine-video", label: "Grok Imagine Video", workflows: ["t2v", "i2v"], rates: [{ label: "Price", value: "provider-reported" }] },
];

const DEFAULT_MODEL = "google/veo-3.1";

const WF_INPUTS: Partial<Record<VideoWorkflow, VideoInputSlot[]>> = {
  i2v: [{ role: "first_frame", label: "First frame", accepts: ["image"], required: true }],
  flf2v: [
    { role: "first_frame", label: "First frame", accepts: ["image"], required: true },
    { role: "last_frame", label: "Last frame", accepts: ["image"] },
  ],
  ref2v: [referenceImages(3)],
};

function workflowsFor(model: OrModel): VideoWorkflowSpec[] {
  return model.workflows.map((id) => workflow(id, WF_INPUTS[id] ?? []));
}

function params(): MediaParamSpec[] {
  return [durationParam(1, 15, 8), resolutionParam(["480p", "720p", "1080p", "4k"], "720p"), aspectParam(), generateAudioParam, seedParam];
}

export class OpenRouterVideoAdapter implements VideoGenAdapter {
  readonly id = "openrouter";

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
    return { provider: "openrouter", model: info.id, workflows: workflowsFor(info), params: params() };
  }

  async generate(input: {
    request: VideoGenRequest;
    credentials: MediaAdapterCredentials;
    ctx: MediaGenContext;
  }): Promise<VideoGenerateResult> {
    const { request, credentials, ctx } = input;
    if (credentials.apiKey === undefined || credentials.apiKey.length === 0) {
      throw new MediaGenError(
        "OpenRouter API key not configured — add one in Settings → Video Generation, or set OPENROUTER_API_KEY.",
        { retryable: false },
      );
    }
    const base = (credentials.baseUrl ?? OPENROUTER_VIDEO_BASE).replace(/\/+$/, "");
    const headers = { authorization: `Bearer ${credentials.apiKey}`, "x-title": "bai" };
    const model = request.model ?? this.defaultModel();
    const inputs = resolveInputs(request.inputs, ctx);
    const body = buildBody(request, model, inputs);

    const submitted = (await postJson(this.fetchImpl, `${base}/videos`, body, {
      headers,
      signal: ctx.signal,
      label: "OpenRouter video request",
    })) as { id?: unknown; polling_url?: unknown } | undefined;
    const pollingUrl = typeof submitted?.polling_url === "string" ? submitted.polling_url : undefined;
    const id = typeof submitted?.id === "string" ? submitted.id : undefined;
    const pollUrl =
      pollingUrl !== undefined
        ? pollingUrl.startsWith("http")
          ? pollingUrl
          : new URL(pollingUrl, base).toString()
        : id !== undefined
          ? `${base}/videos/${id}`
          : undefined;
    if (pollUrl === undefined) throw new MediaGenError("OpenRouter did not return a polling URL.", { retryable: false });

    let cost: number | undefined;
    const result = await pollUntil<Record<string, unknown>>(
      async () => {
        const status = (await getJson(this.fetchImpl, pollUrl, {
          headers,
          signal: ctx.signal,
          label: "OpenRouter video poll",
        })) as Record<string, unknown> | undefined;
        const state = typeof status?.status === "string" ? status.status : "pending";
        if (state === "completed") {
          const usage = status?.usage;
          if (typeof usage === "object" && usage !== null) {
            const c = (usage as { cost?: unknown }).cost;
            if (typeof c === "number" && Number.isFinite(c)) cost = c;
          }
          return { done: true, value: status ?? {} };
        }
        if (state === "failed" || state === "cancelled" || state === "expired") {
          return { done: true, error: `OpenRouter video ${state}.`, retryable: false };
        }
        return { done: false };
      },
      { signal: ctx.signal, label: "OpenRouter video generation" },
    );

    const url = firstUrl(result);
    if (url === undefined) throw new MediaGenError("OpenRouter returned no video.", { retryable: false });
    const video = await fetchVideoBytes(this.fetchImpl, url, {
      headers,
      signal: ctx.signal,
      fallbackMime: "video/mp4",
      label: "OpenRouter video download",
    });
    return { videos: [video], ...(cost !== undefined ? { costUsd: cost } : {}) };
  }
}

function buildBody(request: VideoGenRequest, model: string, inputs: ResolvedInput[]): Record<string, unknown> {
  const params = request.params ?? {};
  const body: Record<string, unknown> = { model, prompt: request.prompt };
  for (const key of ["resolution", "aspect_ratio", "size"] as const) {
    const value = params[key];
    if (typeof value === "string" && value.length > 0) body[key] = value;
  }
  if (typeof params.duration === "number") body.duration = Math.max(1, Math.round(params.duration));
  if (typeof params.seed === "number") body.seed = Math.round(params.seed);
  if (typeof params.generate_audio === "boolean") body.generate_audio = params.generate_audio;

  const first = firstInput(inputs, "first_frame");
  const last = firstInput(inputs, "last_frame");
  if (first !== undefined || last !== undefined) {
    const frames: Record<string, unknown>[] = [];
    if (first !== undefined) frames.push(frame(first, "first_frame"));
    if (last !== undefined) frames.push(frame(last, "last_frame"));
    body.frame_images = frames;
  } else {
    const refs = inputsByRole(inputs, "reference_image");
    if (refs.length > 0) {
      body.input_references = refs.map((r) => ({ type: "image_url", image_url: { url: inputHttpsUrl(r) } }));
    }
  }
  return body;
}

function frame(input: ResolvedInput, frameType: "first_frame" | "last_frame"): Record<string, unknown> {
  return { type: "image_url", image_url: { url: inputHttpsUrl(input) }, frame_type: frameType };
}

function firstUrl(result: Record<string, unknown>): string | undefined {
  const urls = result.unsigned_urls;
  if (Array.isArray(urls)) {
    const found = urls.find((u): u is string => typeof u === "string" && u.length > 0);
    if (found !== undefined) return found;
  }
  if (typeof result.url === "string" && result.url.length > 0) return result.url;
  return undefined;
}

function infoFor(model?: string): OrModel {
  const id = model !== undefined && model.length > 0 ? model : DEFAULT_MODEL;
  return MODELS.find((m) => m.id === id) ?? { id, label: id, workflows: ["t2v", "i2v", "flf2v", "ref2v"] };
}

export { VIDEO_WORKFLOW_LABELS };
