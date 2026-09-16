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
import { decodeB64, encodeB64, postJson, toGeneratedImage } from "./http";

export const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com";

/**
 * Google Gemini native image generation ("Nano Banana") via the Interactions
 * API — `POST /v1beta/interactions`, `x-goog-api-key`, text + image input
 * blocks, `response_format: { type: "image", aspect_ratio, image_size }`, and
 * base64 output at `output_image.data`. Imagen endpoints are not used (they
 * were retired in Aug 2026).
 */

interface GeminiModel extends MediaModelInfo {
  readonly label: string;
}

const MODELS: GeminiModel[] = [
  { id: "gemini-3.1-flash-image", label: "Nano Banana 2 (Gemini 3.1 Flash Image)", modes: ["t2i", "i2i"], maxReferences: 14, maxCount: 1 },
  { id: "gemini-3.1-flash-lite-image", label: "Nano Banana 2 Lite", modes: ["t2i", "i2i"], maxReferences: 4, maxCount: 1 },
  { id: "gemini-3-pro-image", label: "Nano Banana Pro (Gemini 3 Pro Image)", modes: ["t2i", "i2i"], maxReferences: 14, maxCount: 1 },
  { id: "gemini-2.5-flash-image", label: "Nano Banana (Gemini 2.5 Flash Image)", modes: ["t2i", "i2i"], maxReferences: 3, maxCount: 1 },
];

const DEFAULT_MODEL = "gemini-3.1-flash-image";

const ASPECT_RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];

function paramsFor(model: GeminiModel): MediaParamSpec[] {
  return [
    {
      key: "aspect_ratio",
      label: "Aspect ratio",
      kind: "enum",
      options: ASPECT_RATIOS.map((r) => ({ value: r, label: r })),
      default: "1:1",
    },
    {
      key: "image_size",
      label: "Resolution",
      kind: "enum",
      options: ["1K", "2K", "4K"].map((r) => ({ value: r, label: r })),
      default: "1K",
    },
  ];
}

export class GeminiMediaAdapter implements MediaGenAdapter {
  readonly id = "gemini";

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
      provider: "gemini",
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
        "Gemini API key not configured — add one in Settings → Providers, or set GEMINI_API_KEY.",
        { retryable: false },
      );
    }
    const baseUrl = (credentials.baseUrl ?? GEMINI_BASE_URL).replace(/\/+$/, "");
    const model = request.model ?? this.defaultModel();
    const info = infoFor(model);
    const params = request.params ?? {};

    const content: Array<Record<string, unknown>> = [{ type: "text", text: request.prompt }];
    if (request.mode === "i2i") {
      const refs = (request.referenceAssetIds ?? []).slice(0, info.maxReferences);
      for (const id of refs) {
        const asset = ctx.readAsset(id);
        if (asset === undefined) continue;
        content.push({ type: "image", mime_type: asset.mime, data: encodeB64(asset.bytes) });
      }
      if (content.length === 1) {
        throw new MediaGenError("Gemini image-to-image needs at least one readable reference image.", { retryable: false });
      }
    }

    const responseFormat: Record<string, unknown> = { type: "image" };
    if (typeof params.aspect_ratio === "string" && params.aspect_ratio.length > 0) {
      responseFormat.aspect_ratio = params.aspect_ratio;
    }
    if (typeof params.image_size === "string" && params.image_size.length > 0) {
      responseFormat.image_size = params.image_size;
    }

    const json = (await postJson(
      this.fetchImpl,
      `${baseUrl}/v1beta/interactions`,
      { model, input: content, response_format: responseFormat },
      {
        headers: { "x-goog-api-key": credentials.apiKey, ...(credentials.headers ?? {}) },
        signal: ctx.signal,
        label: "Gemini image request",
      },
    )) as GeminiInteraction | undefined;

    const image = extractImage(json);
    if (image === undefined) {
      throw new MediaGenError("Gemini returned no image for this request.", { retryable: false });
    }
    return { images: [image] };
  }
}

interface GeminiInteraction {
  output_image?: { data?: unknown; mime_type?: unknown } | unknown;
  outputs?: unknown;
}

/** Read the (last) generated image block, tolerating minor shape variance. */
function extractImage(json: GeminiInteraction | undefined): MediaGeneratedImage | undefined {
  const candidates: unknown[] = [];
  if (json !== undefined) {
    if (Array.isArray(json.output_image)) candidates.push(...json.output_image);
    else if (json.output_image !== undefined) candidates.push(json.output_image);
    if (Array.isArray(json.outputs)) candidates.push(...json.outputs);
  }
  const last = candidates.filter((c): c is { data?: unknown; mime_type?: unknown } => typeof c === "object" && c !== null).at(-1);
  if (last === undefined || typeof last.data !== "string" || last.data.length === 0) return undefined;
  return toGeneratedImage(
    decodeB64(last.data),
    typeof last.mime_type === "string" ? last.mime_type : undefined,
    "image/png",
  );
}

function infoFor(model?: string): GeminiModel {
  const id = model !== undefined && model.length > 0 ? model : DEFAULT_MODEL;
  return (
    MODELS.find((m) => m.id === id) ?? {
      id,
      label: id,
      modes: ["t2i", "i2i"],
      maxReferences: 14,
      maxCount: 1,
    }
  );
}
