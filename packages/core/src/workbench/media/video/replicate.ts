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
import { getJson, pollUntil, postJson, toDataUrl } from "../http";
import { fetchVideoBytes } from "../video-http";
import {
  aspectParam,
  durationParam,
  generateAudioParam,
  referenceImages,
  resolutionParam,
  seedParam,
  sourceVideoParam,
  workflow,
} from "../workflow-specs";
import { firstInput, inputBytes, inputsByRole, resolveInputs, uploadReplicateFile, type ResolvedInput } from "../upload";

export const REPLICATE_VIDEO_BASE = "https://api.replicate.com/v1";

/**
 * Replicate — one predictions API for every model. Official models accept
 * `POST /models/{owner}/{name}/predictions`; inputs are HTTPS URLs or data URLs
 * (≤256 KB), so larger local references go through the Files API. Outputs are
 * deleted after ~1 h, so bytes are downloaded inline.
 */

interface RepModel extends VideoModelInfo {
  readonly label: string;
}

const MODELS: RepModel[] = [
  { id: "bytedance/seedance-2.0", label: "Seedance 2.0", workflows: ["t2v", "i2v", "flf2v", "ref2v", "v2v", "extend"], rates: [{ label: "Price", value: "~$0.93 / 5s (1080p)" }] },
  { id: "google/veo-3.1", label: "Veo 3.1", workflows: ["t2v", "i2v", "flf2v", "ref2v"], rates: [{ label: "Price", value: "$0.40 / s" }] },
  { id: "minimax/video-01", label: "MiniMax Video-01", workflows: ["t2v", "i2v", "flf2v"], rates: [{ label: "Price", value: "$0.05–0.13 / s" }] },
  { id: "kwaivgi/kling-v2.1", label: "Kling 2.1", workflows: ["t2v", "i2v", "flf2v"], rates: [{ label: "Price", value: "$0.084–0.14 / s" }] },
  { id: "luma/ray-2", label: "Luma Ray 2", workflows: ["t2v", "i2v"], rates: [{ label: "Price", value: "$0.30 / 5s · $1.20 / 5s (1080p)" }] },
];

const DEFAULT_MODEL = "bytedance/seedance-2.0";

const WF_INPUTS: Partial<Record<VideoWorkflow, VideoInputSlot[]>> = {
  i2v: [{ role: "first_frame", label: "First frame", accepts: ["image"], required: true }],
  flf2v: [
    { role: "first_frame", label: "First frame", accepts: ["image"], required: true },
    { role: "last_frame", label: "Last frame", accepts: ["image"] },
  ],
  ref2v: [referenceImages(9)],
  v2v: [sourceVideoParam()],
  extend: [sourceVideoParam()],
};

function workflowsFor(model: RepModel): VideoWorkflowSpec[] {
  return model.workflows.map((id) => workflow(id, WF_INPUTS[id] ?? []));
}

function params(): MediaParamSpec[] {
  return [durationParam(1, 15, 8), resolutionParam(["480p", "720p", "1080p"], "720p"), aspectParam(), generateAudioParam, seedParam];
}

