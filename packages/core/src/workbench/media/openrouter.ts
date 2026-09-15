import type {
  MediaCapabilities,
  MediaGenRequest,
  MediaModelInfo,
  MediaModelRate,
  MediaMode,
  MediaParamSpec,
  MediaParamValue,
} from "@bai/shared";
import {
  MediaGenError,
  type MediaGenAdapter,
  type MediaGenContext,
  type MediaGenerateResult,
  type MediaGeneratedImage,
} from "./adapter";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/**
 * OpenRouter's dedicated Image API (`POST /images`, docs 2026): returns base64
 * images in `data[].b64_json` (not URLs) and takes `aspect_ratio`/`resolution`/
 * `quality`/`output_format`/…; image-to-image rides `input_references` data
 * URLs. This adapter owns that wire shape — the workbench never sees it.
 */

interface CuratedModel extends MediaModelInfo {
  readonly label: string;
}

/**
 * Curated selectable models. OpenRouter's live `/images/models` list is not
 * fetched here (shape/capability variance is per-endpoint); the picker is
 * creatable so any model id can be typed. `maxCount`/`maxReferences` are
 * conservative per-model values from the docs.
 */
const CURATED_MODELS: CuratedModel[] = [
  { id: "google/gemini-3-pro-image", label: "Gemini 3 Pro Image (Nano Banana Pro)", modes: ["t2i", "i2i"], maxReferences: 14, maxCount: 1 },
  { id: "google/gemini-3.1-flash-image", label: "Gemini 3.1 Flash Image", modes: ["t2i", "i2i"], maxReferences: 14, maxCount: 1 },
  { id: "google/gemini-2.5-flash-image", label: "Gemini 2.5 Flash Image", modes: ["t2i", "i2i"], maxReferences: 3, maxCount: 1 },
  { id: "openai/gpt-image-2", label: "GPT Image 2", modes: ["t2i", "i2i"], maxReferences: 16, maxCount: 10 },
  { id: "openai/gpt-image-1", label: "GPT Image 1", modes: ["t2i", "i2i"], maxReferences: 16, maxCount: 10 },
  { id: "black-forest-labs/flux.2-pro", label: "FLUX.2 Pro", modes: ["t2i", "i2i"], maxReferences: 8, maxCount: 1 },
  { id: "black-forest-labs/flux.2-flex", label: "FLUX.2 Flex", modes: ["t2i", "i2i"], maxReferences: 8, maxCount: 1 },
  { id: "bytedance-seed/seedream-4.5", label: "Seedream 4.5", modes: ["t2i", "i2i"], maxReferences: 14, maxCount: 10 },
  { id: "x-ai/grok-imagine-image-2.0", label: "Grok Imagine 2.0", modes: ["t2i", "i2i"], maxReferences: 3, maxCount: 1 },
  { id: "qwen/qwen-image-3", label: "Qwen Image 3", modes: ["t2i", "i2i"], maxReferences: 4, maxCount: 6 },
  { id: "recraft/recraft-v4", label: "Recraft V4", modes: ["t2i", "i2i"], maxReferences: 1, maxCount: 6 },
];

const DEFAULT_MODEL = "google/gemini-3-pro-image";

/**
 * Offline/fallback rates for the models whose published pricing we know
 * (USD per 1M tokens, from OpenRouter endpoint pricing). Live pricing from the
 * catalog overrides these when the network is available.
 */
const CURATED_RATES: Record<string, MediaModelRate[]> = {
  "google/gemini-2.5-flash-image": [
    { label: "In (img)", value: fmtPerM(3e-7) },
    { label: "Out (img)", value: fmtPerM(3e-5) },
  ],
  "openai/gpt-image-1": [
    { label: "In", value: fmtPerM(5e-6) },
    { label: "In (img)", value: fmtPerM(1e-5) },
    { label: "Out (img)", value: fmtPerM(4e-5) },
  ],
};

const ASPECT_RATIOS = [
  "auto",
  "1:1",
  "1:2",
  "2:3",
  "3:2",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "16:9",
  "9:19.5",
  "19.5:9",
  "21:9",
];

