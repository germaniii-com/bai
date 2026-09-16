import type { MediaGenRequest, MediaParamSpec } from "@bai/shared";
import { toDataUrl } from "./http";
import { OpenAiImagesAdapter, modesFor, type OpenAiImagesModel } from "./openai-images";

/**
 * Recraft — OpenAI-compatible `POST /external.api.recraft.ai/v1/images/generations`
 * (raster; `data[].url`). Image-to-image rides the same endpoint with an
 * `image` data URL. Bearer auth.
 */

const MODELS: OpenAiImagesModel[] = [
  { id: "recraftv3", label: "Recraft V3", modes: modesFor(1), maxReferences: 1, maxCount: 6 },
  { id: "recraftv2", label: "Recraft V2", modes: modesFor(1), maxReferences: 1, maxCount: 6 },
  { id: "recraft-20b", label: "Recraft 20B", modes: modesFor(1), maxReferences: 1, maxCount: 6 },
];

const DEFAULT_MODEL = "recraftv3";

const SIZES = [
  "1024x1024",
  "1365x1024",
  "1024x1365",
  "1536x1024",
  "1024x1536",
  "1820x1024",
  "1024x1820",
  "2048x1024",
  "1024x2048",
];

function paramsFor(model: OpenAiImagesModel): MediaParamSpec[] {
  return [
    {
      key: "size",
      label: "Size",
      kind: "enum",
      options: SIZES.map((v) => ({ value: v, label: v })),
      default: "1024x1024",
    },
    {
      key: "style",
      label: "Style",
      kind: "text",
      placeholder: "e.g. realistic_image, digital_illustration",
    },
    { key: "count", label: "Number of generations", kind: "range", min: 1, max: model.maxCount, step: 1, default: 1 },
  ];
}

function generationBody(request: MediaGenRequest, model: string, refs: { mime: string; bytes: Uint8Array }[]): Record<string, unknown> {
  const p = request.params ?? {};
  const body: Record<string, unknown> = { model, prompt: request.prompt };
  if (typeof p.size === "string" && p.size.length > 0) body.size = p.size;
  if (typeof p.style === "string" && p.style.length > 0) body.style = p.style;
  if (typeof p.count === "number") body.n = Math.max(1, Math.round(p.count));
  const first = refs[0];
  if (first !== undefined) body.image = toDataUrl(first.mime, first.bytes);
  return body;
}

export function recraftImagesAdapter(fetchImpl: typeof globalThis.fetch = globalThis.fetch): OpenAiImagesAdapter {
  return new OpenAiImagesAdapter(
    {
      id: "recraft",
      label: "Recraft",
      baseUrl: "https://external.api.recraft.ai/v1",
      envHint: "RECRAFT_API_TOKEN",
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
