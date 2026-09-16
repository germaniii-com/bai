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
} from "./adapter";
import { bytesToBlob, mimeFromFormat, postForm, toGeneratedImage } from "./http";

export const STABILITY_BASE_URL = "https://api.stability.ai";

/**
 * Stability AI — `POST /v2beta/stable-image/generate/{core|sd3|ultra}` with
 * multipart/form-data and `Accept: image/*` (raw bytes back). Image-to-image
 * rides the same endpoint with an `image` file, `mode=image-to-image` and
 * `strength`.
 */

interface StabilityModel extends MediaModelInfo {
  readonly label: string;
  readonly endpoint: string;
}

const MODELS: StabilityModel[] = [
  { id: "core", label: "Stable Image Core", endpoint: "core", modes: ["t2i", "i2i"], maxReferences: 1, maxCount: 1 },
  { id: "sd3.5", label: "Stable Diffusion 3.5", endpoint: "sd3", modes: ["t2i", "i2i"], maxReferences: 1, maxCount: 1 },
  { id: "ultra", label: "Stable Image Ultra", endpoint: "ultra", modes: ["t2i", "i2i"], maxReferences: 1, maxCount: 1 },
];

const DEFAULT_MODEL = "core";

const ASPECT_RATIOS = ["1:1", "16:9", "9:16", "3:2", "2:3", "4:5", "5:4", "21:9", "9:21"];

function paramsFor(model: StabilityModel): MediaParamSpec[] {
  const params: MediaParamSpec[] = [
    {
      key: "aspect_ratio",
      label: "Aspect ratio",
      kind: "enum",
      options: ASPECT_RATIOS.map((r) => ({ value: r, label: r })),
      default: "1:1",
    },
    {
      key: "output_format",
      label: "Output format",
      kind: "enum",
      options: ["png", "jpeg", "webp"].map((f) => ({ value: f, label: f })),
      default: "png",
    },
    { key: "seed", label: "Seed", kind: "number", min: 0, max: 4_294_967_295 },
    { key: "negative_prompt", label: "Negative prompt", kind: "text", placeholder: "what to avoid" },
    { key: "strength", label: "Strength", kind: "range", min: 0, max: 1, step: 0.05, default: 0.6, hint: "image-to-image" },
  ];
  if (model.id === "core") {
    params.push({ key: "style_preset", label: "Style preset", kind: "text", placeholder: "e.g. photographic, anime" });
  }
  return params;
}

export class StabilityMediaAdapter implements MediaGenAdapter {
  readonly id = "stability";

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
      provider: "stability",
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
        "Stability API key not configured — add one in Settings → Providers, or set STABILITY_API_KEY.",
        { retryable: false },
      );
    }
    const baseUrl = (credentials.baseUrl ?? STABILITY_BASE_URL).replace(/\/+$/, "");
    const model = request.model ?? this.defaultModel();
    const info = infoFor(model);
    const params = request.params ?? {};

    const form = new FormData();
    form.set("prompt", request.prompt);
    // The API requires the `files` part for pure text-to-image; an empty string
    // is the documented placeholder when there is no input image.
    form.set("none", "");
    for (const key of ["aspect_ratio", "output_format", "negative_prompt", "style_preset"] as const) {
      const value = params[key];
      if (typeof value === "string" && value.length > 0) form.set(key, value);
    }
    if (typeof params.seed === "number") form.set("seed", String(Math.round(params.seed)));

    if (request.mode === "i2i") {
      const refId = request.referenceAssetIds?.[0];
      const asset = refId !== undefined ? ctx.readAsset(refId) : undefined;
      if (asset === undefined) {
        throw new MediaGenError("Stability image-to-image needs a readable reference image.", { retryable: false });
      }
      form.set("mode", "image-to-image");
      form.append("image", bytesToBlob(asset.bytes, asset.mime), "reference.png");
      form.set("strength", typeof params.strength === "number" ? String(params.strength) : "0.6");
    }

    const res = await postForm(this.fetchImpl, `${baseUrl}/v2beta/stable-image/generate/${info.endpoint}`, form, {
      headers: { authorization: `Bearer ${credentials.apiKey}`, accept: "image/*", ...(credentials.headers ?? {}) },
      signal: ctx.signal,
      label: "Stability image request",
    });
    const bytes = new Uint8Array(await res.arrayBuffer());
    const image = toGeneratedImage(bytes, res.headers.get("content-type") ?? undefined, mimeFromFormat(params.output_format));
    return { images: [image] };
  }
}

function infoFor(model?: string): StabilityModel {
  const id = model !== undefined && model.length > 0 ? model : DEFAULT_MODEL;
  return (
    MODELS.find((m) => m.id === id) ?? {
      id,
      label: id,
      endpoint: id,
      modes: ["t2i", "i2i"],
      maxReferences: 1,
      maxCount: 1,
    }
  );
}
