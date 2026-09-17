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
import { decodeB64, getJson, postJson, pollUntil } from "../http";
import { fetchVideoBytes } from "../video-http";
import { toGeneratedVideo } from "../video-http";
import {
  aspectParam,
  durationParam,
  generateAudioParam,
  negativePromptParam,
  referenceImages,
  resolutionParam,
  seedParam,
  workflow,
} from "../workflow-specs";
import { firstInput, inputBase64, inputBytes, inputsByRole, resolveInputs, type ResolvedInput } from "../upload";

export const GEMINI_VEO_BASE_URL = "https://generativelanguage.googleapis.com";

/**
 * Google Veo 3.1 via the Gemini API: `:predictLongRunning` returns an
 * operation, polled until `done`, then the Files API URI (48 h) is downloaded.
 * Accepts inline base64 image inputs (first/last frame or up to 3 asset
 * references), so local bytes work without an upload hop.
 */

interface VeoModel extends VideoModelInfo {
  readonly label: string;
}

const MODELS: VeoModel[] = [
  { id: "veo-3.1-generate-preview", label: "Veo 3.1", workflows: ["t2v", "i2v", "flf2v", "ref2v"], rates: [{ label: "Price", value: "$0.40 / s · $0.60 / s (4K)" }] },
  { id: "veo-3.1-fast-generate-preview", label: "Veo 3.1 Fast", workflows: ["t2v", "i2v", "flf2v", "ref2v"], rates: [{ label: "Price", value: "$0.10–0.30 / s" }] },
];

const DEFAULT_MODEL = "veo-3.1-generate-preview";

const WF_INPUTS: Partial<Record<VideoWorkflow, VideoInputSlot[]>> = {
  i2v: [{ role: "first_frame", label: "First frame", accepts: ["image"], required: true }],
  flf2v: [
    { role: "first_frame", label: "First frame", accepts: ["image"], required: true },
    { role: "last_frame", label: "Last frame", accepts: ["image"] },
  ],
  ref2v: [referenceImages(3)],
};

function workflowsFor(model: VeoModel): VideoWorkflowSpec[] {
  return model.workflows.map((id) => workflow(id, WF_INPUTS[id] ?? []));
}

function params(): MediaParamSpec[] {
  return [durationParam(4, 8, 8), resolutionParam(["720p", "1080p", "4k"], "720p"), aspectParam(["16:9", "9:16"], "16:9"), generateAudioParam, negativePromptParam, seedParam];
}

