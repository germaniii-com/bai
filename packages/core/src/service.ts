import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  systemClock,
  type Clock,
  type Config,
  type Event,
  type EventType,
  type Input,
  type InputId,
  type JobKind,
  type Message,
  type MessageId,
  type PermissionRequest,
  type PermissionStatus,
  type PromptPayload,
  type ProviderListResponse,
  type QuestionRequest,
  type RevertState,
  type Session,
  type SessionId,
  type WorkbenchName,
  type AgentInfo,
  type LearnSkillBody,
  type PutAgentBody,
  type PutSkillBody,
  type SkillInfo,
  type SkillUsageQuery,
  type SkillUsageResponse,
  type SkillUsageTotals,
  type ToolListEntry,
  buildLearnRequest,
  isValidToolName,
  LEARN_AGENT_NAME,
} from "@bai/shared";
import type { AgentRegistry } from "./agent/registry";
import type { Bus } from "./event/bus";
import type { EventLog } from "./event/log";
import type { JobQueue } from "./jobs/queue";
import { PermissionGate } from "./permissions/ask";
import { QuestionService } from "./question/service";
import type { ProviderRegistry } from "./provider/registry";
import { RunCoordinator } from "./run";
import { forkedTitle, isPatchPayload, readRevert } from "./revert";
import type { Snapshot, SnapshotPatch } from "./snapshot";
import { defaultTitle } from "./title";
import type { Store } from "./store/store";
import { questionTool } from "./tools/question";
import { todoTool } from "./tools/todo";
import { webFetchTool } from "./tools/web-fetch";
import { webSearchTool } from "./tools/web-search";
import { bashTool } from "./tools/bash";
import { fsGrepTool } from "./tools/fs-grep";
import { planWriteTool } from "./tools/plan-write";
import { planExitTool } from "./tools/plan-exit";
import { taskTool, taskDescription, type TaskToolDeps } from "./tools/task";
import { skillsViewTool } from "./tools/skills";
import { skillsSaveTool, skillsWriteFileTool, skillsPatchTool, skillsDeleteTool } from "./tools/skills-write";
import type { ToolLoader } from "./tools/loader";
import { builtinOverrideTemplate } from "./tools/loader";
import type { Tool, ToolRegistry } from "./tools/registry";
import type { SkillRegistry } from "./skills/registry";
import { resolveLinkedPath } from "./skills/paths";
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
  /** File-defined skills (~/.config/bai/skills/<name>/SKILL.md), hot-reloaded. */
  skills: SkillRegistry;
  toolLoader: ToolLoader;
  config(): Config;
  version: string;
  /**
   * Directory the plan agent writes plan files into
   * (~/.config/bai/plans in production; a temp dir in tests).
   */
  plansDir: string;
  /**
   * Shadow-repo snapshots (revert's file rollback). Optional: without it
   * revert is message-only (no snapshot/diff on the revert state, no patch
   * parts recorded during runs).
   */
  snapshot?: Snapshot;
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
  readonly questions: QuestionService;
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
    this.questions = new QuestionService({ bus: deps.bus, log: deps.log, clock: this.clock });
    this.coordinator = new RunCoordinator({
      store: deps.store,
      bus: deps.bus,
      log: deps.log,
      clock: this.clock,
      providers: deps.providers,
      tools: deps.tools,
      agents: deps.agents,
      skills: deps.skills,
      permissions: this.permissions,
      defaultModel: () => deps.config().models.default ?? "stub/echo",
      defaultAgent: () => deps.config().agents?.default,
      titleModel: () => deps.config().models.title,
      userName: () => deps.config().user?.name,
      workspaceRoots: () => deps.config().workspaces ?? [],
      // Usage-row rate snapshots (D26): the registry derives effective
      // USD/1M rates from the catalog (vendor cache multipliers applied).
      usageRates: (providerId, model) => deps.providers.usageRates(providerId, model),
      ...(deps.snapshot !== undefined ? { snapshot: deps.snapshot } : {}),
    });
    for (const wb of deps.workbenches) {
      deps.tools.registerAll(wb.tools());
    }
    // Agent-facing interactive tools — auto-allowed (see DEFAULT_PERMISSIONS)
    // since they ARE the agent talking to the user, not touching their system.
    // Web tools stay fail-closed (unmatched → ask); agents opt in via
    // allow-lists and users opt in via the permission dialog.
    deps.tools.registerAll([
      questionTool(this.questions),
      todoTool({ store: deps.store, bus: deps.bus, log: deps.log, clock: this.clock }),
      webFetchTool(),
      webSearchTool({ config: deps.config }),
      bashTool(),
      fsGrepTool(),
      planWriteTool(deps.plansDir),
      planExitTool(this.questions),
      // Progressive disclosure: the index rides the system prompt of agents
      // whose tool set includes this tool; every call lands in skill_events.
      skillsViewTool({ skills: deps.skills, usage: deps.store.skillUsage, clock: this.clock }),
      // Skill authoring (the learn flow): root-restricted to the skills dir
      // inside the tools (plan.write stance) and auto-allowed for the same
      // reason — a knowledge-base learn writes dozens of chapter files.
      skillsSaveTool({ skills: deps.skills }),
      skillsWriteFileTool({ skills: deps.skills }),
      skillsPatchTool({ skills: deps.skills }),
      skillsDeleteTool({ skills: deps.skills }),
    ]);
    // The task tool spawns subagent sessions (tools/task.ts). Registered last
    // so it can close over the coordinator; its description embeds the agent
    // catalog, so agent-file hot-reloads re-register it with a fresh list.
    const taskDeps: TaskToolDeps = {
      agents: deps.agents,
      config: deps.config,
      getSession: (id) => this.getSession(id),
      createSession: (opts) => this.createSession(opts),
      submitPrompt: (id, payload) => this.submitPrompt(id, payload),
      drainNow: (id) => this.drainNow(id),
      interrupt: (id) => this.coordinator.interrupt(id),
      history: (id) => this.history(id),
    };
    deps.tools.register(taskTool(taskDeps, taskDescription(deps.agents)));
    const taskRefresh = deps.bus.subscribe({
      onNotify: () => {
        if (taskRefresh.take().some((evt) => evt.type === "agents.updated")) {
          deps.tools.replace(taskTool(taskDeps, taskDescription(deps.agents)));
          this.emitLive("tools.updated", {});
        }
      },
    });
    // Snapshot the built-in registrations for the tool-override lifecycle:
    // a tool file may shadow a built-in (same name), and deleting that file
    // restores the snapshot via the loader's builtinFallback. Taken at
    // construction — `task` re-registers itself with a fresh agent catalog
    // on agent reloads, so its restore snapshot may carry a stale
    // description (acceptable: the override file is the user's own edit).
    this.builtinTools = new Map(
      deps.tools
        .names()
        .map((name) => deps.tools.get(name))
        .filter((tool): tool is Tool => tool !== undefined && (tool.origin ?? "builtin") === "builtin")
        .map((tool) => [tool.name, tool]),
    );
  }

  /** Built-in registrations snapshot — the loader restores these when an override file is deleted. */
  private readonly builtinTools: Map<string, Tool>;

  /**
   * The original built-in tool for `name`, if any. Wired into the
   * ToolLoader as `builtinFallback`: when an override file is removed, the
   * loader re-registers this instead of leaving the name unregistered.
   */
  builtinFallback(name: string): Tool | undefined {
    return this.builtinTools.get(name);
  }

  // --- sessions ---

  createSession(opts: {
    title?: string;
    workbench?: WorkbenchName;
    cwd?: string;
    /** Ephemeral proxy run — core skips title generation for these. */
    oneshot?: boolean;
    /** Parent session id — marks this session as its subagent (task tool). */
    parent?: SessionId;
    /** Agent for the session (subagent runs); resolves exactly like meta.agent. */
    agent?: string;
    /** Explicit model id pinned into meta (the task tool's model rule). */
    model?: string;
  } = {}): Session {
    const workbench = opts.workbench ?? "chat";
    if (!this.deps.workbenches.some((wb) => wb.name() === workbench)) {
      throw new Error(`Unknown workbench: ${workbench}`);
    }
    if (opts.parent !== undefined && this.deps.store.sessions.get(opts.parent) === undefined) {
      throw new Error(`Unknown parent session: ${opts.parent}`);
    }
    const session = this.deps.store.sessions.insert({
      // Untitled sessions get the "New Chat Session - <timestamp>" default
      // (opencode parity): the AI refine keys on isDefaultTitle, and the
      // default stands whenever the refine fails or is skipped.
      title: opts.title !== undefined && opts.title.length > 0 ? opts.title : defaultTitle(this.clock.iso()),
      workbench,
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      meta: {
        ...(opts.oneshot === true ? { oneshot: true } : {}),
        ...(opts.parent !== undefined ? { parent: opts.parent } : {}),
        ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
        ...(opts.model !== undefined ? { model: opts.model } : {}),
      },
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

  // --- revert & fork (opencode parity) ---

  /** Revert/unrevert/fork mutate history — never mid-drain (api maps to 409). */
  private assertIdle(id: SessionId): void {
    if (this.coordinator.isActive(id)) throw new Error("Session is busy");
  }

  /**
   * Two-phase revert (opencode's SessionRevert.revert): hide everything from
   * the boundary USER message on and roll back the file changes recorded in
   * `patch` parts at/after it. Nothing is deleted yet — the tail is committed
   * (hard-deleted) at the next prompt admission, and `unrevertSession` can
   * restore both files and messages until then. `session.meta.revert` carries
   * the boundary + pre-revert tree hash + diff for the surfaces.
   */
  async revertSession(id: SessionId, messageId: MessageId): Promise<Session> {
    this.assertIdle(id);
    const session = this.deps.store.sessions.get(id);
    if (session === undefined) throw new Error(`Unknown session: ${id}`);
    const history = this.deps.store.messages.history(id);
    const idx = history.findIndex((m) => m.id === messageId);
    if (idx < 0) throw new Error(`Unknown message: ${messageId}`);
    if (history[idx]?.role !== "user") throw new Error("Revert requires a user message");

    const existing = readRevert(session.meta as Record<string, unknown>);
    // Patch parts at/after the boundary — the file changes to roll back.
    const patches: SnapshotPatch[] = [];
    for (const msg of history.slice(idx)) {
      for (const part of msg.parts) {
        if (part.kind === "patch" && isPatchPayload(part.payload)) patches.push(part.payload);
      }
    }

    const revert: RevertState = { messageId };
    const snapshot = this.deps.snapshot;
    if (snapshot !== undefined && session.cwd !== undefined) {
      try {
        // Re-reverting keeps the ORIGINAL pre-revert tree as the unrevert
        // target and un-rolls the previous revert first (opencode revert.ts).
        const target = existing?.snapshot ?? (await snapshot.track(session.cwd));
        if (existing?.snapshot !== undefined) await snapshot.restore(session.cwd, existing.snapshot);
        await snapshot.revert(session.cwd, patches);
        if (target !== undefined) {
          revert.snapshot = target;
          revert.diff = (await snapshot.diff(session.cwd, target)) ?? undefined;
        }
      } catch (err) {
        // File rollback is best-effort — the message revert always applies.
        console.warn(`[bai] revert file rollback skipped: ${err instanceof Error ? err.message : err}`);
      }
    }

    const updated = this.deps.store.sessions.update(id, {
      meta: { ...(session.meta as Record<string, unknown>), revert },
      now: this.clock.iso(),
    });
    if (updated !== undefined) this.emitDurable(id, "session.updated", { session: updated });
    return updated ?? session;
  }

  /**
   * Undo a revert: restore the snapshot's worktree and clear the marker —
   * the hidden messages reappear (they were never deleted). No-op without a
   * pending revert.
   */
  async unrevertSession(id: SessionId): Promise<Session> {
    this.assertIdle(id);
    const session = this.deps.store.sessions.get(id);
    if (session === undefined) throw new Error(`Unknown session: ${id}`);
    const revert = readRevert(session.meta as Record<string, unknown>);
    if (revert === undefined) return session;
    if (revert.snapshot !== undefined && session.cwd !== undefined && this.deps.snapshot !== undefined) {
      try {
        await this.deps.snapshot.restore(session.cwd, revert.snapshot);
      } catch (err) {
        console.warn(`[bai] unrevert file restore failed: ${err instanceof Error ? err.message : err}`);
      }
    }
    const meta = { ...(session.meta as Record<string, unknown>) };
    delete meta.revert;
    const updated = this.deps.store.sessions.update(id, { meta, now: this.clock.iso() });
    if (updated !== undefined) this.emitDurable(id, "session.updated", { session: updated });
    return updated ?? session;
  }

  /**
   * Fork (opencode parity): a new independent session containing everything
   * BEFORE `messageId` (all messages when omitted) with fresh ids; the
   * boundary message itself is excluded — surfaces seed the composer with its
   * text so the user can resend a variant. Title counts up: "X (fork #N)".
   */
  async forkSession(id: SessionId, messageId?: MessageId): Promise<Session> {
    this.assertIdle(id);
    const session = this.deps.store.sessions.get(id);
    if (session === undefined) throw new Error(`Unknown session: ${id}`);

    const created = this.createSession({
      title: forkedTitle(session.title),
      workbench: session.workbench,
      ...(session.cwd !== undefined ? { cwd: session.cwd } : {}),
    });
    const idMap = this.deps.store.messages.copyRange(id, created.id, messageId);

    // Inherit everything except run-scoped identity: no parent (forks are
    // independent — they appear in session pickers), no revert state, and the
    // compaction pointer follows the remapped ids (dropped when its summary
    // wasn't copied).
    const meta: Record<string, unknown> = { ...(session.meta as Record<string, unknown>), forkedFrom: id };
    delete meta.revert;
    delete meta.parent;
    delete meta.oneshot;
    const compactId = meta.compactionMessageId;
    if (typeof compactId === "string") {
      const mapped = idMap.get(compactId as MessageId);
      if (mapped !== undefined) meta.compactionMessageId = mapped;
      else delete meta.compactionMessageId;
    }
    const updated = this.deps.store.sessions.update(created.id, { meta, now: this.clock.iso() });
    if (updated !== undefined) this.emitDurable(created.id, "session.updated", { session: updated });

    // Seed the new session's durable log so surfaces following it — and
    // replay after a restart — can build transcript state from events alone.
    for (const msg of this.deps.store.messages.history(created.id)) {
      this.emitDurable(created.id, "message.created", { messageId: msg.id, role: msg.role });
      for (const part of msg.parts) {
        this.emitDurable(created.id, "message.part.updated", {
          messageId: msg.id,
          partId: part.id,
          kind: part.kind,
          payload: part.payload,
        });
      }
    }
    return updated ?? created;
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

  /**
   * Send-now (opencode parity): flip a pending queued input to steer
   * semantics and wake the coordinator — it promotes immediately when idle,
   * or at the next provider-turn boundary mid-run. The `input.updated`
   * event drops the node from every surface's queued list.
   */
  sendInputNow(sessionId: SessionId, inputId: InputId): Input {
    const input = this.deps.store.inputs.sendNow(sessionId, inputId);
    if (input === undefined) throw new Error(`Unknown or non-pending input: ${inputId}`);
    this.emitDurable(sessionId, "input.updated", { inputId, sessionId, queued: false });
    this.coordinator.wake(sessionId);
    return input;
  }

  /**
   * Cancel ONE pending input (queued or steering) — it never runs. The
   * `input.cancelled` event drops the node from every surface's list.
   */
  cancelInput(sessionId: SessionId, inputId: InputId): Input {
    const input = this.deps.store.inputs.cancelInput(sessionId, inputId);
    if (input === undefined) throw new Error(`Unknown or non-pending input: ${inputId}`);
    this.emitDurable(sessionId, "input.cancelled", { inputId, sessionId });
    return input;
  }

  interrupt(sessionId: SessionId): void {
    this.coordinator.interrupt(sessionId);
  }

  /**
   * Awaitable drain: run the session to idle and resolve (the task tool's
   * child-session wait). See RunCoordinator.drainNow for semantics.
   */
  drainNow(sessionId: SessionId): Promise<void> {
    return this.coordinator.drainNow(sessionId);
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
   * `pendingPermissions` lets a surface opened mid-ask render the dialog
   * immediately (the replayed `permission.asked` covers the same case; this
   * is the cheap authoritative answer).
   */
  sessionSnapshot(sessionId: SessionId): {
    messages: Message[];
    afterSeq: number;
    runActive: boolean;
    pendingPermissions: PermissionRequest[];
    pendingQuestions: QuestionRequest[];
    pendingInputs: Input[];
  } {
    return {
      ...this.deps.store.sessionSnapshot(sessionId),
      runActive: this.coordinator.isActive(sessionId),
      pendingPermissions: this.deps.store.permissions.pendingBySession(sessionId),
      pendingQuestions: this.questions.pendingBySession(sessionId),
    };
  }

  // --- permissions ---

  /**
   * First reply wins (SQL `WHERE status='pending'`): the row flips once,
   * the awaiting tool call resolves, and "always" approvals persist to
   * session meta via the gate. A rejection may carry `message` — the
   * user's feedback, forwarded into the denied tool result.
   */
  replyPermission(
    id: string,
    status: PermissionStatus,
    scope: "once" | "always" = "once",
    message?: string,
  ): PermissionRequest | undefined {
    const request = this.deps.store.permissions.get(id);
    if (request === undefined) return undefined;
    if (request.status !== "pending") return request; // already answered
    const updated = this.deps.store.permissions.reply(id, status);
    if (updated === undefined) return undefined;
    this.permissions.reply(id, status as "approved" | "rejected", scope, message);
    const evt = this.deps.log.append(
      updated.sessionId ?? id,
      "permission.replied",
      { requestId: updated.id, status: updated.status },
      this.clock.iso(),
    );
    this.deps.bus.publish(evt);
    return updated;
  }

  // --- questions (agent → user asks) ---

  /**
   * Answer a pending question block (first reply wins; later replies are
   * no-ops returning false). `answers` is one label-array per question.
   */
  replyQuestion(id: string, answers: string[][]): boolean {
    return this.questions.reply(id, answers);
  }

  /** Dismiss a pending question block; optional user context for the model. */
  rejectQuestion(id: string, message?: string): boolean {
    return this.questions.reject(id, message);
  }

  /** Pending question requests for a session (also rides the snapshot). */
  pendingQuestions(sessionId: SessionId): QuestionRequest[] {
    return this.questions.pendingBySession(sessionId);
  }

  /**
   * Every pending ask across ALL sessions — the global indicator seed for
   * surfaces that list sessions (TUI ctrl+s, web nav badge). Permissions
   * come from the durable store (survive restarts); questions are
   * memory-only (meaningless after one). Session-less asks are included;
   * callers attribute them as they see fit.
   */
  pendingAsks(): { pendingPermissions: PermissionRequest[]; pendingQuestions: QuestionRequest[] } {
    return {
      pendingPermissions: this.deps.store.permissions.pendingAll(),
      pendingQuestions: this.questions.list(),
    };
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

  // --- skills ---

  listSkills(): SkillInfo[] {
    return this.deps.skills.list();
  }

  getSkill(name: string): SkillInfo | undefined {
    return this.deps.skills.get(name);
  }

  /** Create or replace a skill's SKILL.md (surfaces write files through here). */
  putSkill(name: string, body: PutSkillBody): SkillInfo {
    return this.deps.skills.put(name, body);
  }

  deleteSkill(name: string): boolean {
    return this.deps.skills.remove(name);
  }

  /** Read one linked supporting file of a skill (guarded path). */
  skillFile(name: string, filePath: string): string {
    const guard = this.guardLinkedFile(name, filePath);
    return readFileSync(guard, "utf8");
  }

  /** Write one linked supporting file (guarded path; refreshes linkedFiles). */
  putSkillFile(name: string, filePath: string, content: string): void {
    if (content.length === 0 || content.length > 200_000) {
      throw new Error("content must be between 1 and 200,000 characters.");
    }
    const guard = this.guardLinkedFile(name, filePath);
    mkdirSync(path.dirname(guard), { recursive: true });
    writeFileSync(guard, content);
    this.deps.skills.scan();
  }

  /** Delete one linked supporting file (guarded path; prunes empty dirs). */
  deleteSkillFile(name: string, filePath: string): void {
    const guard = this.guardLinkedFile(name, filePath);
    rmSync(guard, { force: true });
    // Prune now-empty support subdirectories (rmdirSync throws on non-empty).
    const skillDir = this.deps.skills.dirFor(name);
    let current = path.dirname(guard);
    while (current !== skillDir && current.startsWith(skillDir + path.sep)) {
      try {
        rmdirSync(current);
      } catch {
        break;
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    this.deps.skills.scan();
  }

  /** Shared linked-file guard: skill must exist, path must be support-scoped. */
  private guardLinkedFile(name: string, filePath: string): string {
    if (this.deps.skills.get(name) === undefined) {
      throw new Error(`Unknown skill: ${name}`);
    }
    const guard = resolveLinkedPath(this.deps.skills.dirFor(name), filePath);
    if (!guard.ok) throw new Error(guard.error);
    return guard.resolved;
  }

  /** Per-skill usage totals (successful views) for the detail pane. */
  skillUsage(name: string): SkillUsageTotals {
    return this.deps.store.skillUsage.forSkill(name);
  }

  /** Skill usage analytics aggregation (GET /api/skill/usage). */
  skillUsageAnalytics(query: SkillUsageQuery): SkillUsageResponse {
    return this.deps.store.skillUsage.analytics(query);
  }

  /**
   * Spawn a learn session (hermes /learn parity, no slash command): a real
   * chat session on the learn agent whose first turn is the standards-guided
   * learn request. The session is visible and cancellable — the drain runs
   * it like any other (the "background job" is a session). The explicit
   * title skips LLM title refinement (the request text would make a poor
   * title seed).
   */
  learnSkill(body: LearnSkillBody): Session {
    const request = body.request.trim();
    const session = this.createSession({
      workbench: "chat",
      title: `Learn: ${request.slice(0, 80)}${request.length > 80 ? "…" : ""}`,
    });
    this.setSessionAgent(session.id, { agent: LEARN_AGENT_NAME });
    if (body.model !== undefined && body.model.trim().length > 0) {
      this.setSessionModel(session.id, {
        model: body.model.trim(),
        ...(body.account !== undefined && body.account.trim().length > 0 ? { account: body.account.trim() } : {}),
      });
    }
    this.submitPrompt(session.id, { text: buildLearnRequest(request) });
    return this.getSession(session.id) ?? session;
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
        // The name belongs to a built-in — for file-origin entries this
        // marks an override the user can reset (delete → built-in restored).
        ...(this.builtinTools.has(name) ? { builtin: true } : {}),
      };
    });
  }

  /**
   * Write a custom tool file; hot-registers via the loader. A name may also
   * shadow a registered built-in (any name shape — e.g. "fs.read"): the
   * file overrides the built-in until it is deleted, which restores the
   * original registration. Unknown dotted names are still rejected.
   */
  async putTool(name: string, code: string): Promise<{ name: string; registered: boolean }> {
    const isBuiltin = this.deps.tools.get(name)?.origin === "builtin";
    if (!isValidToolName(name) && !isBuiltin) throw new Error(`Invalid tool name: ${name}`);
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

  /**
   * Current source of a tool file (surfaces read it back for editing).
   * For a registered built-in with no override file yet, returns a
   * generated override template pre-filled with the built-in's real
   * description and schema — saving it shadows the built-in.
   */
  getToolCode(name: string): string {
    const tsFile = path.join(this.toolLoaderDir(), `${name}.ts`);
    const jsFile = path.join(this.toolLoaderDir(), `${name}.js`);
    const file = existsSync(tsFile) ? tsFile : existsSync(jsFile) ? jsFile : undefined;
    if (file !== undefined) return readFileSync(file, "utf8");
    const builtin = this.deps.tools.get(name);
    if (builtin !== undefined && (builtin.origin ?? "builtin") === "builtin") {
      return builtinOverrideTemplate(builtin);
    }
    throw new Error(`No tool file for "${name}"`);
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
