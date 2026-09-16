import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  AuthStore,
  AgentRegistry,
  AutomationScheduler,
  CatalogService,
  ConfigStore,
  EventLog,
  Bus,
  JobQueue,
  McpManager,
  McpRegistry,
  OAuthLoginManager,
  ProviderFileRegistry,
  ProviderRegistry,
  Service,
  SkillRegistry,
  Snapshot,
  Store,
  ToolLoader,
  ToolRegistry,
  bundledSkillsDir,
  createDefaultWorkbenches,
  loadConfig,
  providerFilesToMediaDefs,
  snapshotDir,
  syncBundledSkills,
  type JobExecutor,
} from "@bai/core";
import { createApp } from "@bai/api";
import { registeredRoots } from "@bai/shared";
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
  /**
   * The TUI's workspace root — the realpath'd launch folder, registered in
   * config.workspaces at boot (TUI mode only). New TUI sessions root here
   * so they group under the workspace in the webui. Undefined elsewhere.
   */
  workspaceRoot?: string;
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
  // Late-bound core: config/OAuth callbacks fire only after boot completes.
  let coreRef: Service | undefined;
  // Late-bound MCP manager: the config/registry change closures below can fire
  // during construction, before the manager exists.
  let mcpManagerRef: McpManager | undefined;

  // Credentials live outside config (auth.json, 0600) so keys never ride
  // config sync; the catalog merges models.dev with config-defined providers.
  const accounts = new AuthStore({ file: path.join(dataDir(), "auth.json") });
  const configStore = new ConfigStore({
    globalPath,
    cwd: process.cwd(),
    onChange: () => {
      providers.invalidate();
      // One broadcast point for EVERY config change (own writes, agent-tool
      // writes, and external file edits from a sibling bai process): the bus
      // for in-process subscribers, the firehose for web surfaces. coreRef
      // resolves once the Service exists (the optional chain covers the
      // constructor window).
      bus.publish({ seq: 0, type: "config.updated", ts: new Date().toISOString(), payload: {} });
      coreRef?.emitLive("config.updated", {});
      // config.json's `mcp` layer may have changed — reconcile servers.
      void mcpManagerRef?.reconcile();
    },
  });
  // File-defined providers (~/.config/bai/providers/*.json), hot-reloaded.
  // Files win over config.json providers of the same id; built-in media adapter
  // ids are reserved. A change re-derives the catalog + adapters and broadcasts
  // provider.updated so every surface refetches without a restart. Constructed
  // before the catalog (which reads it) with a late-bound catalog ref.
  let catalogRef: CatalogService | undefined;
  const providerFiles = new ProviderFileRegistry({
    dir: path.join(configDir(), "providers"),
    onChange: () => {
      catalogRef?.invalidate();
      providers.invalidate();
      bus.publish({ seq: 0, type: "provider.updated", ts: new Date().toISOString(), payload: {} });
      coreRef?.emitLive("provider.updated", {});
    },
  });
  const catalog = new CatalogService({
    cachePath: path.join(dataDir(), "models-cache.json"),
    config: () => configStore.get(),
    fileProviders: () => providerFiles.catalogProviders(),
  });
  catalogRef = catalog;
  const providers = new ProviderRegistry({
    catalog,
    config: () => configStore.get(),
    accounts,
  });

  // Server-side OAuth login sessions (ChatGPT/Codex, Anthropic, Copilot,
  // xAI, Nous, MiniMax, Qwen, Vertex). `coreRef` is assigned once the Service
  // exists; login completion broadcasts provider.updated so every surface
  // picks up the new account without a restart.
  const oauth = new OAuthLoginManager({
    accounts,
    onConnected: () => {
      bus.publish({ seq: 0, type: "provider.updated", ts: new Date().toISOString(), payload: {} });
      coreRef?.emitLive("provider.updated", {});
    },
  });

  const workbenches = createDefaultWorkbenches({
    dataDir: dataDir(),
    // fs tools may also touch registered workspaces (config.workspaces) and
    // their attached external folders, not just the session's own cwd.
    workspaceRoots: () => {
      const config = configStore.get();
      return registeredRoots(config.workspaces ?? [], config.workspaceFolders);
    },
    // Media-gen defaults (config imageGen/videoGen) — the executors' fallbacks.
    mediaDefaults: {
      image: () => configStore.get().imageGen,
      video: () => configStore.get().videoGen,
    },
    // The image adapter's runtime: provider credentials + stored reference
    // asset reads (image-to-image data URLs).
    mediaRuntime: {
      resolveCredentials: (providerId, accountId) => providers.resolveCredentials(providerId, accountId),
      readAsset: (id) => {
        const asset = store.assets.get(id);
        if (asset === undefined) return undefined;
        try {
          return { mime: asset.mime, bytes: new Uint8Array(readFileSync(asset.path)) };
        } catch {
          return undefined;
        }
      },
    },
    // File-defined image providers (~/.config/bai/providers/), read live so a
    // dropped file is picked up without a restart.
    mediaCustom: () => providerFilesToMediaDefs(providerFiles.list()),
  });
  const executors: Partial<Record<JobKind, JobExecutor>> = Object.assign(
    {},
    ...workbenches.map((wb) => wb.jobExecutors()),
  );
  const jobs = new JobQueue({
    store,
    bus,
    assetsDir: assetsDir(),
    executors,
    limits: () => {
      const limits = configStore.get().jobs ?? {};
      return {
        timeoutMs: limits.timeoutMs ?? 180_000,
        maxAttempts: limits.maxAttempts ?? 3,
        backoffMs: limits.backoffMs ?? 1500,
        concurrency: limits.concurrency ?? 3,
      };
    },
  });
  // Reconcile jobs interrupted by a previous process and resume leftover queued work.
  jobs.start();

  const tools = new ToolRegistry({ spillDir: tmpDir() });

  // Custom tool files (~/.config/bai/tools/*.ts|js), hot-reloaded. A file
  // may shadow a built-in under the same name; deleting it restores the
  // built-in from the Service's snapshot (builtinFallback). The snapshot
  // accessor is behind a `let` + optional chain: the loader's constructor
  // schedules its first rescan as a microtask, and if boot ever grows an
  // await before the Service exists, the closure must not hit the `core`
  // TDZ (it resolves to undefined and the poller picks the file up later).
  // (`coreRef` is declared at the top of boot, so the closure is safe.)
  const toolLoader: ToolLoader = new ToolLoader({
    dir: path.join(configDir(), "tools"),
    registry: tools,
    builtinFallback: (name) => coreRef?.builtinFallback(name),
    onChange: () => {
      bus.publish({ seq: 0, type: "tools.updated", ts: new Date().toISOString(), payload: {} });
    },
  });

  // External MCP servers. File-first: `~/.config/bai/mcp/<name>.{json,yaml}`
  // is the user layer (hot-reloaded); config.json's `mcp` map is the
  // programmatic layer, and files win on name collisions. The manager connects
  // servers and merges their tools as `mcp/<server>/<tool>`.
  const mcpRegistry = new McpRegistry({
    dir: path.join(configDir(), "mcp"),
    config: () => configStore.get(),
    onChange: () => {
      bus.publish({ seq: 0, type: "mcp.updated", ts: new Date().toISOString(), payload: {} });
      coreRef?.emitLive("mcp.updated", {});
      void mcpManagerRef?.reconcile();
    },
  });
  const mcpManager = new McpManager({
    registry: mcpRegistry,
    tools,
    version: VERSION,
    tokensDir: path.join(dataDir(), "mcp-tokens"),
    // MCP usage analytics (mcp_events): every tool/helper interaction records
    // a best-effort row for the Analytics page's MCP activity card.
    usage: store.mcpUsage,
    onChange: () => {
      bus.publish({ seq: 0, type: "mcp.updated", ts: new Date().toISOString(), payload: {} });
      coreRef?.emitLive("mcp.updated", {});
      bus.publish({ seq: 0, type: "tools.updated", ts: new Date().toISOString(), payload: {} });
      coreRef?.emitLive("tools.updated", {});
    },
  });
  mcpManagerRef = mcpManager;

  // File-defined agents (~/.config/bai/agents/*.md), hot-reloaded; changes
  // broadcast live so every surface refetches without a restart.
  const agents = new AgentRegistry({
    dir: path.join(configDir(), "agents"),
    onChange: () => {
      bus.publish({ seq: 0, type: "agents.updated", ts: new Date().toISOString(), payload: {} });
    },
  });

  // File-defined skills (~/.config/bai/skills/<name>/SKILL.md), hot-reloaded;
  // changes broadcast live so every surface refetches without a restart.
  // Bundled skills (the repo's skills/ dir) seed into it first, with
  // provenance: user edits freeze a skill, user deletions stick forever.
  const skillsDir = path.join(configDir(), "skills");
  const bundled = bundledSkillsDir();
  if (bundled !== undefined) {
    const sync = syncBundledSkills({
      bundledDir: bundled,
      skillsDir,
      optOutFile: path.join(configDir(), ".no-bundled-skills"),
    });
    if (sync.copied.length > 0 || sync.updated.length > 0) {
      console.log(`[bai] bundled skills: ${sync.copied.length} copied, ${sync.updated.length} updated`);
    }
  }
  const skills = new SkillRegistry({
    dir: skillsDir,
    onChange: () => {
      bus.publish({ seq: 0, type: "skills.updated", ts: new Date().toISOString(), payload: {} });
    },
  });

  // Scheduled automations. Constructed before the Service (like JobQueue) and
  // launched through the `coreRef` late-binding: a fire calls back into
  // Service.runAutomation once the core exists.
  const automations = new AutomationScheduler({
    store,
    bus,
    launch: async (automation) => {
      if (coreRef === undefined) throw new Error("Automation fired before the core was ready");
      const { session, done } = coreRef.runAutomation(automation);
      return { sessionId: session.id, done };
    },
    agentExists: (name) => agents.get(name) !== undefined,
    workspaceRoots: () => {
      const config = configStore.get();
      return registeredRoots(config.workspaces ?? [], config.workspaceFolders);
    },
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
    mcp: mcpManager,
    config: () => configStore.get(),
    // Config mutation path for agent tools (workspace.create): the same
    // ConfigStore.update the PUT /api/config route uses — global layer file,
    // atomic write, onChange broadcasts config.updated.
    updateConfig: (patch) => configStore.update(patch),
    removeProvider: (providerId) => configStore.removeProvider(providerId),
    providerFiles,
    version: VERSION,
    sessionFilesDir: path.join(dataDir(), "sessions"),
    assetsDir: assetsDir(),
    snapshot: new Snapshot(snapshotDir(dataDir())),
  });
  coreRef = core;

  // Connect configured MCP servers and merge their tools (non-blocking: a slow
  // or broken server must not delay startup).
  if (args.mode !== "oneshot") {
    void mcpManager.start().catch((err) => {
      console.warn(`[bai] MCP startup failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  // Automations ticker: fires due scheduled prompts. One-shot runs are
  // ephemeral proxies with an in-memory store, so they never own a ticker.
  if (args.mode !== "oneshot") automations.start();

  // TUI = workspace mode: the folder bai is opened in roots new TUI sessions
  // and registers as a workspace (webui-visible). realpath'd so the
  // registration string matches what surfaces compare against (macOS /var →
  // /private/var). Home itself still roots sessions but is not registered —
  // listing ~ among the webui's workspaces is noise. Repeated boots
  // re-register by design: a workspace removed from the webui comes back when
  // bai is launched in that folder again — and an ARCHIVED workspace is
  // restored outright (out of the archive, sessions unarchived), matching the
  // webui's Restore action.
  let workspaceRoot: string | undefined;
  if (args.mode === "tui") {
    try {
      const root = realpathSync(process.cwd());
      // The TUI always works in the launch folder (workspace mode) — that's
      // the current workspace even when it's ~. Only the *registration* of
      // ~ is skipped: listing home among the webui's workspaces is noise.
      workspaceRoot = root;
      if (root !== homedir()) {
        const config = configStore.get();
        const active = config.workspaces ?? [];
        if ((config.archivedWorkspaces ?? []).includes(root)) {
          core.restoreWorkspace(root);
        } else if (!active.includes(root)) {
          configStore.update({ workspaces: [...active, root] });
        }
      }
    } catch (err) {
      console.warn(`[bai] workspace registration skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const token = resolveToken(args, config);
  const app = createApp({
    core,
    store,
    bus,
    log,
    configStore,
    jobs,
    automations,
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
    ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
    loopbackBind: args.mode !== "host",
    stop: async () => {
      // Stop the ticker first so no new run starts while we drain.
      automations.stop();
      core.coordinator.interruptAll();
      // Fail pending agent→user questions so no tool promise hangs.
      core.questions.stop();
      configStore.stop();
      agents.stop();
      skills.stop();
      toolLoader.stop();
      mcpRegistry.stop();
      providerFiles.stop();
      void mcpManager.stop();
      // Cancel in-flight media jobs (records them cancelled) before closing the store.
      await jobs.stop();
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
