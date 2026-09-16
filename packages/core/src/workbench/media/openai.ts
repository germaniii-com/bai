import type { MediaGenRequest, MediaParamSpec, MediaParamValue } from "@bai/shared";
import { OpenAiImagesAdapter, modesFor, type OpenAiImagesModel } from "./openai-images";

/**
 * OpenAI Images — `POST /v1/images/generations` (JSON, base64 out) and
 * `POST /v1/images/edits` (multipart, image-to-image). Cost is not reported in
 * USD, so no `costUsd`.
 */

const MODELS: OpenAiImagesModel[] = [
  { id: "gpt-image-2", label: "GPT Image 2", modes: modesFor(10), maxReferences: 10, maxCount: 4 },
  { id: "gpt-image-1", label: "GPT Image 1", modes: modesFor(10), maxReferences: 10, maxCount: 4 },
  { id: "gpt-image-1-mini", label: "GPT Image 1 Mini", modes: modesFor(4), maxReferences: 4, maxCount: 4 },
];

const DEFAULT_MODEL = "gpt-image-2";

function paramsFor(model: OpenAiImagesModel): MediaParamSpec[] {
  return [
    {
      key: "size",
      label: "Size",
      kind: "enum",
      options: ["auto", "1024x1024", "1536x1024", "1024x1536"].map((v) => ({ value: v, label: v })),
      default: "1024x1024",
    },
    {
      key: "quality",
      label: "Quality",
      kind: "enum",
      options: ["auto", "low", "medium", "high"].map((v) => ({ value: v, label: v })),
      default: "auto",
    },
    {
      key: "background",
      label: "Background",
      kind: "enum",
      options: ["auto", "transparent", "opaque"].map((v) => ({ value: v, label: v })),
      default: "auto",
      hint: "transparent needs png/webp",
    },
    {
      key: "output_format",
      label: "Output format",
      kind: "enum",
      options: ["png", "jpeg", "webp"].map((v) => ({ value: v, label: v })),
      default: "png",
    },
    { key: "output_compression", label: "Output compression", kind: "range", min: 0, max: 100, step: 1, default: 80, unit: "%" },
    { key: "count", label: "Number of generations", kind: "range", min: 1, max: model.maxCount, step: 1, default: 1 },
  ];
}

function generationBody(request: MediaGenRequest, model: string): Record<string, unknown> {
  const p = request.params ?? {};
  const body: Record<string, unknown> = { model, prompt: request.prompt };
  if (typeof p.size === "string" && p.size.length > 0 && p.size !== "auto") body.size = p.size;
  if (typeof p.quality === "string" && p.quality !== "auto") body.quality = p.quality;
  if (typeof p.background === "string" && p.background !== "auto") body.background = p.background;
  if (typeof p.output_format === "string" && p.output_format.length > 0) body.output_format = p.output_format;
  if (typeof p.output_compression === "number") body.output_compression = p.output_compression;
  body.n = count(p);
  return body;
}

function count(p: Record<string, MediaParamValue>): number {
  return typeof p.count === "number" ? Math.max(1, Math.round(p.count)) : 1;
}

export function openAiImagesAdapter(fetchImpl: typeof globalThis.fetch = globalThis.fetch): OpenAiImagesAdapter {
  return new OpenAiImagesAdapter(
    {
      id: "openai",
      label: "OpenAI Images",
      baseUrl: "https://api.openai.com/v1",
      envHint: "OPENAI_API_KEY",
      defaultModel: DEFAULT_MODEL,
      models: MODELS,
      edit: "multipart",
      paramsFor,
      generationBody: (request, model) => generationBody(request, model),
    },
    fetchImpl,
  );
}
