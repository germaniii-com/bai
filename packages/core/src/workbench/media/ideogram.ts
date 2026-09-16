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
import { bytesToBlob, fetchImageBytes, postForm } from "./http";

export const IDEOGRAM_BASE_URL = "https://api.ideogram.ai";

/**
 * Ideogram — `POST /v1/ideogram-v3/generate` as multipart/form-data with the
 * `Api-Key` header. Results are temporary URLs, downloaded here. Image-to-image
 * rides `character_reference_images` (one reference).
 */

interface IdeogramModel extends MediaModelInfo {
  readonly label: string;
}

const MODELS: IdeogramModel[] = [
  { id: "ideogram-v3", label: "Ideogram 3.0", modes: ["t2i", "i2i"], maxReferences: 1, maxCount: 8 },
];

const DEFAULT_MODEL = "ideogram-v3";

const ASPECT_RATIOS = ["1x1", "16x9", "9x16", "4x3", "3x4", "3x2", "2x3", "16x10", "10x16", "21x9", "9x21"];

function paramsFor(model: IdeogramModel): MediaParamSpec[] {
  return [
    {
      key: "aspect_ratio",
      label: "Aspect ratio",
      kind: "enum",
      options: ASPECT_RATIOS.map((r) => ({ value: r, label: r })),
      default: "1x1",
    },
    {
      key: "rendering_speed",
      label: "Rendering speed",
      kind: "enum",
      options: ["TURBO", "DEFAULT", "QUALITY"].map((v) => ({ value: v, label: v })),
      default: "DEFAULT",
    },
    { key: "negative_prompt", label: "Negative prompt", kind: "text", placeholder: "what to avoid" },
    { key: "seed", label: "Seed", kind: "number", min: 0, max: 2_147_483_647 },
    { key: "count", label: "Number of images", kind: "range", min: 1, max: model.maxCount, step: 1, default: 1 },
  ];
}

interface IdeogramResponse {
  data?: unknown;
}

export class IdeogramMediaAdapter implements MediaGenAdapter {
  readonly id = "ideogram";

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
      provider: "ideogram",
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
        "Ideogram API key not configured — add one in Settings → Providers, or set IDEOGRAM_API_KEY.",
        { retryable: false },
      );
    }
    const baseUrl = (credentials.baseUrl ?? IDEOGRAM_BASE_URL).replace(/\/+$/, "");
    const params = request.params ?? {};

    const form = new FormData();
    form.set("prompt", request.prompt);
    for (const key of ["aspect_ratio", "rendering_speed", "negative_prompt"] as const) {
      const value = params[key];
      if (typeof value === "string" && value.length > 0) form.set(key, value);
    }
    if (typeof params.seed === "number") form.set("seed", String(Math.round(params.seed)));
    if (typeof params.count === "number") form.set("num_images", String(Math.max(1, Math.round(params.count))));
    if (request.mode === "i2i") {
      const refId = request.referenceAssetIds?.[0];
      const asset = refId !== undefined ? ctx.readAsset(refId) : undefined;
      if (asset === undefined) {
        throw new MediaGenError("Ideogram image-to-image needs a readable reference image.", { retryable: false });
      }
      form.append("character_reference_images", bytesToBlob(asset.bytes, asset.mime), "reference.png");
    }

    const res = await postForm(this.fetchImpl, `${baseUrl}/v1/ideogram-v3/generate`, form, {
      headers: { "Api-Key": credentials.apiKey, ...(credentials.headers ?? {}) },
      signal: ctx.signal,
      label: "Ideogram image request",
    });
    const json = (await res.json().catch(() => undefined)) as IdeogramResponse | undefined;
    const entries = Array.isArray(json?.data) ? json.data : [];
    const images: MediaGeneratedImage[] = [];
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null) continue;
      const url = (entry as { url?: unknown }).url;
      if (typeof url !== "string" || url.length === 0) continue;
      images.push(
        await fetchImageBytes(this.fetchImpl, url, {
          signal: ctx.signal,
          fallbackMime: "image/png",
          label: "Ideogram image download",
        }),
      );
    }
    if (images.length === 0) {
      throw new MediaGenError("Ideogram returned no images for this request.", { retryable: false });
    }
    return { images };
  }
}

function infoFor(model?: string): IdeogramModel {
  const id = model !== undefined && model.length > 0 ? model : DEFAULT_MODEL;
  return MODELS.find((m) => m.id === id) ?? { id, label: id, modes: ["t2i", "i2i"], maxReferences: 1, maxCount: 8 };
}
