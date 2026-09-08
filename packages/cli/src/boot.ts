import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  AuthStore,
  AgentRegistry,
  CatalogService,
  ConfigStore,
  EventLog,
  Bus,
  JobQueue,
  ProviderRegistry,
  Service,
  Snapshot,
  Store,
  ToolLoader,
  ToolRegistry,
  createDefaultWorkbenches,
  loadConfig,
  snapshotDir,
  type JobExecutor,
} from "@bai/core";
import { createApp } from "@bai/api";
import type { Config, ConfigPatch, JobKind } from "@bai/shared";
import type { CliArgs } from "./args";
import { assetsDir, configDir, dataDir, dbPath, globalConfigPath, serverStatePath, tmpDir, webDistDir } from "./paths";

/**
 * Version stamp: `BAI_VERSION` is injected at compile time via `define`
 * (see scripts/compile.ts — the analog of Go's -ldflags -X). Falls back to
 * the package version when running from source.
 */
declare const BAI_VERSION: string | undefined;
export const VERSION: string = typeof BAI_VERSION === "string" ? BAI_VERSION : "0.1.0";

export interface Booted {
  config: Config;
  configStore: ConfigStore;
  store: Store;
  bus: Bus;
  core: Service;
  app: ReturnType<typeof createApp>;
  token?: string;
  /** True unless bound beyond loopback (--host) — gates the shell WS upgrade. */
  loopbackBind: boolean;
  /** Drain runs and close the DB. The HTTP server is owned by the mode. */
  stop(): Promise<void>;
}

/**
 * Boot sequence shared by every mode (ARCHITECTURE.md §4):
 * config layers → store + migrations → core (registry, permissions,
 * coordinator, workbenches) → Hono app.
 */
export async function boot(args: CliArgs): Promise<Booted> {
  const flags: ConfigPatch = {};
  if (args.port !== undefined) {
    flags.server = { ...(flags.server ?? {}), port: args.port };
  }
  if (args.token !== undefined) {
    flags.server = { ...(flags.server ?? {}), token: args.token };
  }

  const globalPath = args.config ?? globalConfigPath();
  const { config } = loadConfig({
    cwd: process.cwd(),
    globalPath,
    ...(Object.keys(flags).length > 0 ? { flags } : {}),
  });

  // A fresh one-shot is a pure proxy to the model: it never reads prior
  // data, so the whole store lives in RAM and dies with the process —
  // nothing is persisted, no session clutter. --continue/--session target
  // real persisted sessions and keep the on-disk store.
  const ephemeral = args.mode === "oneshot" && !args.continueLast && args.sessionId === undefined;
  const store = new Store(ephemeral ? ":memory:" : dbPath());
  const bus = new Bus();
  const log = new EventLog(store.events);

  // Credentials live outside config (auth.json, 0600) so keys never ride
  // config sync; the catalog merges models.dev with config-defined providers.
  const accounts = new AuthStore({ file: path.join(dataDir(), "auth.json") });
  const configStore = new ConfigStore({
    globalPath,
    cwd: process.cwd(),
    onChange: () => {
      providers.invalidate();
      bus.publish({ seq: 0, type: "config.updated", ts: new Date().toISOString(), payload: {} });
    },
  });
  const catalog = new CatalogService({
    cachePath: path.join(dataDir(), "models-cache.json"),
    config: () => configStore.get(),
  });
  const providers = new ProviderRegistry({
    catalog,
    config: () => configStore.get(),
    accounts,
  });

  const workbenches = createDefaultWorkbenches({
    dataDir: dataDir(),
    // fs tools may also touch registered workspaces (config.workspaces),
    // not just the session's own cwd.
    workspaceRoots: () => configStore.get().workspaces ?? [],
    // Media-gen defaults (config imageGen/videoGen) — the stub executors'
    // model fallback until the Phase 5 adapters land.
    mediaDefaults: {
      image: () => configStore.get().imageGen,
      video: () => configStore.get().videoGen,
    },
  });
  const executors: Partial<Record<JobKind, JobExecutor>> = Object.assign(
    {},
    ...workbenches.map((wb) => wb.jobExecutors()),
  );
  const jobs = new JobQueue({ store, bus, assetsDir: assetsDir(), executors });

  const tools = new ToolRegistry({ spillDir: tmpDir() });

  // Custom tool files (~/.config/bai/tools/*.ts|js), hot-reloaded. A file
  // may shadow a built-in under the same name; deleting it restores the
  // built-in from the Service's snapshot (builtinFallback). The snapshot
  // accessor is behind a `let` + optional chain: the loader's constructor
  // schedules its first rescan as a microtask, and if boot ever grows an
  // await before the Service exists, the closure must not hit the `core`
  // TDZ (it resolves to undefined and the poller picks the file up later).
  let coreRef: Service | undefined;
  const toolLoader: ToolLoader = new ToolLoader({
    dir: path.join(configDir(), "tools"),
    registry: tools,
    builtinFallback: (name) => coreRef?.builtinFallback(name),
    onChange: () => {
      bus.publish({ seq: 0, type: "tools.updated", ts: new Date().toISOString(), payload: {} });
    },
  });

  // File-defined agents (~/.config/bai/agents/*.md), hot-reloaded; changes
  // broadcast live so every surface refetches without a restart.
  const agents = new AgentRegistry({
    dir: path.join(configDir(), "agents"),
    onChange: () => {
      bus.publish({ seq: 0, type: "agents.updated", ts: new Date().toISOString(), payload: {} });
    },
  });

  const core = new Service({
    store,
    bus,
    log,
    providers,
    tools,
    workbenches,
    jobs,
    agents,
    toolLoader,
    config: () => configStore.get(),
    version: VERSION,
    plansDir: path.join(configDir(), "plans"),
    snapshot: new Snapshot(snapshotDir(dataDir())),
  });
  coreRef = core;

  const token = resolveToken(args, config);
  const app = createApp({
    core,
    store,
    bus,
    log,
    configStore,
    jobs,
    providers,
    version: VERSION,
    ...(token !== undefined ? { token } : {}),
    loopbackBind: args.mode !== "host",
    webDist: webDistDir(),
    themesDir: path.join(configDir(), "themes"),
  });

  return {
    config,
    configStore,
    store,
    bus,
    core,
    app,
    ...(token !== undefined ? { token } : {}),
    loopbackBind: args.mode !== "host",
    stop: async () => {
      core.coordinator.interruptAll();
      // Fail pending agent→user questions so no tool promise hangs.
      core.questions.stop();
      agents.stop();
      toolLoader.stop();
      store.close();
    },
  };
}

/**
 * Token policy: explicit flag > config > generated (persisted to server.json
 * state so local reuse/discovery works). Loopback-only binds may run without.
 */
function resolveToken(args: CliArgs, config: Config): string | undefined {
  if (args.token !== undefined) return args.token;
  if (config.server.token !== undefined) return config.server.token;
  if (args.mode === "host") {
    const generated = crypto.randomUUID().replace(/-/g, "");
    mkdirSync(serverStatePath().replace(/[^/]*$/, ""), { recursive: true });
    writeFileSync(
      serverStatePath(),
      `${JSON.stringify({ token: generated, pid: process.pid }, null, 2)}\n`,
    );
    return generated;
  }
  return undefined;
}
