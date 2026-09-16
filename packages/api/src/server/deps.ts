import type { AutomationScheduler, Bus, ConfigStore, EventLog, JobQueue, Service, Store } from "@bai/core";
import type { ProviderRegistry } from "@bai/provider";
import type { Hono } from "hono";

/** Everything the Hono app needs — handed in by the composition root (@bai/cli). */
export interface ApiDeps {
  core: Service;
  store: Store;
  bus: Bus;
  log: EventLog;
  configStore: ConfigStore;
  jobs: JobQueue;
  automations: AutomationScheduler;
  providers: ProviderRegistry;
  version: string;
  /** Home directory used by the fs endpoints (~ expansion, mkdir guard).
   * Defaults to the process home; tests inject a sandbox. */
  home?: string;
  /** Bearer token; required for every request when the listener is not loopback-bound. */
  token?: string;
  /** True when bound to 127.0.0.1 — loopback requests bypass auth. */
  loopbackBind: boolean;
  /** Built web SPA directory (packages/web/dist); hint page when missing. */
  webDist?: string;
  /** Custom theme files directory (~/.config/bai/themes); XDG-aware default when unset. */
  themesDir?: string;
  /**
   * Extra routes mounted at `/` BEFORE the static SPA fallback — the router
   * gateway (`/v1/*`) and, in `--router` mode, `/api/help`. Mounted ahead of
   * the `/api` sub-app so `/api/help` is reachable.
   */
  extraRoutes?: Hono;
  /** Serve the built SPA fallback. False for the headless `--router` listener. Defaults true. */
  serveSpa?: boolean;
}