export class ReplicateVideoAdapter implements VideoGenAdapter {
  readonly id = "replicate";

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
    return { provider: "replicate", model: info.id, workflows: workflowsFor(info), params: params() };
  }

  async generate(input: {
    request: VideoGenRequest;
    credentials: MediaAdapterCredentials;
    ctx: MediaGenContext;
  }): Promise<VideoGenerateResult> {
    const { request, credentials, ctx } = input;
    if (credentials.apiKey === undefined || credentials.apiKey.length === 0) {
      throw new MediaGenError(
        "Replicate API token not configured — add one in Settings → Video Generation, or set REPLICATE_API_TOKEN.",
        { retryable: false },
      );
    }
    const base = (credentials.baseUrl ?? REPLICATE_VIDEO_BASE).replace(/\/+$/, "");
    const headers = { authorization: `Bearer ${credentials.apiKey}` };
    const model = request.model ?? this.defaultModel();
    const inputs = resolveInputs(request.inputs, ctx);
    const ref = async (value: ResolvedInput): Promise<string> => {
      if (value.url !== undefined && value.url.length > 0) return value.url;
      const bytes = inputBytes(value);
      if (bytes.byteLength <= 256 * 1024) return toDataUrl(value.mime, bytes);
      return uploadReplicateFile(this.fetchImpl, credentials.apiKey!, bytes, value.mime, `${value.role}.bin`, ctx.signal);
    };
    const body = await buildInput(request, inputs, ref);

    const submitted = (await postJson(
      this.fetchImpl,
      `${base}/models/${model}/predictions`,
      { input: body },
      { headers: { ...headers, prefer: "wait=60" }, signal: ctx.signal, label: "Replicate video request" },
    )) as Record<string, unknown> | undefined;
    const id = typeof submitted?.id === "string" ? submitted.id : undefined;
    if (id === undefined) throw new MediaGenError("Replicate did not return a prediction id.", { retryable: false });

    let cost: number | undefined;
    const prediction = await pollUntil<Record<string, unknown>>(
      async () => {
        const status = (await getJson(this.fetchImpl, `${base}/predictions/${id}`, {
          headers,
          signal: ctx.signal,
          label: "Replicate video poll",
        })) as Record<string, unknown> | undefined;
        const state = typeof status?.status === "string" ? status.status : "starting";
        if (state === "succeeded") return { done: true, value: status ?? {} };
        if (state === "failed" || state === "canceled") {
          const error = typeof status?.error === "string" ? status.error : `Replicate prediction ${state}.`;
          return { done: true, error, retryable: false };
        }
        return { done: false };
      },
      { signal: ctx.signal, label: "Replicate video generation", timeoutMs: 850_000 },
    );

    const urls = outputUrls(prediction.output);
    if (urls.length === 0) throw new MediaGenError("Replicate returned no video.", { retryable: false });
    const video = await fetchVideoBytes(this.fetchImpl, urls[0]!, {
      headers,
      signal: ctx.signal,
      fallbackMime: "video/mp4",
      label: "Replicate video download",
    });
    return { videos: [video], ...(cost !== undefined ? { costUsd: cost } : {}) };
  }
}

type RefFn = (value: ResolvedInput) => Promise<string>;

async function buildInput(request: VideoGenRequest, inputs: ResolvedInput[], ref: RefFn): Promise<Record<string, unknown>> {
  const params = request.params ?? {};
  const body: Record<string, unknown> = { prompt: request.prompt };
  for (const key of ["resolution", "aspect_ratio"] as const) {
    const value = params[key];
    if (typeof value === "string" && value.length > 0) body[key] = value;
  }
  if (typeof params.duration === "number") body.duration = Math.max(1, Math.round(params.duration));
  if (typeof params.seed === "number") body.seed = Math.round(params.seed);
  if (typeof params.generate_audio === "boolean") body.generate_audio = params.generate_audio;

  const first = firstInput(inputs, "first_frame");
  if (first !== undefined) body.image = await ref(first);
  const last = firstInput(inputs, "last_frame");
  if (last !== undefined) body.last_frame = await ref(last);
  const refs = inputsByRole(inputs, "reference_image");
  if (refs.length > 0) body.reference_images = await Promise.all(refs.map((r) => ref(r)));
  const source = firstInput(inputs, "source_video");
  if (source !== undefined) body.video = await ref(source);
  const audio = firstInput(inputs, "reference_audio");
  if (audio !== undefined) body.audio = await ref(audio);
  return body;
}

function outputUrls(output: unknown): string[] {
  if (typeof output === "string" && output.length > 0) return [output];
  if (Array.isArray(output)) return output.filter((u): u is string => typeof u === "string" && u.length > 0);
  if (typeof output === "object" && output !== null) {
    const url = (output as { url?: unknown }).url;
    if (typeof url === "string" && url.length > 0) return [url];
  }
  return [];
}

function infoFor(model?: string): RepModel {
  const id = model !== undefined && model.length > 0 ? model : DEFAULT_MODEL;
  return MODELS.find((m) => m.id === id) ?? { id, label: id, workflows: ["t2v", "i2v"] };
}
