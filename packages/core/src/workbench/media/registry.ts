/**
 * The image workbench's adapter registry. Built from
 * {@link MEDIA_PROVIDER_SPECS} (the shared credentials/endpoint table) plus a
 * builder per provider, so adding a provider is a spec entry + an adapter file
 * — never a change to the workbench or the UI.
 */

import type { MediaProviderInfo } from "@bai/shared";
import { MEDIA_PROVIDER_SPECS, mediaProviderSpec, type MediaProviderSpec } from "../../media-providers";
import type { MediaGenAdapter } from "./adapter";
import { OpenRouterMediaAdapter } from "./openrouter";
import { StubMediaAdapter } from "./stub";
import { openAiImagesAdapter } from "./openai";
import { xaiImagesAdapter } from "./xai";
import { togetherImagesAdapter } from "./together";
import { deepInfraImagesAdapter } from "./deepinfra";
import { recraftImagesAdapter } from "./recraft";
import { GeminiMediaAdapter } from "./gemini";
import { BflMediaAdapter } from "./bfl";
import { FalMediaAdapter } from "./fal";
import { ReplicateMediaAdapter } from "./replicate";
import { StabilityMediaAdapter } from "./stability";
import { IdeogramMediaAdapter } from "./ideogram";
import { MinimaxMediaAdapter } from "./minimax";

/** A spec plus the builder that materializes its adapter. */
export interface MediaProviderDef extends MediaProviderSpec {
  build(fetchImpl: typeof globalThis.fetch): MediaGenAdapter;
}

/** Provider id → adapter builder. Add one line per new adapter file. */
const BUILDERS: Record<string, (fetchImpl: typeof globalThis.fetch) => MediaGenAdapter> = {
  openrouter: (fetchImpl) => new OpenRouterMediaAdapter(fetchImpl),
  openai: (fetchImpl) => openAiImagesAdapter(fetchImpl),
  xai: (fetchImpl) => xaiImagesAdapter(fetchImpl),
  together: (fetchImpl) => togetherImagesAdapter(fetchImpl),
  deepinfra: (fetchImpl) => deepInfraImagesAdapter(fetchImpl),
  recraft: (fetchImpl) => recraftImagesAdapter(fetchImpl),
  gemini: (fetchImpl) => new GeminiMediaAdapter(fetchImpl),
  bfl: (fetchImpl) => new BflMediaAdapter(fetchImpl),
  fal: (fetchImpl) => new FalMediaAdapter(fetchImpl),
  replicate: (fetchImpl) => new ReplicateMediaAdapter(fetchImpl),
  stability: (fetchImpl) => new StabilityMediaAdapter(fetchImpl),
  ideogram: (fetchImpl) => new IdeogramMediaAdapter(fetchImpl),
  "minimax-image": (fetchImpl) => new MinimaxMediaAdapter(fetchImpl),
};

/** Every implemented media provider (specs with a registered builder). */
export function mediaProviderDefs(): MediaProviderDef[] {
  const out: MediaProviderDef[] = [];
  for (const spec of MEDIA_PROVIDER_SPECS) {
    const build = BUILDERS[spec.id];
    if (build === undefined) continue;
    out.push({ ...spec, build });
  }
  return out;
}

/** Look up an implemented provider by id or alias. */
export function mediaProviderDef(id: string): MediaProviderDef | undefined {
  const spec = mediaProviderSpec(id);
  if (spec === undefined) return undefined;
  const build = BUILDERS[spec.id];
  return build !== undefined ? { ...spec, build } : undefined;
}

/** Materialize the adapter map (canonical ids + the offline stub). */
export function buildMediaAdapters(
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Map<string, MediaGenAdapter> {
  const adapters = new Map<string, MediaGenAdapter>();
  for (const def of mediaProviderDefs()) adapters.set(def.id, def.build(fetchImpl));
  adapters.set("stub", new StubMediaAdapter());
  return adapters;
}

/** The provider picker's rows (canonical ids only; stub excluded). */
export async function mediaProviderInfos(
  adapters: Map<string, MediaGenAdapter>,
): Promise<MediaProviderInfo[]> {
  const out: MediaProviderInfo[] = [];
  for (const def of mediaProviderDefs()) {
    const adapter = adapters.get(def.id);
    if (adapter === undefined) continue;
    const model = adapter.defaultModel();
    out.push({
      id: def.id,
      label: def.label,
      defaultModel: model,
      modes: adapter.capabilities(model).modes,
      models: await adapter.listModels(),
    });
  }
  return out;
}
