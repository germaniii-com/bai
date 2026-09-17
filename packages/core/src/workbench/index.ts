export type { Workbench, WbRoute, JobExecutor, JobExecutorContext, JobExecutorResult, GeneratedFile } from "./types";
export { ChatWorkbench } from "./chat";
export { CodeWorkbench } from "./code";
export { ImageWorkbench } from "./image";
export { VideoWorkbench } from "./video";

import { mkdirSync } from "node:fs";
import path from "node:path";
import { ChatWorkbench } from "./chat";
import { CodeWorkbench } from "./code";
import { ImageWorkbench } from "./image";
import { VideoWorkbench } from "./video";
import type { Workbench } from "./types";
import type { MediaGenConfig } from "@bai/shared";
import type { MediaRuntimeDeps } from "./image";
import type { MediaProviderDef } from "./media/registry";
import type { VideoProviderDef } from "./media/video-registry";

/** Per-modality media-gen defaults (config imageGen/videoGen), read live. */
export interface MediaDefaults {
  image?: () => MediaGenConfig | undefined;
  video?: () => MediaGenConfig | undefined;
}

/** All four modalities structured day one (decision D9). */
export function createDefaultWorkbenches(opts: {
  dataDir: string;
  workspaceRoots?: () => string[];
  /** config imageGen/videoGen accessors — the stub executors' model fallback. */
  mediaDefaults?: MediaDefaults;
  /** Credentials + asset reads for the image adapter (provider registry). */
  mediaRuntime?: MediaRuntimeDeps;
  /** Fetch override for the image adapter (tests). */
  mediaFetch?: typeof globalThis.fetch;
  /** File-defined image providers (`~/.config/bai/providers/`), hot-reloadable. */
  mediaCustom?: () => MediaProviderDef[];
  /** File-defined video providers (`~/.config/bai/providers/`), hot-reloadable. */
  mediaCustomVideo?: () => VideoProviderDef[];
}): Workbench[] {
  mkdirSync(path.join(opts.dataDir, "assets"), { recursive: true });
  return [
    new ChatWorkbench(),
    new CodeWorkbench({ roots: opts.workspaceRoots }),
    new ImageWorkbench({
      ...(opts.mediaDefaults?.image !== undefined ? { defaults: opts.mediaDefaults.image } : {}),
      ...(opts.mediaRuntime !== undefined ? { runtime: opts.mediaRuntime } : {}),
      ...(opts.mediaFetch !== undefined ? { fetch: opts.mediaFetch } : {}),
      ...(opts.mediaCustom !== undefined ? { custom: opts.mediaCustom } : {}),
    }),
    new VideoWorkbench({
      ...(opts.mediaDefaults?.video !== undefined ? { defaults: opts.mediaDefaults.video } : {}),
      ...(opts.mediaRuntime !== undefined ? { runtime: opts.mediaRuntime } : {}),
      ...(opts.mediaFetch !== undefined ? { fetch: opts.mediaFetch } : {}),
      ...(opts.mediaCustomVideo !== undefined ? { custom: opts.mediaCustomVideo } : {}),
    }),
  ];
}