/** Parameter vocabulary shared by every OpenRouter image model (docs). */
function paramsFor(model: CuratedModel): MediaParamSpec[] {
  return [
    {
      key: "aspect_ratio",
      label: "Aspect ratio",
      kind: "enum",
      options: ASPECT_RATIOS.map((r) => ({ value: r, label: r })),
      default: "1:1",
    },
    {
      key: "resolution",
      label: "Resolution",
      kind: "enum",
      options: ["1K", "2K", "4K"].map((r) => ({ value: r, label: r })),
      default: "1K",
    },
    {
      key: "quality",
      label: "Quality",
      kind: "enum",
      options: ["auto", "low", "medium", "high", "xhigh", "max"].map((q) => ({ value: q, label: q })),
      default: "auto",
    },
    {
      key: "output_format",
      label: "Output format",
      kind: "enum",
      options: ["png", "jpeg", "webp"].map((f) => ({ value: f, label: f })),
      default: "png",
    },
    {
      key: "background",
      label: "Background",
      kind: "enum",
      options: ["auto", "transparent", "opaque"].map((b) => ({ value: b, label: b })),
      default: "auto",
      hint: "transparent needs png/webp",
    },
    {
      key: "output_compression",
      label: "Output compression",
      kind: "range",
      min: 0,
      max: 100,
      step: 1,
      default: 80,
      unit: "%",
    },
    { key: "seed", label: "Seed", kind: "number", min: 0, max: 2_147_483_647 },
    {
      key: "count",
      label: "Number of generations",
      kind: "range",
      min: 1,
      max: model.maxCount,
      step: 1,
      default: 1,
    },
    { key: "allow_fallbacks", label: "Allow provider fallbacks", kind: "toggle", default: true },
  ];
}

export class OpenRouterMediaAdapter implements MediaGenAdapter {
  readonly id = "openrouter";
  /** Live pricing is expensive-ish; cache the enriched list for 10 minutes. */
  private modelsCache: { at: number; models: MediaModelInfo[] } | undefined;

  constructor(private readonly fetchImpl: typeof globalThis.fetch = globalThis.fetch) {}

  defaultModel(): string {
    return DEFAULT_MODEL;
  }

  async listModels(): Promise<MediaModelInfo[]> {
    if (this.modelsCache !== undefined && Date.now() - this.modelsCache.at < 10 * 60_000) {
      return this.modelsCache.models;
    }
    const models: MediaModelInfo[] = CURATED_MODELS.map((m) => ({
      id: m.id,
      label: m.label,
      modes: modesFor(m.maxReferences),
      maxReferences: m.maxReferences,
      maxCount: m.maxCount,
      ...(CURATED_RATES[m.id] !== undefined ? { rates: CURATED_RATES[m.id] } : {}),
    }));
    // Enrich with live pricing from the keyless catalog (`pricing` is USD per
    // token except `image`/`request`, which are per unit). Best-effort: a
    // failed/offline fetch leaves the curated rates in place.
    try {
      const res = await this.fetchImpl(`${OPENROUTER_BASE_URL}/models`, {
        headers: { accept: "application/json" },
      });
      if (res.ok) {
        const json = (await res.json()) as { data?: unknown };
        const data = Array.isArray(json.data) ? json.data : [];
        const byId = new Map<string, Record<string, unknown>>();
        for (const entry of data) {
          if (typeof entry === "object" && entry !== null && typeof (entry as { id?: unknown }).id === "string") {
            byId.set((entry as { id: string }).id, entry as Record<string, unknown>);
          }
        }
        for (const model of models) {
          const live = byId.get(model.id);
          const pricing = live?.pricing;
          const rates = typeof pricing === "object" && pricing !== null ? ratesFromPricing(pricing as Record<string, unknown>) : undefined;
          if (rates !== undefined) model.rates = rates;
        }
      }
    } catch {
      // Offline / catalog unavailable — curated rates stand.
    }
    this.modelsCache = { at: Date.now(), models };
    return models;
  }

