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
import { decodeB64, postJson, toGeneratedImage } from "./http";

export const MINIMAX_BASE_URL = "https://api.minimax.io";

/**
 * MiniMax image API — `POST /v1/image_generation` with a Bearer key, returning
 * base64 images in `data.image_base64[]`. The subject-reference (image-to-image)
 * flow requires a publicly hosted image URL, which bai cannot provide, so this
 * adapter is text-to-image only.
 */

interface MinimaxModel extends MediaModelInfo {
  readonly label: string;
}

const MODELS: MinimaxModel[] = [{ id: "image-01", label: "MiniMax Image 01", modes: ["t2i"], maxReferences: 0, maxCount: 9 }];

const DEFAULT_MODEL = "image-01";

const ASPECT_RATIOS = ["1:1", "16:9", "4:3", "3:2", "2:3", "3:4", "9:16", "21:9"];

function paramsFor(model: MinimaxModel): MediaParamSpec[] {
  return [
    {
      key: "aspect_ratio",
      label: "Aspect ratio",
      kind: "enum",
      options: ASPECT_RATIOS.map((r) => ({ value: r, label: r })),
      default: "1:1",
    },
    { key: "count", label: "Number of images", kind: "range", min: 1, max: model.maxCount, step: 1, default: 1 },
  ];
}

interface MinimaxResponse {
  data?: { image_base64?: unknown };
}

export class MinimaxMediaAdapter implements MediaGenAdapter {
  readonly id = "minimax-image";

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
      provider: this.id,
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
        "MiniMax API key not configured — add one in Settings → Providers, or set MINIMAX_API_KEY.",
        { retryable: false },
      );
    }
    if (request.mode === "i2i") {
      throw new MediaGenError("MiniMax image-to-image needs a hosted reference URL and is not supported.", {
        retryable: false,
      });
    }
    const baseUrl = (credentials.baseUrl ?? MINIMAX_BASE_URL).replace(/\/+$/, "");
    const model = request.model ?? this.defaultModel();
    const params = request.params ?? {};
    const body: Record<string, unknown> = { model, prompt: request.prompt, response_format: "base64" };
    if (typeof params.aspect_ratio === "string" && params.aspect_ratio.length > 0) body.aspect_ratio = params.aspect_ratio;
    if (typeof params.count === "number") body.n = Math.max(1, Math.round(params.count));

    const json = (await postJson(this.fetchImpl, `${baseUrl}/v1/image_generation`, body, {
      headers: { authorization: `Bearer ${credentials.apiKey}`, ...(credentials.headers ?? {}) },
      signal: ctx.signal,
      label: "MiniMax image request",
    })) as MinimaxResponse | undefined;

    const entries = json?.data?.image_base64;
    const list = Array.isArray(entries) ? entries : typeof entries === "string" ? [entries] : [];
    const images: MediaGeneratedImage[] = [];
    for (const entry of list) {
      if (typeof entry !== "string" || entry.length === 0) continue;
      images.push(toGeneratedImage(decodeB64(entry), undefined, "image/jpeg"));
    }
    if (images.length === 0) {
      throw new MediaGenError("MiniMax returned no images for this request.", { retryable: false });
    }
    return { images };
  }
}

function infoFor(model?: string): MinimaxModel {
  const id = model !== undefined && model.length > 0 ? model : DEFAULT_MODEL;
  return MODELS.find((m) => m.id === id) ?? { id, label: id, modes: ["t2i"], maxReferences: 0, maxCount: 9 };
}
