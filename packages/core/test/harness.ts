import { mkdtempSync, mkdirSync } from "node:fs";
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
  Snapshot,
  Store,
  ToolLoader,
  ToolRegistry,
  createDefaultWorkbenches,
} from "../src";
import { DEFAULT_CONFIG, type Event, type EventType, type MediaGenConfig } from "@bai/shared";
export interface TestCore {
  dir: string;
  store: Store;
  bus: Bus;
  log: EventLog;
  core: Service;
  providers: ProviderRegistry;
  accounts: AuthStore;
  /** Mutable config state — tests mutate, the stack reads live. */
  config: {
    models: { default?: string; title?: string; preferZdr?: boolean };
    agents: { default?: string; subagentDepth?: number };
    user: { name?: string };
    imageGen?: MediaGenConfig;
    videoGen?: MediaGenConfig;
    permissions: Record<string, "allow" | "ask" | "deny">;
    workspaces: string[];
  };
  tools: ToolRegistry;
  toolLoader: ToolLoader;
  agents: AgentRegistry;
  skills: SkillRegistry;
}

/** Full core stack against a throwaway data dir. */
export function makeCore(): TestCore {
  const dir = mkdtempSync(join(tmpdir(), "bai-test-"));
  // workspace.create's creation guard roots here — it must EXIST (the real
  // homedir always does; createFolder realpaths it before walking up).
  mkdirSync(join(dir, "home"), { recursive: true });
  const store = new Store(join(dir, "test.db"));
  const bus = new Bus();
  const log = new EventLog(store.events);
  const config: TestCore["config"] = { models: { default: "stub/echo" }, agents: {}, user: {}, permissions: {}, workspaces: [] };
  const testConfig = () => ({
    ...DEFAULT_CONFIG,
    models: { ...config.models },
    agents: { ...config.agents },
    user: { ...config.user },
    ...(config.imageGen !== undefined ? { imageGen: { ...config.imageGen } } : {}),
    ...(config.videoGen !== undefined ? { videoGen: { ...config.videoGen } } : {}),
    permissions: { ...config.permissions },
    workspaces: [...config.workspaces],
  });
  const accounts = new AuthStore({ file: join(dir, "auth.json") });
  const catalog = new CatalogService({
    cachePath: join(dir, "models-cache.json"),
    config: testConfig,
    offline: true, // tests never touch network or the bundled snapshot
  });
  const providers = new ProviderRegistry({ catalog, config: testConfig, accounts });
  providers.register(new EchoProvider());
  const workbenches = createDefaultWorkbenches({
    dataDir: dir,
    mediaDefaults: {
      image: () => config.imageGen,
      video: () => config.videoGen,
    },
  });
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
  const agents = new AgentRegistry({
    dir: join(dir, "agents"),
    debounceMs: 50,
    // Mirror boot.ts: agent-set changes broadcast live (the task tool keys
    // its description refresh off this event).
    onChange: () => {
      bus.publish({ seq: 0, type: "agents.updated", ts: new Date().toISOString(), payload: {} });
    },
  });
  const skills = new SkillRegistry({
    dir: join(dir, "skills"),
    debounceMs: 50,
    // Mirror boot.ts: skill-set changes broadcast live.
    onChange: () => {
      bus.publish({ seq: 0, type: "skills.updated", ts: new Date().toISOString(), payload: {} });
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
    skills,
    toolLoader,
    config: testConfig,
    // Mirror boot.ts: the config mutation path agent tools use
    // (workspace.create) — mutate the live test config, return the effective.
    updateConfig: (patch) => {
      if (patch.workspaces !== undefined) config.workspaces = [...patch.workspaces];
      return testConfig();
    },
    // workspace.create's creation guard roots here (a throwaway home —
    // never the real one).
    homeDir: () => join(dir, "home"),
    version: "test",
    plansDir: join(dir, "plans"),
    // Shadow-repo snapshots (revert's file rollback) — under the throwaway
    // data dir; sessions without a cwd never touch it.
    snapshot: new Snapshot(join(dir, "snapshot")),
  });
  return { dir, store, bus, log, core, providers, accounts, config, tools, toolLoader, agents, skills };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Subscribe first, then poll until the expected event arrives (payload typed). */
export async function waitForEvent<K extends EventType>(
  bus: Bus,
  type: K,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<Event<K>> {
  const sub = bus.subscribe();
  const deadline = Date.now() + (opts.timeoutMs ?? 3000);
  try {
    while (Date.now() < deadline) {
      for (const evt of sub.take()) {
        if (evt.type === type) return evt as Event<K>;
      }
      if (opts.signal?.aborted) throw new Error("aborted while waiting");
      await sleep(10);
    }
    throw new Error(`timeout waiting for event "${type}"`);
  } finally {
    bus.unsubscribe(sub.id);
  }
}
