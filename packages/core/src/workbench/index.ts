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

/** All four modalities structured day one (decision D9). */
export function createDefaultWorkbenches(opts: { dataDir: string; workspaceRoots?: () => string[] }): Workbench[] {
  mkdirSync(path.join(opts.dataDir, "assets"), { recursive: true });
  return [new ChatWorkbench(), new CodeWorkbench({ roots: opts.workspaceRoots }), new ImageWorkbench(), new VideoWorkbench()];
}
