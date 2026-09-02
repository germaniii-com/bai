import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  systemClock,
  type Clock,
  type Config,
  type Event,
  type EventType,
  type Input,
  type JobKind,
  type Message,
  type PermissionRequest,
  type PermissionStatus,
  type PromptPayload,
  type ProviderListResponse,
  type Session,
  type SessionId,
  type WorkbenchName,
  type AgentInfo,
  type PutAgentBody,
  type ToolListEntry,
  isValidToolName,
} from "@bai/shared";
import type { AgentRegistry } from "./agent/registry";
import type { Bus } from "./event/bus";
import type { EventLog } from "./event/log";
import type { JobQueue } from "./jobs/queue";
import { PermissionGate } from "./permissions/ask";
import type { ProviderRegistry } from "./provider/registry";
import { RunCoordinator } from "./run";
import { defaultTitle } from "./title";
import type { Store } from "./store/store";
import type { ToolLoader } from "./tools/loader";
import type { Tool, ToolRegistry } from "./tools/registry";
import type { Workbench } from "./workbench/types";

export interface ServiceDeps {
  store: Store;
  bus: Bus;
  log: EventLog;
  clock?: Clock;
  providers: ProviderRegistry;
  tools: ToolRegistry;
  workbenches: Workbench[];
  jobs: JobQueue;
  agents: AgentRegistry;
  toolLoader: ToolLoader;
  config(): Config;
  version: string;
}

/**
 * The domain heart: sessions, runs, tools, permissions. Knows nothing about
 * terminals, browsers, or HTTP — everything is emitted through the event
 * system; surfaces are notified exclusively via events.
 */
export class Service {
  readonly coordinator: RunCoordinator;
  readonly workbenches: Workbench[];
  readonly permissions: PermissionGate;
  private readonly clock: Clock;

  constructor(private deps: ServiceDeps) {
    this.clock = deps.clock ?? systemClock;
    this.workbenches = deps.workbenches;
    this.permissions = new PermissionGate({
      store: deps.store,
      bus: deps.bus,
      log: deps.log,
      clock: this.clock,
      config: deps.config,
    });
    this.coordinator = new RunCoordinator({
      store: deps.store,
      bus: deps.bus,
      log: deps.log,
      clock: this.clock,
      providers: deps.providers,
      tools: deps.tools,
      agents: deps.agents,
      permissions: this.permissions,
      defaultModel: () => deps.config().models.default ?? "stub/echo",
      defaultAgent: () => deps.config().agents?.default,
      titleModel: () => deps.config().models.title,
    });
    for (const wb of deps.workbenches) {
      deps.tools.registerAll(wb.tools());
    }
  }

  // --- sessions ---

  createSession(opts: {
    title?: string;
    workbench?: WorkbenchName;
    cwd?: string;
    /** Ephemeral proxy run — core skips title generation for these. */
    oneshot?: boolean;
  } = {}): Session {
    const workbench = opts.workbench ?? "chat";
    if (!this.deps.workbenches.some((wb) => wb.name() === workbench)) {
      throw new Error(`Unknown workbench: ${workbench}`);
    }
    const session = this.deps.store.sessions.insert({
      // Untitled sessions get the "New Chat Session - <timestamp>" default
      // (opencode parity): the AI refine keys on isDefaultTitle, and the
      // default stands whenever the refine fails or is skipped.
      title: opts.title !== undefined && opts.title.length > 0 ? opts.title : defaultTitle(this.clock.iso()),
      workbench,
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      ...(opts.oneshot === true ? { meta: { oneshot: true } } : {}),
      now: this.clock.iso(),
    });
    this.emitDurable(session.id, "session.created", { session });
    return session;
  }

  listSessions(
    limit = 50,
    offset = 0,
    filters: { workbench?: string; cwd?: string } = {},
  ): Session[] {
    return this.deps.store.sessions.list(limit, offset, filters);
  }

  getSession(id: SessionId): Session | undefined {
    return this.deps.store.sessions.get(id);
  }

  renameSession(id: SessionId, title: string): Session | undefined {
    const session = this.deps.store.sessions.update(id, { title, now: this.clock.iso() });
    if (session) this.emitDurable(id, "session.updated", { session });
    return session;
  }

  archiveSession(id: SessionId): Session | undefined {
    const existing = this.deps.store.sessions.get(id);
    if (!existing) return undefined;
    const session = this.deps.store.sessions.update(id, {
      meta: { ...existing.meta, archived: true },
      now: this.clock.iso(),
    });
    if (session) this.emitDurable(id, "session.updated", { session });
    return session;
  }

