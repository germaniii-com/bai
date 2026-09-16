import type { MediaGenRequest, MediaParamSpec } from "@bai/shared";
import { toDataUrl } from "./http";
import { OpenAiImagesAdapter, modesFor, type OpenAiImagesModel } from "./openai-images";

/**
 * Together AI — OpenAI-compatible `POST /v1/images/generations`. FLUX.2 models
 * take `reference_images`, Kontext models take `image_url`; requesting
 * `response_format: "base64"` avoids the CDN's User-Agent requirement.
 */

const MODELS: OpenAiImagesModel[] = [
  { id: "black-forest-labs/FLUX.2-pro", label: "FLUX.2 Pro", modes: modesFor(8), maxReferences: 8, maxCount: 4 },
  { id: "black-forest-labs/FLUX.2-dev", label: "FLUX.2 Dev", modes: modesFor(8), maxReferences: 8, maxCount: 4 },
  { id: "black-forest-labs/FLUX.2-flex", label: "FLUX.2 Flex", modes: modesFor(8), maxReferences: 8, maxCount: 4 },
  { id: "black-forest-labs/FLUX.2-max", label: "FLUX.2 Max", modes: modesFor(8), maxReferences: 8, maxCount: 4 },
  { id: "black-forest-labs/FLUX.1.1-pro", label: "FLUX 1.1 Pro", modes: modesFor(0), maxReferences: 0, maxCount: 4 },
  { id: "black-forest-labs/FLUX.1-kontext-pro", label: "FLUX.1 Kontext Pro", modes: modesFor(1), maxReferences: 1, maxCount: 4 },
  { id: "black-forest-labs/FLUX.1-kontext-max", label: "FLUX.1 Kontext Max", modes: modesFor(1), maxReferences: 1, maxCount: 4 },
];

const DEFAULT_MODEL = "black-forest-labs/FLUX.2-dev";

function paramsFor(model: OpenAiImagesModel): MediaParamSpec[] {
  return [
    { key: "width", label: "Width", kind: "number", min: 256, max: 2048, default: 1024 },
    { key: "height", label: "Height", kind: "number", min: 256, max: 2048, default: 1024 },
    {
      key: "aspect_ratio",
      label: "Aspect ratio",
      kind: "enum",
      options: ["auto", "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9"].map((r) => ({ value: r, label: r })),
      default: "auto",
      hint: "Kontext/Schnell models",
    },
    { key: "steps", label: "Steps", kind: "range", min: 1, max: 50, step: 1, default: 20 },
    { key: "seed", label: "Seed", kind: "number", min: 0, max: 4_294_967_295 },
    { key: "negative_prompt", label: "Negative prompt", kind: "text", placeholder: "what to avoid" },
    { key: "count", label: "Number of generations", kind: "range", min: 1, max: model.maxCount, step: 1, default: 1 },
  ];
}

function generationBody(request: MediaGenRequest, model: string, refs: { mime: string; bytes: Uint8Array }[]): Record<string, unknown> {
  const p = request.params ?? {};
  const body: Record<string, unknown> = { model, prompt: request.prompt, response_format: "base64" };
  if (typeof p.width === "number") body.width = p.width;
  if (typeof p.height === "number") body.height = p.height;
  if (typeof p.aspect_ratio === "string" && p.aspect_ratio !== "auto") body.aspect_ratio = p.aspect_ratio;
  if (typeof p.steps === "number") body.steps = p.steps;
  if (typeof p.seed === "number") body.seed = p.seed;
  if (typeof p.negative_prompt === "string" && p.negative_prompt.length > 0) body.negative_prompt = p.negative_prompt;
  if (typeof p.count === "number") body.n = Math.max(1, Math.round(p.count));
  if (refs.length > 0) {
    if (model.includes("kontext")) {
      body.image_url = toDataUrl(refs[0]!.mime, refs[0]!.bytes);
    } else {
      body.reference_images = refs.map((r) => toDataUrl(r.mime, r.bytes));
    }
  }
  return body;
}

export function togetherImagesAdapter(fetchImpl: typeof globalThis.fetch = globalThis.fetch): OpenAiImagesAdapter {
  return new OpenAiImagesAdapter(
    {
      id: "together",
      label: "Together AI",
      baseUrl: "https://api.together.ai/v1",
      envHint: "TOGETHER_API_KEY",
      defaultModel: DEFAULT_MODEL,
      models: MODELS,
      edit: "refs",
      paramsFor,
      generationBody,
      downloadHeaders: { "user-agent": "bai/0.1" },
    },
    fetchImpl,
  );
}
