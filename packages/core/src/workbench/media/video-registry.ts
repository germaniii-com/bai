/**
 * The video workbench's adapter registry. Mirrors `registry.ts` (images) but
 * keyed to `MEDIA_PROVIDER_SPECS` entries whose `kinds` include "video", with a
 * builder per provider — adding a video provider is a spec entry + an adapter
 * file, never a change to the workbench or the UI.
 */

import type { MediaProviderSpec, VideoModelInfo, VideoProviderInfo, VideoWorkflow } from "@bai/shared";
import { mediaProviderSpec, mediaProviderSpecsForKind } from "../../media-providers";
import type { VideoGenAdapter } from "./video-adapter";
import { StubVideoAdapter } from "./video/stub";
import { OpenRouterVideoAdapter } from "./video/openrouter";
import { FalVideoAdapter } from "./video/fal";
import { ReplicateVideoAdapter } from "./video/replicate";
import { GeminiVeoAdapter } from "./video/gemini-veo";
import { RunwayVideoAdapter } from "./video/runway";
import { KlingVideoAdapter } from "./video/kling";
import { LumaVideoAdapter } from "./video/luma";
import { MinimaxVideoAdapter } from "./video/minimax";
import { WanVideoAdapter } from "./video/wan";
import { SeedanceVideoAdapter } from "./video/seedance";

/** A spec plus the builder that materializes its video adapter. */
export interface VideoProviderDef extends MediaProviderSpec {
  build(fetchImpl: typeof globalThis.fetch): VideoGenAdapter;
  /** Absolute path of the defining provider file (file-defined defs only). */
  filePath?: string;
}

/** Provider id → video adapter builder. Add one line per new adapter file. */
const VIDEO_BUILDERS: Record<string, (fetchImpl: typeof globalThis.fetch) => VideoGenAdapter> = {
  openrouter: (fetchImpl) => new OpenRouterVideoAdapter(fetchImpl),
  fal: (fetchImpl) => new FalVideoAdapter(fetchImpl),
  replicate: (fetchImpl) => new ReplicateVideoAdapter(fetchImpl),
  gemini: (fetchImpl) => new GeminiVeoAdapter(fetchImpl),
  runway: (fetchImpl) => new RunwayVideoAdapter(fetchImpl),
  kling: (fetchImpl) => new KlingVideoAdapter(fetchImpl),
  luma: (fetchImpl) => new LumaVideoAdapter(fetchImpl),
  "minimax-video": (fetchImpl) => new MinimaxVideoAdapter(fetchImpl),
  wan: (fetchImpl) => new WanVideoAdapter(fetchImpl),
  seedance: (fetchImpl) => new SeedanceVideoAdapter(fetchImpl),
};

/** Every implemented video provider (video specs with a registered builder). */
export function videoProviderDefs(): VideoProviderDef[] {
  const out: VideoProviderDef[] = [];
  for (const spec of mediaProviderSpecsForKind("video")) {
    const build = VIDEO_BUILDERS[spec.id];
    if (build === undefined) continue;
    out.push({ ...spec, build });
  }
  return out;
}

/** Look up an implemented video provider by id or alias. */
export function videoProviderDef(id: string): VideoProviderDef | undefined {
  const spec = mediaProviderSpec(id);
  if (spec === undefined || !spec.kinds.includes("video")) return undefined;
  const build = VIDEO_BUILDERS[spec.id];
  return build !== undefined ? { ...spec, build } : undefined;
}

/** Materialize the video adapter map (canonical ids + the offline stub). */
export function buildVideoAdapters(
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Map<string, VideoGenAdapter> {
  const adapters = new Map<string, VideoGenAdapter>();
  for (const def of videoProviderDefs()) adapters.set(def.id, def.build(fetchImpl));
  adapters.set("stub", new StubVideoAdapter());
  return adapters;
}

/** The video provider picker's rows (canonical ids only; stub excluded). */
export async function videoProviderInfos(
  adapters: Map<string, VideoGenAdapter>,
): Promise<VideoProviderInfo[]> {
  const out: VideoProviderInfo[] = [];
  for (const def of videoProviderDefs()) {
    const adapter = adapters.get(def.id);
    if (adapter === undefined) continue;
    const models: VideoModelInfo[] = await adapter.listModels();
    out.push({
      id: def.id,
      label: def.label,
      defaultModel: adapter.defaultModel(),
      workflows: unionWorkflows(models),
      models,
      source: "builtin",
    });
  }
  return out;
}

/** The union of workflows declared across a provider's models. */
export function unionWorkflows(models: VideoModelInfo[]): VideoWorkflow[] {
  const seen = new Set<VideoWorkflow>();
  for (const model of models) for (const w of model.workflows) seen.add(w);
  return [...seen];
}