  // --- prompts & runs ---

  /** Durable admission first (crash-safe), then wake the coordinator. */
  submitPrompt(sessionId: SessionId, payload: PromptPayload): Input {
    if (!this.deps.store.sessions.get(sessionId)) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    const input = this.deps.store.inputs.admit(sessionId, payload, this.clock.iso());
    this.emitDurable(sessionId, "input.admitted", {
      inputId: input.id,
      sessionId,
      text: payload.text,
      queued: payload.queue ?? false,
    });
    this.coordinator.wake(sessionId);
    return input;
  }

  interrupt(sessionId: SessionId): void {
    this.coordinator.interrupt(sessionId);
  }
  history(sessionId: SessionId): Message[] {
    return this.deps.store.messages.history(sessionId);
  }

  /**
   * History + event-log cursor in one consistent read — the snapshot half of
   * snapshot-then-stream. Surfaces open the durable stream with afterSeq so
   * replay never duplicates what the snapshot already contains. `runActive`
   * covers runs that started before the cursor (a mid-run switch or a
   * just-submitted first prompt) — live events alone can't signal those.
   */
  sessionSnapshot(sessionId: SessionId): { messages: Message[]; afterSeq: number; runActive: boolean } {
    return {
      ...this.deps.store.sessionSnapshot(sessionId),
      runActive: this.coordinator.isActive(sessionId),
    };
  }

  // --- permissions ---

  /**
   * First reply wins (SQL `WHERE status='pending'`): the row flips once,
   * the awaiting tool call resolves, and "always" approvals persist to
   * session meta via the gate.
   */
  replyPermission(id: string, status: PermissionStatus, scope: "once" | "always" = "once"): PermissionRequest | undefined {
    const request = this.deps.store.permissions.get(id);
    if (request === undefined) return undefined;
    if (request.status !== "pending") return request; // already answered
    const updated = this.deps.store.permissions.reply(id, status);
    if (updated === undefined) return undefined;
    this.permissions.reply(id, status as "approved" | "rejected", scope);
    const evt = this.deps.log.append(
      updated.sessionId ?? id,
      "permission.replied",
      { requestId: updated.id, status: updated.status },
      this.clock.iso(),
    );
    this.deps.bus.publish(evt);
    return updated;
  }

  // --- agents ---

  listAgents(): AgentInfo[] {
    return this.deps.agents.list();
  }

  getAgent(name: string): AgentInfo | undefined {
    return this.deps.agents.get(name);
  }

  /** Create or replace an agent file (surfaces write files through here). */
  putAgent(name: string, body: PutAgentBody): AgentInfo {
    return this.deps.agents.put(name, body);
  }

  deleteAgent(name: string): boolean {
    return this.deps.agents.remove(name);
  }

  /** Agent file path for surface-side editing (e.g. $EDITOR in the TUI). */
  agentFile(name: string): string {
    return this.deps.agents.fileFor(name);
  }

  // --- custom tools ---

  /** Registered tools projected for surfaces (schemas included, no code). */
  listTools(): ToolListEntry[] {
    return this.deps.tools.names().map((name) => {
      const tool = this.deps.tools.get(name) as Tool;
      const isFile = tool.origin === "file";
      return {
        name,
        description: tool.description,
        origin: tool.origin ?? "builtin",
        schema: tool.schema,
        ...(isFile ? { path: path.join(this.toolLoaderDir(), `${name}.ts`) } : {}),
      };
    });
  }