  capabilities(model?: string): MediaCapabilities {
    const info = infoFor(model);
    return {
      provider: "openrouter",
      model: info.id,
      modes: modesFor(info.maxReferences),
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
        "OpenRouter API key not configured — add one in Settings → Providers, or set OPENROUTER_API_KEY.",
        { retryable: false },
      );
    }
    const baseUrl = (credentials.baseUrl ?? OPENROUTER_BASE_URL).replace(/\/+$/, "");
    const model = request.model ?? this.defaultModel();
    const body = buildBody(request, model, ctx);
    let res: Response;
    try {
      res = await this.fetchImpl(`${baseUrl}/images`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${credentials.apiKey}`,
          "x-title": "bai",
          ...(credentials.headers ?? {}),
        },
        body: JSON.stringify(body),
        signal: ctx.signal,
      });
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      throw new MediaGenError(err instanceof Error ? err.message : String(err), { retryable: true });
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const message = errorMessage(text) ?? `OpenRouter image request failed (${res.status})`;
      throw new MediaGenError(message, {
        retryable: res.status === 429 || res.status >= 500,
        status: res.status,
      });
    }
    const json = (await res.json().catch(() => undefined)) as
      | { data?: unknown; usage?: { cost?: unknown } }
      | undefined;
    const data = Array.isArray(json?.data) ? json.data : [];
    const files: MediaGeneratedImage[] = [];
    for (const entry of data) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as { b64_json?: unknown; media_type?: unknown };
      if (typeof record.b64_json !== "string" || record.b64_json.length === 0) continue;
      const bytes = new Uint8Array(Buffer.from(record.b64_json, "base64"));
      if (bytes.byteLength === 0) continue;
      const mime =
        typeof record.media_type === "string" && record.media_type.length > 0
          ? record.media_type
          : mimeFromFormat(request.params?.output_format);
      files.push({ mime, ext: extForMime(mime), bytes });
    }
    if (files.length === 0) {
      throw new MediaGenError("OpenRouter returned no images for this request.", { retryable: false });
    }
    const cost = json?.usage?.cost;
    const costUsd = typeof cost === "number" && Number.isFinite(cost) ? cost : undefined;
    return { images: files, ...(costUsd !== undefined ? { costUsd } : {}) };
  }
}

/** A model supports image-to-image iff it accepts at least one reference. */
function modesFor(maxReferences: number): MediaMode[] {
  return maxReferences > 0 ? ["t2i", "i2i"] : ["t2i"];
}

function infoFor(model?: string): CuratedModel {
  const id = model !== undefined && model.length > 0 ? model : DEFAULT_MODEL;
  return (
    CURATED_MODELS.find((m) => m.id === id) ?? {
      id,
      label: id,
      modes: modesFor(4),
      maxReferences: 4,
      maxCount: 4,
    }
  );
}

function buildBody(request: MediaGenRequest, model: string, ctx: MediaGenContext): Record<string, unknown> {
  const params = request.params ?? {};
  const body: Record<string, unknown> = { model, prompt: request.prompt };
  for (const key of ["aspect_ratio", "resolution", "quality", "output_format", "background"] as const) {
    const value = params[key];
    if (typeof value === "string" && value.length > 0 && value !== "auto") body[key] = value;
  }
  if (typeof params.output_compression === "number") body.output_compression = params.output_compression;
  if (typeof params.seed === "number") body.seed = params.seed;
  if (typeof params.count === "number") body.n = Math.max(1, Math.round(params.count));
  const allowFallbacks = params.allow_fallbacks;
  if (typeof allowFallbacks === "boolean") body.provider = { allow_fallbacks: allowFallbacks };
  if (request.mode === "i2i") {
    const refs = (request.referenceAssetIds ?? [])
      .map((id) => {
        const asset = ctx.readAsset(id);
        if (asset === undefined) return undefined;
        return { type: "image_url", image_url: { url: toDataUrl(asset.mime, asset.bytes) } };
      })
      .filter((r): r is { type: string; image_url: { url: string } } => r !== undefined);
    if (refs.length > 0) body.input_references = refs;
  }
  return body;
}

function toDataUrl(mime: string, bytes: Uint8Array): string {
  return `data:${mime.length > 0 ? mime : "image/png"};base64,${Buffer.from(bytes).toString("base64")}`;
}

function mimeFromFormat(format: MediaParamValue | undefined): string {
  switch (format) {
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    default:
      return "image/png";
  }
}

function extForMime(mime: string): string {
  switch (mime) {
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/svg+xml":
      return "svg";
    case "image/gif":
      return "gif";
    default:
      return "png";
  }
}

function errorMessage(text: string): string | undefined {
  if (text.length === 0) return undefined;
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown } | string };
    if (typeof parsed.error === "string") return parsed.error;
    if (typeof parsed.error === "object" && parsed.error !== null && typeof parsed.error.message === "string") {
      return parsed.error.message;
    }
  } catch {
    // fall through to the raw text
  }
  return text.slice(0, 400);
}

/**
 * Map an OpenRouter `pricing` object to display rates. Values are USD strings
 * (or numbers); `image`/`request` are per-unit, the rest are per-token (shown
 * per 1M tokens).
 */
function ratesFromPricing(pricing: Record<string, unknown>): MediaModelRate[] | undefined {
  const rates: MediaModelRate[] = [];
  const prompt = num(pricing.prompt);
  if (prompt !== undefined) rates.push({ label: "In", value: fmtPerM(prompt) });
  const inImg = num(pricing.input_image);
  if (inImg !== undefined) rates.push({ label: "In (img)", value: fmtPerM(inImg) });
  const outImg = num(pricing.output_image);
  if (outImg !== undefined) rates.push({ label: "Out (img)", value: fmtPerM(outImg) });
  const completion = num(pricing.completion);
  if (completion !== undefined) rates.push({ label: "Out", value: fmtPerM(completion) });
  const perImage = num(pricing.image);
  if (perImage !== undefined) rates.push({ label: "Image", value: `${fmtUsd(perImage)} / image` });
  const perRequest = num(pricing.request);
  if (perRequest !== undefined) rates.push({ label: "Request", value: `${fmtUsd(perRequest)} / request` });
  return rates.length > 0 ? rates : undefined;
}

function num(value: unknown): number | undefined {
  const n = typeof value === "string" ? Number.parseFloat(value) : typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** USD per token → "$X / 1M tok". */
function fmtPerM(perToken: number): string {
  return `${fmtUsd(perToken * 1_000_000)} / 1M tok`;
}

function fmtUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return "$0";
  if (usd < 0.01) return `$${Number(usd.toPrecision(2))}`;
  if (usd < 1) return `$${Number(usd.toFixed(3))}`;
  return `$${Number(usd.toFixed(2))}`;
}