export class GeminiVeoAdapter implements VideoGenAdapter {
  readonly id = "gemini";

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
    return { provider: "gemini", model: info.id, workflows: workflowsFor(info), params: params() };
  }

  async generate(input: {
    request: VideoGenRequest;
    credentials: MediaAdapterCredentials;
    ctx: MediaGenContext;
  }): Promise<VideoGenerateResult> {
    const { request, credentials, ctx } = input;
    if (credentials.apiKey === undefined || credentials.apiKey.length === 0) {
      throw new MediaGenError(
        "Gemini API key not configured — add one in Settings → Video Generation, or set GEMINI_API_KEY.",
        { retryable: false },
      );
    }
    const base = (credentials.baseUrl ?? GEMINI_VEO_BASE_URL).replace(/\/+$/, "");
    const headers = { "x-goog-api-key": credentials.apiKey, ...(credentials.headers ?? {}) };
    const model = request.model ?? this.defaultModel();
    const inputs = resolveInputs(request.inputs, ctx);
    const body = buildBody(request, inputs);

    const submitted = (await postJson(this.fetchImpl, `${base}/v1beta/models/${model}:predictLongRunning`, body, {
      headers,
      signal: ctx.signal,
      label: "Veo request",
    })) as { name?: unknown } | undefined;
    const operation = typeof submitted?.name === "string" ? submitted.name : undefined;
    if (operation === undefined) throw new MediaGenError("Veo did not return an operation.", { retryable: false });

    const finalOp = await pollUntil<Record<string, unknown>>(
      async () => {
        const status = (await getJson(this.fetchImpl, `${base}/v1beta/${operation}`, {
          headers,
          signal: ctx.signal,
          label: "Veo poll",
        })) as Record<string, unknown> | undefined;
        if (status?.done === true) {
          if (status.error !== undefined) {
            const message =
              typeof status.error === "object" && status.error !== null && typeof (status.error as { message?: unknown }).message === "string"
                ? ((status.error as { message: string }).message)
                : "Veo generation failed.";
            return { done: true, error: message, retryable: false };
          }
          return { done: true, value: status };
        }
        return { done: false };
      },
      { signal: ctx.signal, label: "Veo generation", timeoutMs: 850_000 },
    );

    const video = await this.extractVideo(finalOp, headers, ctx);
    return { videos: [video] };
  }

  private async extractVideo(
    operation: Record<string, unknown>,
    headers: Record<string, string>,
    ctx: MediaGenContext,
  ): Promise<ReturnType<typeof toGeneratedVideo>> {
    const response = operation.response as Record<string, unknown> | undefined;
    const gen = response?.generateVideoResponse as Record<string, unknown> | undefined;
    const samples = gen?.generatedSamples;
    const first = Array.isArray(samples) ? (samples[0] as Record<string, unknown> | undefined) : undefined;
    const video = first?.video as Record<string, unknown> | undefined;
    if (video !== undefined) {
      if (typeof video.videoBytes === "string" && video.videoBytes.length > 0) {
        return toGeneratedVideo(decodeB64(video.videoBytes), "video/mp4", "video/mp4");
      }
      if (typeof video.uri === "string" && video.uri.length > 0) {
        return fetchVideoBytes(this.fetchImpl, withKey(video.uri, headers), {
          headers,
          signal: ctx.signal,
          fallbackMime: "video/mp4",
          label: "Veo video download",
        });
      }
    }
    throw new MediaGenError("Veo returned no video.", { retryable: false });
  }
}

function buildBody(request: VideoGenRequest, inputs: ResolvedInput[]): Record<string, unknown> {
  const params = request.params ?? {};
  const instance: Record<string, unknown> = { prompt: request.prompt };
  const refs = inputsByRole(inputs, "reference_image");
  const first = firstInput(inputs, "first_frame");
  const last = firstInput(inputs, "last_frame");
  if (refs.length > 0) {
    instance.referenceImages = refs.map((r) => ({
      image: { bytesBase64Encoded: inputBase64(r), mimeType: r.mime },
      referenceType: "asset",
    }));
  } else {
    if (first !== undefined) instance.image = inlineImage(first);
    if (last !== undefined) instance.lastFrame = inlineImage(last);
  }

  const parameters: Record<string, unknown> = {};
  if (typeof params.duration === "number") parameters.durationSeconds = Math.max(1, Math.round(params.duration));
  if (typeof params.resolution === "string") parameters.resolution = params.resolution;
  if (typeof params.aspect_ratio === "string") parameters.aspectRatio = params.aspect_ratio;
  if (typeof params.negative_prompt === "string" && params.negative_prompt.length > 0) {
    parameters.negativePrompt = params.negative_prompt;
  }
  if (typeof params.generate_audio === "boolean") parameters.generateAudio = params.generate_audio;
  if (typeof params.seed === "number") parameters.seed = Math.round(params.seed);
  return { instances: [instance], parameters };
}

function inlineImage(input: ResolvedInput): Record<string, unknown> {
  return { bytesBase64Encoded: inputBase64(input), mimeType: input.mime };
}

/** Append the API key for a Files API download URL (best-effort). */
function withKey(uri: string, headers: Record<string, string>): string {
  const key = headers["x-goog-api-key"];
  if (uri.startsWith("http")) return uri;
  const base = GEMINI_VEO_BASE_URL;
  return key !== undefined ? `${base}/v1beta/${uri.replace(/^\/+/, "")}?key=${encodeURIComponent(key)}` : `${base}/v1beta/${uri}`;
}

function infoFor(model?: string): VeoModel {
  const id = model !== undefined && model.length > 0 ? model : DEFAULT_MODEL;
  return MODELS.find((m) => m.id === id) ?? { id, label: id, workflows: ["t2v", "i2v", "flf2v", "ref2v"] };
}
