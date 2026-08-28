import type { Workbench } from "../workbench/types";

/**
 * The conversation modality — bai's default session type. Exists mostly to
 * prove the workbench contract with the simplest possible citizen.
 */
export class ChatWorkbench implements Workbench {
  name() {
    return "chat" as const;
  }

  label() {
    return "Chat";
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
