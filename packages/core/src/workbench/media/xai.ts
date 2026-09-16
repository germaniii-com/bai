import type { MediaGenRequest, MediaParamSpec } from "@bai/shared";
import { toDataUrl } from "./http";
import { OpenAiImagesAdapter, modesFor, type OpenAiImagesModel } from "./openai-images";

/**
 * xAI Grok Imagine — `POST /api.x.ai/v1/images/generations` and a JSON-only
 * `/images/edits` (the multipart OpenAI edit shape is unsupported). Reports its
 * exact billed cost via `usage.cost_in_usd_ticks` (1 USD = 1e10 ticks).
 */

const MODELS: OpenAiImagesModel[] = [
  { id: "grok-imagine-image-2.0", label: "Grok Imagine 2.0", modes: modesFor(3), maxReferences: 3, maxCount: 10 },
  { id: "grok-imagine-image", label: "Grok Imagine", modes: modesFor(1), maxReferences: 1, maxCount: 10 },
];

const DEFAULT_MODEL = "grok-imagine-image-2.0";

const ASPECT_RATIOS = [
  "auto",
  "1:1",
  "16:9",
  "9:16",
  "4:3",
  "3:4",
  "3:2",
  "2:3",
  "2:1",
  "1:2",
  "19.5:9",
  "9:19.5",
  "20:9",
  "9:20",
  "21:9",
  "5:2",
];

function paramsFor(model: OpenAiImagesModel): MediaParamSpec[] {
  return [
    {
      key: "aspect_ratio",
      label: "Aspect ratio",
      kind: "enum",
      options: ASPECT_RATIOS.map((r) => ({ value: r, label: r })),
      default: "auto",
    },
    {
      key: "resolution",
      label: "Resolution",
      kind: "enum",
      options: ["1k", "2k"].map((r) => ({ value: r, label: r })),
      default: "1k",
    },
    {
      key: "quality",
      label: "Quality",
      kind: "enum",
      options: ["auto", "low", "medium"].map((q) => ({ value: q, label: q })),
      default: "auto",
      hint: "2.0 only",
    },
    { key: "count", label: "Number of generations", kind: "range", min: 1, max: model.maxCount, step: 1, default: 1 },
  ];
}

function baseBody(request: MediaGenRequest, model: string): Record<string, unknown> {
  const p = request.params ?? {};
  const body: Record<string, unknown> = { model, prompt: request.prompt };
  if (typeof p.aspect_ratio === "string" && p.aspect_ratio !== "auto") body.aspect_ratio = p.aspect_ratio;
  if (typeof p.resolution === "string" && p.resolution.length > 0) body.resolution = p.resolution;
  if (typeof p.quality === "string" && p.quality !== "auto") body.quality = p.quality;
  body.n = typeof p.count === "number" ? Math.max(1, Math.round(p.count)) : 1;
  return body;
}

function parseCost(json: unknown): number | undefined {
  const ticks = (json as { usage?: { cost_in_usd_ticks?: unknown } } | undefined)?.usage?.cost_in_usd_ticks;
  return typeof ticks === "number" && Number.isFinite(ticks) ? ticks / 1e10 : undefined;
}

export function xaiImagesAdapter(fetchImpl: typeof globalThis.fetch = globalThis.fetch): OpenAiImagesAdapter {
  return new OpenAiImagesAdapter(
    {
      id: "xai",
      label: "xAI Grok Imagine",
      baseUrl: "https://api.x.ai/v1",
      envHint: "XAI_API_KEY",
      defaultModel: DEFAULT_MODEL,
      models: MODELS,
      edit: "json",
      paramsFor,
      generationBody: (request, model) => baseBody(request, model),
      editBody: (request, model, refs) => {
        const body = baseBody(request, model);
        const first = refs[0];
        if (first !== undefined) {
          body.image = { url: toDataUrl(first.mime, first.bytes), type: "image_url" };
        }
        delete body.aspect_ratio;
        delete body.resolution;
        delete body.quality;
        return body;
      },
      parseCost,
    },
    fetchImpl,
  );
}
