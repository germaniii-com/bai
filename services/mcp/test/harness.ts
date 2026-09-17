import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentRegistry,
  AuthStore,
  AutomationScheduler,
  Bus,
  CatalogService,
  EchoProvider,
  EventLog,
  JobQueue,
  OAuthLoginManager,
  OAUTH_SPECS,
  ProviderFileRegistry,
  ProviderRegistry,
  Service,
  SkillRegistry,
  Store,
  ToolLoader,
  ToolRegistry,
  createDefaultWorkbenches,
} from "@bai/core";
import { DEFAULT_CONFIG, deepMerge, type Config, type ConfigPatch } from "@bai/shared";
import type { McpServerDeps } from "../src";

export interface TestStack {
  dir: string;
  store: Store;
  bus: Bus;
  core: Service;
  tools: ToolRegistry;
  deps: McpServerDeps;
  /** Live config (mutate via setConfig so readers observe it). */
  config: Config;
  setConfig(patch: ConfigPatch): void;
  cleanup(): Promise<void>;
}

/** Full core + MCP server deps against a throwaway data dir. */
export function makeStack(overrides: Partial<McpServerDeps> = {}): TestStack {
  const dir = mkdtempSync(join(tmpdir(), "bai-mcp-server-"));
  const store = new Store(join(dir, "test.db"));
  const bus = new Bus();
  const log = new EventLog(store.events);
  let config: Config = {
    ...DEFAULT_CONFIG,
    models: { default: "stub/echo" },
    // Server role on by default in tests (the gate has its own test).
    mcpServer: { enabled: true, autoApprove: true },
  };
  const accounts = new AuthStore({ file: join(dir, "auth.json") });
  const providerFiles = new ProviderFileRegistry({
    dir: join(dir, "providers"),
    pollMs: 0,
    onChange: () => {
      catalog.invalidate();
      providers.invalidate();
    },
  });
  const catalog = new CatalogService({
    cachePath: join(dir, "models-cache.json"),
    config: () => config,
    fileProviders: () => providerFiles.catalogProviders(),
    offline: true,
  });
  const providers = new ProviderRegistry({ catalog, config: () => config, accounts });
  providers.register(new EchoProvider());
  const oauth = new OAuthLoginManager({ accounts, specs: { ...OAUTH_SPECS } });
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
    builtinFallback: (name) => core.builtinFallback(name),
  });
  const agents = new AgentRegistry({ dir: join(dir, "agents"), debounceMs: 50 });
  const skills = new SkillRegistry({ dir: join(dir, "skills"), debounceMs: 50 });
  let coreRef: Service | undefined;
  const automations = new AutomationScheduler({
    store,
    bus,
    launch: async (automation) => {
      if (coreRef === undefined) throw new Error("Automation fired before the core was ready");
      const { session, done } = coreRef.runAutomation(automation);
      return { sessionId: session.id, done };
    },
    agentExists: (name) => agents.get(name) !== undefined,
    workspaceRoots: () => config.workspaces ?? [],
  });
  const core = new Service({
    store,
    bus,
    log,
    providers,
    oauth,
    tools,
    workbenches,
    jobs,
    agents,
    automations,
    skills,
    toolLoader,
    config: () => config,
    updateConfig: (patch) => (config = deepMerge(config, patch)),
    removeProvider: (id) => {
      const rest = { ...config.providers };
      delete rest[id];
      config = { ...config, providers: rest };
      return config;
    },
    providerFiles,
    version: "test",
    sessionFilesDir: join(dir, "sessions"),
    assetsDir: join(dir, "assets"),
  });
  coreRef = core;

  const deps: McpServerDeps = {
    core,
    store,
    version: "test",
    config: () => config,
    loopbackBind: true,
    enabled: () => config.mcpServer?.enabled === true,
    ...overrides,
  };
  return {
    dir,
    store,
    bus,
    core,
    tools,
    deps,
    get config() {
      return config;
    },
    setConfig: (patch) => {
      config = deepMerge(config, patch);
    },
    cleanup: async () => {
      await jobs.stop({ timeoutMs: 200 });
      automations.stop();
      agents.stop();
      skills.stop();
      toolLoader.stop();
      providerFiles.stop();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Poll a condition (session/run bookkeeping is async). */
export async function waitFor(fn: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`condition not met in time: ${what}`);
}
