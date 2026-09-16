import type { JobQueue, Service, Store } from "@bai/core";
import type { ModelRouter } from "@bai/provider";

/**
 * Everything the router gateway needs — handed in by the composition root
 * (`@bai/cli`). Deliberately narrow: the provider SDK plus the core handles
 * needed for media (image) routing and asset reads.
 */
export interface RouterDeps {
  /** The in-process provider SDK (model/account resolution + streaming). */
  router: ModelRouter;
  /** Core service — media job enqueue + provider inventory. */
  core: Service;
  /** Job queue — wait for an image job to reach a terminal status. */
  jobs: JobQueue;
  /** Store — read generated asset bytes by job. */
  store: Store;
  version: string;
  /** Bearer token; required for non-loopback access. */
  token?: string;
  /** True when bound to 127.0.0.1 — loopback requests bypass auth. */
  loopbackBind: boolean;
}