  /** Write a custom tool file; hot-registers via the loader. */
  async putTool(name: string, code: string): Promise<{ name: string; registered: boolean }> {
    if (!isValidToolName(name)) throw new Error(`Invalid tool name: ${name}`);
    if (this.deps.tools.has(name) && this.deps.tools.get(name)?.origin === "builtin") {
      throw new Error(`"${name}" is a built-in tool and cannot be overwritten`);
    }
    const file = path.join(this.toolLoaderDir(), `${name}.ts`);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, code);
    renameSync(tmp, file);
    await this.deps.toolLoader.rescan();
    return { name, registered: this.deps.tools.has(name) };
  }

  async deleteTool(name: string): Promise<boolean> {
    const file = path.join(this.toolLoaderDir(), `${name}.ts`);
    const jsFile = path.join(this.toolLoaderDir(), `${name}.js`);
    const target = existsSync(file) ? file : existsSync(jsFile) ? jsFile : undefined;
    if (target === undefined) return false;
    rmSync(target);
    await this.deps.toolLoader.rescan();
    return true;
  }

  /** Custom-tool file path for surface-side editing. */
  toolFile(name: string): string {
    return path.join(this.toolLoaderDir(), `${name}.ts`);
  }

  /** Current source of a custom tool file (surfaces read it back for editing). */
  getToolCode(name: string): string {
    const tsFile = path.join(this.toolLoaderDir(), `${name}.ts`);
    const jsFile = path.join(this.toolLoaderDir(), `${name}.js`);
    const file = existsSync(tsFile) ? tsFile : existsSync(jsFile) ? jsFile : undefined;
    if (file === undefined) throw new Error(`No tool file for "${name}" (built-in tools have no editable source)`);
    return readFileSync(file, "utf8");
  }

  private toolLoaderDir(): string {
    // The loader owns the directory; expose it for file writes via a getter
    // stored at construction time.
    return this.deps.toolLoader.dir();
  }

  // --- jobs ---

  enqueueJob(kind: JobKind, sessionId: SessionId | undefined, input: unknown) {
    return this.deps.jobs.enqueue(kind, sessionId, input);
  }

  // --- providers & accounts ---

  /** Merged provider view (catalog ⊕ config ⊕ accounts) for the API layer. */
  providers(): Promise<ProviderListResponse> {
    return this.deps.providers.listResponse();
  }

  /** Upsert an account and notify every surface (live event, no restart). */
  setAccount(providerId: string, accountId: string, input: { label?: string; key?: string; baseUrl?: string }) {
    const account = this.deps.providers.setAccount(providerId, accountId, input);
    this.emitLive("provider.updated", {});
    return account;
  }

  removeAccount(providerId: string, accountId: string): boolean {
    const removed = this.deps.providers.removeAccount(providerId, accountId);
    if (removed) this.emitLive("provider.updated", {});
    return removed;
  }

  /**
   * Set (or clear) the per-session model/account. Stored in `session.meta`
   * (JSON column — no migration); the next drain picks it up immediately.
   */
  setSessionModel(
    id: SessionId,
    body: { model?: string; account?: string; clear?: boolean },
  ): Session | undefined {
    const existing = this.deps.store.sessions.get(id);
    if (existing === undefined) return undefined;
    const meta = { ...(existing.meta as Record<string, unknown>) };
    if (body.clear === true) {
      delete meta.model;
      delete meta.account;
    } else {
      if (body.model !== undefined) meta.model = body.model;
      if (body.account !== undefined) meta.account = body.account;
    }
    const session = this.deps.store.sessions.update(id, { meta, now: this.clock.iso() });
    if (session) this.emitDurable(id, "session.updated", { session });
    return session;
  }

  /**
   * Set (or clear) the per-session agent. Stored in `session.meta` (no
   * migration); unknown names are rejected so surfaces get immediate
   * feedback. The next drain resolves the agent fresh (hot-reload aware).
   */
  setSessionAgent(id: SessionId, body: { agent?: string; clear?: boolean }): Session | undefined {
    const existing = this.deps.store.sessions.get(id);
    if (existing === undefined) return undefined;
    if (body.clear === true) {
      const meta = { ...(existing.meta as Record<string, unknown>) };
      delete meta.agent;
      const session = this.deps.store.sessions.update(id, { meta, now: this.clock.iso() });
      if (session) this.emitDurable(id, "session.updated", { session });
      return session;
    }
    const name = body.agent ?? "";
    if (this.deps.agents.get(name) === undefined) {
      throw new Error(`Unknown agent: ${name}`);
    }
    const meta = { ...(existing.meta as Record<string, unknown>), agent: name };
    const session = this.deps.store.sessions.update(id, { meta, now: this.clock.iso() });
    if (session) this.emitDurable(id, "session.updated", { session });
    return session;
  }

  // --- events ---

  /** Durable append + live publish of the same envelope. */
  emitDurable(sessionId: SessionId, type: Parameters<EventLog["append"]>[1], payload: unknown): void {
    const evt = this.deps.log.append(sessionId, type, payload, this.clock.iso());
    this.deps.bus.publish(evt);
  }

  /** Live-only broadcast (firehose), e.g. config.updated / server.hello. */
  emitLive(type: EventType, payload: unknown): void {
    this.deps.bus.publish({
      seq: 0,
      type,
      ts: this.clock.iso(),
      payload,
    } as Event);
  }

  version(): string {
    return this.deps.version;
  }
}
