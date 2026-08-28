import type { Workbench } from "../workbench/types";

/**
 * The coding-agent modality — structured stub in Phase 0. Real tools
 * (fs.read/write/edit/list/glob/grep, bash via Bun's native PTY) land in
 * Phase 3 behind the same Workbench contract.
 */
export class CodeWorkbench implements Workbench {
  name() {
    return "code" as const;
  }

  label() {
    return "Code";
  }

  tools() {
    return [];
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
