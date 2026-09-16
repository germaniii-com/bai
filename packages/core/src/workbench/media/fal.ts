import type {
  MediaCapabilities,
  MediaGenRequest,
  MediaModelInfo,
  MediaParamSpec,
} from "@bai/shared";
import {
  MediaGenError,
  type MediaGenAdapter,
  type MediaGenContext,
  type MediaGenerateResult,
  type MediaGeneratedImage,
} from "./adapter";
import { fetchImageBytes, getJson, postJson, pollUntil } from "./http";

export const FAL_QUEUE_URL = "https://queue.fal.run";

/**
 * fal.ai — asynchronous queue: `POST https://queue.fal.run/{model}` with
 * `Authorization: Key <FAL_KEY>` and the model input as the JSON body, then
 * poll `status_url` (IN_QUEUE → IN_PROGRESS → COMPLETED) and fetch
 * `response_url`. Result media URLs are public but expire; the adapter
 * downloads the bytes. Text-to-image only (image-to-image needs fal's storage
 * upload flow, deferred).
 */

interface FalModel extends MediaModelInfo {
  readonly label: string;
}

const MODELS: FalModel[] = [
  { id: "fal-ai/flux/schnell", label: "FLUX.1 [schnell]", modes: ["t2i"], maxReferences: 0, maxCount: 4 },
  { id: "fal-ai/flux/dev", label: "FLUX.1 [dev]", modes: ["t2i"], maxReferences: 0, maxCount: 4 },
  { id: "fal-ai/flux-pro/v1.1-ultra", label: "FLUX 1.1 [pro] Ultra", modes: ["t2i"], maxReferences: 0, maxCount: 4 },
  { id: "fal-ai/nano-banana-2", label: "Nano Banana 2", modes: ["t2i"], maxReferences: 0, maxCount: 4 },
];

const DEFAULT_MODEL = "fal-ai/flux/schnell";

const IMAGE_SIZES = ["square_hd", "square", "portrait_4_3", "portrait_16_9", "landscape_4_3", "landscape_16_9"];

function paramsFor(model: FalModel): MediaParamSpec[] {
  return [
    {
      key: "image_size",
      label: "Image size",
      kind: "enum",
      options: IMAGE_SIZES.map((v) => ({ value: v, label: v })),
      default: "square_hd",
    },
    { key: "num_inference_steps", label: "Steps", kind: "range", min: 1, max: 50, step: 1, default: 4 },
    { key: "seed", label: "Seed", kind: "number", min: 0, max: 2_147_483_647 },
    { key: "count", label: "Number of images", kind: "range", min: 1, max: model.maxCount, step: 1, default: 1 },
  ];
}

interface FalSubmitted {
  request_id?: unknown;
  status_url?: unknown;
  response_url?: unknown;
}

export class FalMediaAdapter implements MediaGenAdapter {
  readonly id = "fal";

  constructor(private readonly fetchImpl: typeof globalThis.fetch = globalThis.fetch) {}

  defaultModel(): string {
    return DEFAULT_MODEL;
  }

  async listModels(): Promise<MediaModelInfo[]> {
    return MODELS.map((m) => ({ id: m.id, label: m.label, modes: m.modes, maxReferences: m.maxReferences, maxCount: m.maxCount }));
  }

  capabilities(model?: string): MediaCapabilities {
    const info = infoFor(model);
    return {
      provider: "fal",
      model: info.id,
      modes: info.modes,
      maxReferences: info.maxReferences,
      maxCount: info.maxCount,
      params: paramsFor(info),
    };
  }

  async generate(input: {
    request: MediaGenRequest;
    credentials: { apiKey?: string; baseUrl?: string; headers?: Record<string, string> };
    ctx: MediaGenContext;
  }): Promise<MediaGenerateResult> {
    const { request, credentials, ctx } = input;
    if (credentials.apiKey === undefined || credentials.apiKey.length === 0) {
      throw new MediaGenError(
        "fal.ai API key not configured — add one in Settings → Providers, or set FAL_KEY.",
        { retryable: false },
      );
    }
    if (request.mode === "i2i") {
      throw new MediaGenError("fal.ai image-to-image is not supported by this adapter yet.", { retryable: false });
    }
    const baseUrl = (credentials.baseUrl ?? FAL_QUEUE_URL).replace(/\/+$/, "");
    const model = request.model ?? this.defaultModel();
    const params = request.params ?? {};
    const payload: Record<string, unknown> = { prompt: request.prompt };
    if (typeof params.image_size === "string" && params.image_size.length > 0) payload.image_size = params.image_size;
    if (typeof params.num_inference_steps === "number") payload.num_inference_steps = Math.round(params.num_inference_steps);
    if (typeof params.seed === "number") payload.seed = Math.round(params.seed);
    if (typeof params.count === "number") payload.num_images = Math.max(1, Math.round(params.count));

    const headers = { authorization: `Key ${credentials.apiKey}`, ...(credentials.headers ?? {}) };
    const submitted = (await postJson(this.fetchImpl, `${baseUrl}/${model}`, payload, {
      headers,
      signal: ctx.signal,
      label: "fal.ai image request",
    })) as FalSubmitted | undefined;
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
          label: "fal.ai poll",
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
      { signal: ctx.signal, label: "fal.ai generation" },
    );

    const result = (await getJson(this.fetchImpl, responseUrl, {
      headers,
      signal: ctx.signal,
      label: "fal.ai result",
    })) as { images?: unknown; image?: unknown } | undefined;
    const urls = extractUrls(result);
    if (urls.length === 0) {
      throw new MediaGenError("fal.ai returned no images for this request.", { retryable: false });
    }
    const images: MediaGeneratedImage[] = [];
    for (const url of urls) {
      images.push(
        await fetchImageBytes(this.fetchImpl, url, {
          signal: ctx.signal,
          fallbackMime: "image/png",
          label: "fal.ai image download",
        }),
      );
    }
    return { images };
  }
}

function extractUrls(result: { images?: unknown; image?: unknown } | undefined): string[] {
  const urls: string[] = [];
  if (Array.isArray(result?.images)) {
    for (const entry of result.images) {
      if (typeof entry === "object" && entry !== null && typeof (entry as { url?: unknown }).url === "string") {
        urls.push((entry as { url: string }).url);
      } else if (typeof entry === "string") {
        urls.push(entry);
      }
    }
  }
  if (typeof result?.image === "object" && result.image !== null && typeof (result.image as { url?: unknown }).url === "string") {
    urls.push((result.image as { url: string }).url);
  }
  return urls;
}

function infoFor(model?: string): FalModel {
  const id = model !== undefined && model.length > 0 ? model : DEFAULT_MODEL;
  return (
    MODELS.find((m) => m.id === id) ?? {
      id,
      label: id,
      modes: ["t2i"],
      maxReferences: 0,
      maxCount: 4,
    }
  );
}
