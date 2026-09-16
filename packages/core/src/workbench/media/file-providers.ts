import type { MediaModelInfo, MediaParamSpec, ProviderFile } from "@bai/shared";
import { GenericMediaAdapter } from "./generic";
import { OpenAiImagesAdapter, type OpenAiImagesModel, type OpenAiImagesSpec } from "./openai-images";
import type { MediaProviderDef } from "./registry";

/**
 * Translate a validated provider file into a workbench {@link MediaProviderDef}
 * (spec + adapter builder). Returns `undefined` for files without an `image`
 * block (text-only / video-only).
 */
export function providerFileToMediaDef(
  id: string,
  file: ProviderFile,
  path: string,
): MediaProviderDef | undefined {
  const image = file.image;
  if (image === undefined) return undefined;
  const env = file.env ?? (file.apiKeyEnv !== undefined ? [file.apiKeyEnv] : []);
  return {
    id,
    label: file.name,
    baseUrl: file.baseUrl,
    env,
    imageOnly: !file.providerType.includes("text"),
    aliases: [],
    filePath: path,
    build: (fetchImpl) =>
      image.template === "openai-images"
        ? new OpenAiImagesAdapter(openAiSpec(id, file, image), fetchImpl)
        : new GenericMediaAdapter(
            {
              id,
              label: file.name,
              baseUrl: file.baseUrl,
              envHint: env,
              auth: file.auth ?? { header: "authorization", scheme: "Bearer" },
              ...(file.headers !== undefined ? { headers: file.headers } : {}),
              spec: image,
            },
            fetchImpl,
          ),
  };
}

/** Wrap an OpenAI-images-compatible file in the shared openai-images adapter. */
function openAiSpec(id: string, file: ProviderFile, image: Extract<ProviderFile["image"], { template: "openai-images" }>): OpenAiImagesSpec {
  const models: OpenAiImagesModel[] = image.models.map((m) => ({
    id: m.id,
    label: m.label ?? m.id,
    modes: m.modes,
    maxReferences: m.maxReferences,
    maxCount: m.maxCount,
  }));
  return {
    id,
    label: file.name,
    baseUrl: file.baseUrl,
    envHint: (file.env ?? (file.apiKeyEnv !== undefined ? [file.apiKeyEnv] : []))[0] ?? "API_KEY",
    defaultModel: image.defaultModel,
    models,
    edit: image.edit,
    paramsFor: (model) => image.params ?? defaultOpenAiParams(model),
    // Generic openai-images body: prompt + model, `count` → `n`, every other
    // declared parameter passes through under its own key.
    generationBody: (request, model) => {
      const params = request.params ?? {};
      const body: Record<string, unknown> = { model, prompt: request.prompt };
      for (const [key, value] of Object.entries(params)) {
        if (key === "count") body.n = Math.max(1, Math.round(Number(value)));
        else body[key] = value;
      }
      return body;
    },
  };
}

function defaultOpenAiParams(model: OpenAiImagesModel): MediaParamSpec[] {
  return [
    { key: "count", label: "Number of generations", kind: "range", min: 1, max: model.maxCount, step: 1, default: 1 },
    { key: "size", label: "Size", kind: "text", placeholder: "1024x1024" },
    { key: "seed", label: "Seed", kind: "number", min: 0, max: 2_147_483_647 },
  ];
}

/** Convenience: map every file's image block to a media def (drops the rest). */
export function providerFilesToMediaDefs(
  files: ReadonlyArray<{ id: string; file: ProviderFile; path: string }>,
): MediaProviderDef[] {
  const out: MediaProviderDef[] = [];
  for (const entry of files) {
    const def = providerFileToMediaDef(entry.id, entry.file, entry.path);
    if (def !== undefined) out.push(def);
  }
  return out;
}

export type { MediaModelInfo };
