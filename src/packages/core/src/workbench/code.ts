import type { Workbench } from "../workbench/types";
import { fsEditTool } from "../tools/fs-edit";
import { fsGlobTool, fsListTool } from "../tools/fs-list-glob";
import { fsReadTool, fsWriteTool } from "../tools/fs-read-write";
import type { Tool } from "../tools/registry";

export interface CodeWorkbenchOpts {
  /**
   * Absolute workspace roots the fs tools may touch (typically the
   * registered workspaces from config). Sessions additionally root at
   * their own cwd.
   */
  roots?: () => string[];
}

/**
 * The coding-agent modality. Registers the built-in file tools; the
 * tool-call loop arrives with the agents plan (run coordinator Phase 5).
 */
export class CodeWorkbench implements Workbench {
  private readonly fsTools: Tool[];

  constructor(opts: CodeWorkbenchOpts = {}) {
    const roots = { roots: opts.roots ?? (() => []) };
    this.fsTools = [
      fsReadTool(roots),
      fsListTool(roots),
      fsGlobTool(roots),
      fsWriteTool(roots),
      fsEditTool(roots),
    ];
  }

  name() {
    return "code" as const;
  }

  label() {
    return "Code";
  }

  tools() {
    return this.fsTools;
  }

  jobTypes() {
    return [];
  }

  assetKinds() {
    return [];
  }

  jobExecutors() {
    return {};
  }

  routes() {
    return [];
  }
}
