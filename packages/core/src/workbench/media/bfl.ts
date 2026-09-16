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
import { encodeB64, fetchImageBytes, getJson, postJson, pollUntil } from "./http";

export const BFL_BASE_URL = "https://api.bfl.ai";

/**
 * Black Forest Labs (FLUX) — asynchronous: `POST /v1/{model}` returns
 * `{ id, polling_url }`, then poll `polling_url` until `status === "Ready"`
 * and download `result.sample` (a signed URL valid ~10 minutes). Auth is the
 * `x-key` header. Editing passes reference bytes as base64 `input_image`
 * (plus `input_image_2..` for multi-reference FLUX.2 models).
 */

interface BflModel extends MediaModelInfo {
  readonly label: string;
}

const MODELS: BflModel[] = [
  { id: "flux-2-pro", label: "FLUX.2 [pro]", modes: ["t2i", "i2i"], maxReferences: 8, maxCount: 1 },
  { id: "flux-2-flex", label: "FLUX.2 [flex]", modes: ["t2i", "i2i"], maxReferences: 8, maxCount: 1 },
  { id: "flux-2-max", label: "FLUX.2 [max]", modes: ["t2i", "i2i"], maxReferences: 8, maxCount: 1 },
  { id: "flux-2-klein-9b", label: "FLUX.2 [klein] 9B", modes: ["t2i", "i2i"], maxReferences: 4, maxCount: 1 },
  { id: "flux-kontext-pro", label: "FLUX.1 Kontext [pro]", modes: ["t2i", "i2i"], maxReferences: 1, maxCount: 1 },
  { id: "flux-kontext-max", label: "FLUX.1 Kontext [max]", modes: ["t2i", "i2i"], maxReferences: 1, maxCount: 1 },
  { id: "flux-pro-1.1-ultra", label: "FLUX 1.1 [pro] Ultra", modes: ["t2i"], maxReferences: 0, maxCount: 1 },
  { id: "flux-dev", label: "FLUX.1 [dev]", modes: ["t2i"], maxReferences: 0, maxCount: 1 },
];

const DEFAULT_MODEL = "flux-2-pro";

function paramsFor(model: BflModel): MediaParamSpec[] {
  const params: MediaParamSpec[] = [
    { key: "width", label: "Width", kind: "number", min: 256, max: 2048, default: 1024, hint: "multiple of 16" },
    { key: "height", label: "Height", kind: "number", min: 256, max: 2048, default: 1024, hint: "multiple of 16" },
    { key: "seed", label: "Seed", kind: "number", min: 0, max: 2_147_483_647 },
  ];
  if (model.id === "flux-2-pro" || model.id === "flux-2-flex" || model.id === "flux-2-max") {
    params.push({ key: "prompt_upsampling", label: "Prompt upsampling", kind: "toggle", default: false });
  }
  return params;
}

interface BflSubmit {
  id?: unknown;
  polling_url?: unknown;
}

export class BflMediaAdapter implements MediaGenAdapter {
  readonly id = "bfl";

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
      provider: "bfl",
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
        "Black Forest Labs API key not configured — add one in Settings → Providers, or set BFL_API_KEY.",
        { retryable: false },
      );
    }
    const baseUrl = (credentials.baseUrl ?? BFL_BASE_URL).replace(/\/+$/, "");
    const model = request.model ?? this.defaultModel();
    const params = request.params ?? {};
    const body: Record<string, unknown> = { prompt: request.prompt };
    if (typeof params.width === "number") body.width = round16(params.width);
    if (typeof params.height === "number") body.height = round16(params.height);
    if (typeof params.seed === "number") body.seed = Math.round(params.seed);
    if (typeof params.prompt_upsampling === "boolean") body.prompt_upsampling = params.prompt_upsampling;
    if (request.mode === "i2i") {
      const refs = request.referenceAssetIds ?? [];
      for (let i = 0; i < refs.length; i++) {
        const asset = ctx.readAsset(refs[i]!);
        if (asset === undefined) continue;
        body[i === 0 ? "input_image" : `input_image_${i + 1}`] = encodeB64(asset.bytes);
      }
      if (body.input_image === undefined) {
        throw new MediaGenError("Black Forest Labs image-to-image needs at least one readable reference image.", {
          retryable: false,
        });
      }
    }

    const headers = { "x-key": credentials.apiKey, accept: "application/json", ...(credentials.headers ?? {}) };
    const submitted = (await postJson(this.fetchImpl, `${baseUrl}/v1/${model}`, body, {
      headers,
      signal: ctx.signal,
      label: "Black Forest Labs image request",
    })) as BflSubmit | undefined;
    const pollingUrl = typeof submitted?.polling_url === "string" ? submitted.polling_url : undefined;
    if (pollingUrl === undefined) {
      throw new MediaGenError("Black Forest Labs did not return a polling URL.", { retryable: false });
    }

    const result = await pollUntil<{ sample?: unknown; error?: unknown }>(
      async () => {
        const status = (await getJson(this.fetchImpl, pollingUrl, {
          headers,
          signal: ctx.signal,
          label: "Black Forest Labs poll",
        })) as { status?: unknown; result?: unknown } | undefined;
        const state = typeof status?.status === "string" ? status.status : "Pending";
        if (state === "Ready") {
          const sample = (status?.result as { sample?: unknown } | undefined)?.sample;
          return { done: true, value: { sample } };
        }
        if (state === "Error" || state === "Failed") {
          const message =
            (status?.result as { error?: unknown } | undefined)?.error ??
            (status?.result as { message?: unknown } | undefined)?.message;
          return { done: true, error: typeof message === "string" ? message : "Black Forest Labs generation failed." };
        }
        return { done: false };
      },
      { signal: ctx.signal, label: "Black Forest Labs generation" },
    );

    const sample = result.sample;
    if (typeof sample !== "string" || sample.length === 0) {
      throw new MediaGenError("Black Forest Labs returned no image for this request.", { retryable: false });
    }
    const image: MediaGeneratedImage = await fetchImageBytes(this.fetchImpl, sample, {
      signal: ctx.signal,
      fallbackMime: "image/png",
      label: "Black Forest Labs image download",
    });
    return { images: [image] };
  }
}

function round16(value: number): number {
  const rounded = Math.round(value);
  const clamped = Math.max(256, Math.min(2048, rounded));
  return clamped - (clamped % 16);
}

function infoFor(model?: string): BflModel {
  const id = model !== undefined && model.length > 0 ? model : DEFAULT_MODEL;
  return (
    MODELS.find((m) => m.id === id) ?? {
      id,
      label: id,
      modes: ["t2i", "i2i"],
      maxReferences: 8,
      maxCount: 1,
    }
  );
}
