import type { Bus, ConfigStore, EventLog, JobQueue, ProviderRegistry, Service, Store } from "@bai/core";

/** Everything the Hono app needs — handed in by the composition root (@bai/cli). */
export interface ApiDeps {
  core: Service;
  store: Store;
  bus: Bus;
  log: EventLog;
  configStore: ConfigStore;
  jobs: JobQueue;
  providers: ProviderRegistry;
  version: string;
  /** Bearer token; required for every request when the listener is not loopback-bound. */
  token?: string;
  /** True when bound to 127.0.0.1 — loopback requests bypass auth. */
  loopbackBind: boolean;
  /** Built web SPA directory (src/packages/web/dist); hint page when missing. */
  webDist?: string;
}
