import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentRegistry,
  AuthStore,
  Bus,
  CatalogService,
  EchoProvider,
  EventLog,
  JobQueue,
  ProviderRegistry,
  Service,
  SkillRegistry,
  Store,
  ToolLoader,
  ToolRegistry,
  createDefaultWorkbenches,
} from "@bai/core";
import { DEFAULT_CONFIG, deepMerge, type Config, type ConfigPatch } from "@bai/shared";
import type { ApiDeps } from "../src";

export interface TestStack {
  dir: string;
  store: Store;
  bus: Bus;
  core: Service;
  deps: ApiDeps;
  cleanup(): void;
}

/** Full core + Hono app against a throwaway data dir. */
export function makeStack(overrides: Partial<ApiDeps> = {}): TestStack {
  const dir = mkdtempSync(join(tmpdir(), "bai-api-"));
  const store = new Store(join(dir, "test.db"));
  const bus = new Bus();
  const log = new EventLog(store.events);
  // Mutable: configStore.update reassigns it so putConfig writes are visible
  // to every reader (the registry, the drain, later GETs) — deepMerge alone
  // returns a fresh object and the write would be lost.
  let config: Config = { ...DEFAULT_CONFIG, models: { default: "stub/echo" } };
  const accounts = new AuthStore({ file: join(dir, "auth.json") });
  const catalog = new CatalogService({
    cachePath: join(dir, "models-cache.json"),
    config: () => config,
    offline: true, // tests never touch network or the bundled snapshot
  });
  const providers = new ProviderRegistry({ catalog, config: () => config, accounts });
  providers.register(new EchoProvider());
  const workbenches = createDefaultWorkbenches({ dataDir: dir });
  const jobs = new JobQueue({
    store,
    bus,
    assetsDir: join(dir, "assets"),
    executors: Object.assign({}, ...workbenches.map((wb) => wb.jobExecutors())),
  });
  const tools = new ToolRegistry({ spillDir: join(dir, "tmp") });
  const toolLoader: ToolLoader = new ToolLoader({
    dir: join(dir, "tools"),
    registry: tools,
    debounceMs: 40,
    // Mirror boot.ts: deleting an override file restores the built-in.
    builtinFallback: (name) => core.builtinFallback(name),
  });
  const agents = new AgentRegistry({ dir: join(dir, "agents"), debounceMs: 50 });
  const skills = new SkillRegistry({ dir: join(dir, "skills"), debounceMs: 50 });
  const core = new Service({
    store,
    bus,
    log,
    providers,
    tools,
    workbenches,
    jobs,
    agents,
    skills,
    toolLoader,
    config: () => config,
    // Mirror boot.ts: the config mutation path the workspace remove/restore
    // routes use — reassign so the mutation is visible to every reader.
    updateConfig: (patch) => (config = deepMerge(config, patch)),
    version: "test",
    plansDir: join(dir, "plans"),
  });
  const deps: ApiDeps = {
    core,
    store,
    bus,
    log,
    configStore: {
      get: () => config,
      // Minimal stand-in for the real ConfigStore: deep-merge the patch
      // (arrays replaced) and REASSIGN so config-mutation tests observe
      // their writes.
      update: (patch: ConfigPatch) => (config = deepMerge(config, patch)),
    } as unknown as ApiDeps["configStore"],
    jobs,
    providers,
    version: "test",
    loopbackBind: true,
    ...overrides,
  };
  return {
    dir,
    store,
    bus,
    core,
    deps,
    cleanup: () => {
      agents.stop();
      skills.stop();
      toolLoader.stop();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
