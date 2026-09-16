import type { MediaGenRequest, MediaParamSpec } from "@bai/shared";
import { OpenAiImagesAdapter, modesFor, type OpenAiImagesModel } from "./openai-images";

/**
 * DeepInfra — OpenAI-compatible `POST /v1/openai/images/generations`. The
 * endpoint only returns `b64_json`, and its supported models are
 * text-to-image, so this adapter is t2i-only.
 */

const MODELS: OpenAiImagesModel[] = [
  { id: "black-forest-labs/FLUX-1-schnell", label: "FLUX.1 Schnell", modes: modesFor(0), maxReferences: 0, maxCount: 4 },
  { id: "black-forest-labs/FLUX-1-dev", label: "FLUX.1 Dev", modes: modesFor(0), maxReferences: 0, maxCount: 4 },
  { id: "stabilityai/sdxl-turbo", label: "SDXL Turbo", modes: modesFor(0), maxReferences: 0, maxCount: 4 },
];

const DEFAULT_MODEL = "black-forest-labs/FLUX-1-schnell";

function paramsFor(model: OpenAiImagesModel): MediaParamSpec[] {
  return [
    {
      key: "size",
      label: "Size",
      kind: "enum",
      options: ["512x512", "1024x1024", "1024x1536", "1536x1024"].map((v) => ({ value: v, label: v })),
      default: "1024x1024",
    },
    { key: "count", label: "Number of generations", kind: "range", min: 1, max: model.maxCount, step: 1, default: 1 },
  ];
}

function generationBody(request: MediaGenRequest, model: string): Record<string, unknown> {
  const p = request.params ?? {};
  const body: Record<string, unknown> = { model, prompt: request.prompt, response_format: "b64_json" };
  if (typeof p.size === "string" && p.size.length > 0) body.size = p.size;
  if (typeof p.count === "number") body.n = Math.max(1, Math.round(p.count));
  return body;
}

export function deepInfraImagesAdapter(fetchImpl: typeof globalThis.fetch = globalThis.fetch): OpenAiImagesAdapter {
  return new OpenAiImagesAdapter(
    {
      id: "deepinfra",
      label: "DeepInfra",
      baseUrl: "https://api.deepinfra.com/v1/openai",
      envHint: "DEEPINFRA_API_KEY",
      defaultModel: DEFAULT_MODEL,
      models: MODELS,
      edit: "none",
      paramsFor,
      generationBody: (request, model) => generationBody(request, model),
    },
    fetchImpl,
  );
}
