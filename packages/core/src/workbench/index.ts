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
}): Workbench[] {
  mkdirSync(path.join(opts.dataDir, "assets"), { recursive: true });
  return [
    new ChatWorkbench(),
    new CodeWorkbench({ roots: opts.workspaceRoots }),
    new ImageWorkbench(opts.mediaDefaults?.image),
    new VideoWorkbench(opts.mediaDefaults?.video),
  ];
}
