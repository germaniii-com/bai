import type { AgentInfo, AskOutcome, Clock, EventType, MessageId, PartId, PromptPayload, QuestionReview, SessionId } from "@bai/shared";
import type { AgentRegistry } from "./agent/registry";
import { applyDiscipline } from "./context/discipline";
import { buildSummaryInput, shouldCompact, SUMMARY_PREFIX, SUMMARY_SYSTEM_PROMPT } from "./context/compact";
import type { Bus } from "./event/bus";
import type { EventLog } from "./event/log";
import { renderOutbound, isToolCallPayload } from "./run/history";
import { buildEnvBlock } from "./run/env";
import { readRevert, SNAPSHOT_TOOLS } from "./revert";
import type { Snapshot } from "./snapshot";
import type { PermissionGate } from "./permissions/ask";
import type { ProviderRegistry, ResolvedCredentials } from "./provider/registry";
import type { Provider, StreamEvent, ToolDef } from "./provider/types";
import type { Store } from "./store/store";
import type { ToolContext, ToolRegistry } from "./tools/registry";
import { askDetailFor } from "./tools/ask-detail";
import { isDefaultTitle, sanitizeGeneratedTitle, TITLE_SYSTEM_PROMPT } from "./title";

interface ActiveRun {
  controller: AbortController;
  /** Settles when the drain (including coalesced wakes) finishes. */
  done: Promise<void>;
}

/** The detached title refine's hard budget — a hung provider must not leak. */
const TITLE_TIMEOUT_MS = 10_000;
/** Prompt text bound for the title call (titles don't need full prompts). */
const TITLE_PROMPT_CHARS = 2000;
/** Hard cap on agentic iterations per drain (provider turns), phase-1 constant. */
const MAX_STEPS = 50;
/** Told to the model on its final tool-less turn when the step cap trips. */
const STEPS_NOTICE = "Maximum tool-calling steps reached. Stop calling tools and respond with a final text answer now.";
/**
 * Tools subagent sessions are never offered or allowed: no recursion, no
 * mid-run user questions, no plan hand-off — children run autonomously and
 * return one final message (opencode's default task/todowrite denies,
 * adapted to bai's toolset). Enforced in toolDefsFor (offering) AND
 * executeCalls (gate-side backstop).
 */
const SUBAGENT_STRIPPED = new Set(["task", "question", "plan.exit"]);
/** The compaction summarizer's hard budget — a hung provider must not leak. */
const COMPACT_TIMEOUT_MS = 60_000;

export interface RunCoordinatorDeps {
  store: Store;
  bus: Bus;
  log: EventLog;
  clock: Clock;
  providers: ProviderRegistry;
  tools: ToolRegistry;
  agents: AgentRegistry;
  permissions: PermissionGate;
  /** Resolves the effective default model id, e.g. "stub/echo". */
  defaultModel(): string;
  /** Configured default agent name (config agents.default), when set. */
  defaultAgent(): string | undefined;
  /** Configured title-call model (config models.title), when set. */
  titleModel(): string | undefined;
  /** Registered workspace roots — fs-tool agents get them in <env> when the session has no cwd. */
  workspaceRoots(): string[];
  /**
   * Shadow-repo snapshots (revert's file rollback input). Undefined → runs
   * never record patch parts and revert is message-only.
   */
  snapshot?: Snapshot;
}

/** One completed tool call streamed by the model, ready to execute. */
interface ParsedCall {
  callId: string;
  name: string;
  args: string;
  partId: PartId;
}

/** One call after gating: ready to execute, or already carrying its error text. */
interface GatedCall {
  call: ParsedCall;
  args?: unknown;
  error?: string;
  /** True when the error came from the permission gate (ends an all-denied run). */
  denied?: boolean;
  /** Answered interactive ask (when the gate raised one) — retained on the result. */
  ask?: AskOutcome;
}

/** One turn's wiring — agent, model, credentials, tool defs (see resolveRunContext). */
interface RunContext {
  agent: AgentInfo;
  provider: Provider;
  providerId: string;
  model: string;
  reasoning: boolean | undefined;
  contextWindow: number | undefined;
  credentials: ResolvedCredentials;
  toolDefs: ToolDef[];
  auth: { apiKey?: string; baseUrl?: string };
}

/**
 * One drain per session (process-global map keyed by session ID); different
 * sessions run concurrently. Wakes are joined/coalesced. Interrupt cancels
 * the drain; admitted-but-unpromoted inputs stay queued.
 */
export class RunCoordinator {
  private active = new Map<SessionId, ActiveRun>();
  private pendingWake = new Set<SessionId>();

  constructor(private deps: RunCoordinatorDeps) {}

  isActive(sessionId: SessionId): boolean {
    return this.active.has(sessionId);
  }

  activeSessions(): SessionId[] {
    return [...this.active.keys()];
  }

  wake(sessionId: SessionId): void {
    if (this.active.has(sessionId)) {
      this.pendingWake.add(sessionId);
      return;
    }
    this.ensureDrain(sessionId).catch((err: unknown) => {
      // Drain errors still terminate the run cleanly.
      this.active.delete(sessionId);
      this.emitDurable(sessionId, "run.finished", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  /**
   * Drain the session now and resolve when it goes idle — the awaitable face
   * of `wake`, used by the task tool to run a child session to completion.
   * A drain already in flight (plus its coalesced wakes) is awaited, never
   * duplicated. Errors resolve instead of rejecting — callers inspect the
   * transcript; the {error} emission still happens via wake's handler.
   */
  drainNow(sessionId: SessionId): Promise<void> {
    return this.ensureDrain(sessionId).catch(() => {});
  }

  interrupt(sessionId: SessionId): void {
    this.active.get(sessionId)?.controller.abort();
  }

  interruptAll(): void {
    for (const run of this.active.values()) run.controller.abort();
  }

  /**
   * The single drain entry: returns the active run's done promise, or starts
   * a drain and returns its promise. The done promise rejects on drain
   * errors — `wake` turns that into a durable run.finished {error}; on the
   * happy path it resolves when the drain goes idle. Cleanup (active.delete
   * + the {aborted} run.finished emission) always runs first, so the
   * two-emission error path surfaces already handle is preserved in order.
   */
  private ensureDrain(sessionId: SessionId): Promise<void> {
    const existing = this.active.get(sessionId);
    if (existing !== undefined) return existing.done;
    const controller = new AbortController();
    let settleDone!: () => void;
    let settleError!: (err: unknown) => void;
    const done = new Promise<void>((resolve, reject) => {
      settleDone = resolve;
      settleError = reject;
    });
    this.active.set(sessionId, { controller, done });
    this.emitDurable(sessionId, "run.started", {});
    const run = (async () => {
      do {
        this.pendingWake.delete(sessionId);
        await this.drainOnce(sessionId, controller.signal);
      } while (this.pendingWake.has(sessionId) && !controller.signal.aborted);
    })();
    void run
      .catch(() => {})
      .finally(() => {
        this.active.delete(sessionId);
        this.emitDurable(sessionId, "run.finished", { aborted: controller.signal.aborted });
      });
    void run.then(settleDone, settleError);
    return done;
  }

  /**
   * Promote eligible inputs, then loop provider turns: stream → persist
   * parts → execute tool calls → repeat while the model keeps calling tools
   * (state-based continuation: some providers report `stop` alongside tool
   * calls, so the presence of executed calls drives the loop, not the
   * finish reason alone).
   */
  private async drainOnce(sessionId: SessionId, signal: AbortSignal): Promise<void> {
    const promoted = this.deps.store.inputs.promoteReady(sessionId);
    if (promoted.length === 0) return;

    // A pending revert is committed by the next prompt (opencode's cleanup):
    // the boundary message and everything after it are hard-deleted BEFORE
    // the new user message lands, so transcript ordering stays intact.
    this.revertCleanup(sessionId);

    const now = this.deps.clock.iso();
    for (const input of promoted) {
      const message = this.deps.store.messages.append(sessionId, "user", now);
      const part = this.deps.store.parts.append(message.id, 0, "text", { text: input.payload.text });
      this.emitDurable(sessionId, "message.created", { messageId: message.id, role: "user" });
      // The user's text must ride the event stream — surfaces build state from
      // events alone between snapshots, and message.created carries no payload.
      this.emitDurable(sessionId, "message.part.updated", {
        messageId: message.id,
        partId: part.id,
        kind: "text",
        payload: { text: input.payload.text },
      });
    }

    const session = this.deps.store.sessions.get(sessionId);
    if (!session) return;
    const meta = session.meta as { model?: unknown; account?: unknown; oneshot?: unknown; agent?: unknown };

    // Session titling: untitled sessions are created as "New Chat Session -
    // <timestamp>"; the first prompt of a default-titled session kicks off a
    // detached mini LLM call that replaces the default — one-shot sessions
    // are ephemeral proxies, no title spend.
    const firstPrompt = promoted[0]?.payload.text ?? "";
    const refineTitle = isDefaultTitle(session.title) && meta.oneshot !== true && firstPrompt.length > 0;

    // Everything a turn needs — agent, model wiring, tool defs — in one
    // re-resolvable snapshot. Re-resolved mid-run when the session's agent
    // changes (plan.exit's mid-run switch to build).
    let run = await this.resolveRunContext(sessionId);

    if (refineTitle && run.providerId !== "stub") {
      const title = await this.resolveTitleModel(run.providerId, { provider: run.provider, model: run.model, credentials: run.credentials });
      this.refineSessionTitle({
        sessionId,
        provider: title.provider,
        model: title.model,
        credentials: title.credentials,
        defaultTitle: session.title,
        prompt: firstPrompt,
      });
    }

    for (let step = 1; ; step++) {
      const finalStep = step >= MAX_STEPS;
      const toolDefs = finalStep ? [] : run.toolDefs;
      // The agent persona + a session-metadata block (cwd, workbench,
      // available tools, platform, date) — subagents inherit their parent's
      // cwd via their own session row, so the whole tree knows where it is.
      const system = [
        ...(run.agent.prompt.trim().length > 0 ? [run.agent.prompt] : []),
        buildEnvBlock({
          ...(session?.cwd !== undefined ? { cwd: session.cwd } : {}),
          workbench: session?.workbench ?? "chat",
          title: session?.title ?? "",
          agent: run.agent.name,
          tools: run.toolDefs.map((d) => d.name),
          workspaces: this.deps.workspaceRoots(),
          now: this.deps.clock.iso(),
        }),
        ...(finalStep ? [STEPS_NOTICE] : []),
      ];

      // History → revert cut → compaction pointer slice → token discipline →
      // render. history() returns fresh objects, so the in-place discipline
      // transforms never touch the durable transcript.
      let history = this.deps.store.messages.history(sessionId);
      // Defensive two-phase-revert cut (cleanup normally already ran at
      // admission): never render the boundary message or anything after it.
      const revertBoundary = readRevert(this.readMeta(sessionId))?.messageId;
      if (revertBoundary !== undefined) {
        const boundaryIdx = history.findIndex((m) => m.id === revertBoundary);
        if (boundaryIdx >= 0) history = history.slice(0, boundaryIdx);
      }
      const compactId = this.compactionPointer(sessionId);
      if (compactId !== undefined) {
        const idx = history.findIndex((m) => m.id === compactId);
        if (idx >= 0) history = history.slice(idx); // the summary leads as a user message
      }
      applyDiscipline(history);
      const outbound = renderOutbound(history, { system });

      const stream = await run.provider.stream({
        model: run.model,
        messages: outbound,
        ...(toolDefs.length > 0 ? { tools: toolDefs } : {}),
        auth: run.auth,
        // Reasoning models: enable extended thinking so reasoning tokens flow
        // (chat turns; adapters skip thinking on agentic turns themselves).
        ...(run.reasoning && toolDefs.length === 0 ? { params: { thinking: { type: "enabled", budget_tokens: 2048 } } } : {}),
        signal,
      });

      const assistant = this.deps.store.messages.append(sessionId, "assistant", this.deps.clock.iso());
      this.emitDurable(sessionId, "message.created", { messageId: assistant.id, role: "assistant" });

      let calls: ParsedCall[] = [];
      let stopReason: string | undefined;
      let usage: { inputTokens?: number; outputTokens?: number } | undefined;
      try {
        const consumed = await this.consumeStream(sessionId, assistant.id, stream, toolDefs.length > 0, signal);
        calls = consumed.calls;
        stopReason = consumed.stopReason;
        usage = consumed.usage;
      } catch (err) {
        // An interrupt cancels the in-flight request → the adapter's iterator
        // throws; that's a clean stop, not a failure. Real errors propagate.
        if (!signal.aborted) throw err;
        break;
      } finally {
        await stream.close();
      }

      if (usage?.inputTokens !== undefined) this.recordUsage(sessionId, usage);

      if (calls.length === 0 || signal.aborted) {
        // End-of-run compaction check: the recorded usage decides whether
        // the next prompt starts from a summary pointer.
        await this.maybeCompact(sessionId, usage, run.contextWindow, run.providerId, { provider: run.provider, model: run.model, credentials: run.credentials }, signal);
        break;
      }

      // A `length` stop means streamed arguments may be silently truncated —
      // executing them could corrupt files. Fail the batch and end the run
      // (pi agent-loop.ts:229-233).
      if (stopReason === "length") {
        for (const call of calls) {
          this.persistToolResult(sessionId, assistant.id, call, "Tool call aborted: the model response was cut off by the token limit before the arguments completed.", true);
        }
        break;
      }

      const outcomes = await this.executeCalls(sessionId, assistant.id, calls, signal);

      // Mid-run agent switch (plan.exit → build): the session's meta.agent
      // changed while executing — re-resolve agent, model, and tool defs so
      // the next step continues with the new agent (opencode's plan→build).
      const switched = await this.refreshAgentIfSwitched(sessionId, run.agent.name);
      if (switched !== undefined) run = switched;

      if (finalStep) break;
      // Fail-closed: if every call was denied, end the run instead of
      // letting the model retry into the same wall.
      if (outcomes.length > 0 && outcomes.every((o) => o === "denied")) break;
    }
  }

  /**
   * Commit a pending two-phase revert (opencode's revert cleanup): hard-delete
   * the boundary message and everything after it, emit `message.removed` per
   * id, clear the compaction pointer when it pointed into the removed range,
   * and clear the revert marker. Runs at prompt admission — the revert stays
   * undoable (unrevert) until the user sends the next message.
   */
  private revertCleanup(sessionId: SessionId): void {
    const revert = readRevert(this.readMeta(sessionId));
    if (revert === undefined) return;
    const removed = this.deps.store.messages.removeFrom(sessionId, revert.messageId);
    const session = this.deps.store.sessions.get(sessionId);
    if (session === undefined) return;
    const meta = { ...(session.meta as Record<string, unknown>) };
    delete meta.revert;
    const compactId = meta.compactionMessageId;
    if (typeof compactId === "string" && removed.includes(compactId as MessageId)) {
      delete meta.compactionMessageId; // the summary it pointed at was reverted away
    }
    const updated = this.deps.store.sessions.update(sessionId, { meta, now: this.deps.clock.iso() });
    for (const id of removed) {
      this.emitDurable(sessionId, "message.removed", { messageId: id });
    }
    if (updated !== undefined) this.emitDurable(sessionId, "session.updated", { session: updated });
  }

  /**
   * One turn's wiring: agent (meta → config default → built-in), model
   * (session choice → agent default → global), credentials, and the tool
   * defs (registry ∩ agent allow-list, order-stable for prompt caching).
   */
  private async resolveRunContext(sessionId: SessionId): Promise<RunContext> {
    const meta = this.readMeta(sessionId) as { model?: unknown; account?: unknown; agent?: unknown; parent?: unknown };
    const requestedAgent = typeof meta.agent === "string" && meta.agent.length > 0 ? meta.agent : undefined;
    let agent: AgentInfo | undefined = requestedAgent !== undefined ? this.deps.agents.get(requestedAgent) : undefined;
    if (requestedAgent !== undefined && agent === undefined) {
      console.warn(`[bai] session ${sessionId} selected unknown agent "${requestedAgent}"; using default`);
    }
    const defaultAgentName = this.deps.defaultAgent();
    if (agent === undefined && typeof defaultAgentName === "string" && defaultAgentName.length > 0) {
      agent = this.deps.agents.get(defaultAgentName);
      if (agent === undefined) {
        console.warn(`[bai] config default agent "${defaultAgentName}" not found; using default`);
      }
    }
    agent = agent ?? this.deps.agents.default();

    // Model precedence: explicit per-session choice > agent default > global.
    const modelId =
      typeof meta.model === "string" && meta.model.length > 0
        ? meta.model
        : (agent.model ?? this.deps.defaultModel());
    const { provider, providerId, model, reasoning, contextWindow } = await this.deps.providers.resolveModel(modelId);
    const requestedAccount = typeof meta.account === "string" && meta.account.length > 0 ? meta.account : undefined;
    const account = requestedAccount ?? (await this.deps.providers.defaultAccount(providerId));
    const credentials = await this.deps.providers.resolveCredentials(providerId, account);

    return {
      agent,
      provider,
      providerId,
      model,
      reasoning,
      contextWindow,
      credentials,
      toolDefs: this.toolDefsFor(agent, typeof meta.parent === "string" && meta.parent.length > 0),
      auth: {
        ...(credentials.apiKey !== undefined ? { apiKey: credentials.apiKey } : {}),
        ...(credentials.baseUrl !== undefined ? { baseUrl: credentials.baseUrl } : {}),
      },
    };
  }

  /**
   * When the session's agent selection changed during the last executeCalls
   * (plan.exit's switchAgent), re-resolve the run context. Returns undefined
   * when nothing changed or re-resolution failed (the current context stays).
   */
  private async refreshAgentIfSwitched(sessionId: SessionId, currentAgent: string): Promise<RunContext | undefined> {
    const selected = this.readMeta(sessionId).agent;
    if (typeof selected !== "string" || selected.length === 0 || selected === currentAgent) return undefined;
    if (this.deps.agents.get(selected) === undefined) return undefined; // unknown name — keep current
    try {
      return await this.resolveRunContext(sessionId);
    } catch (err) {
      console.warn(`[bai] agent switch to "${selected}" failed to resolve; continuing as ${currentAgent}: ${err instanceof Error ? err.message : err}`);
      return undefined;
    }
  }

  /** Tool allow-list → registered ToolDefs (order-stable for prompt caching). */
  private toolDefsFor(agent: AgentInfo, isSubagent: boolean): ToolDef[] {
    const wanted = agent.tools.includes("*") ? null : new Set(agent.tools);
    const defs: ToolDef[] = [];
    for (const name of this.deps.tools.names()) {
      if (wanted !== null && !wanted.has(name)) continue;
      if (isSubagent && SUBAGENT_STRIPPED.has(name)) continue;
      const tool = this.deps.tools.get(name);
      if (tool === undefined) continue;
      defs.push({ name, description: tool.description, schema: tool.schema });
    }
    return defs;
  }

  // --- context management (token discipline + compaction) ---

  private readMeta(sessionId: SessionId): Record<string, unknown> {
    return (this.deps.store.sessions.get(sessionId)?.meta ?? {}) as Record<string, unknown>;
  }

  private compactionPointer(sessionId: SessionId): MessageId | undefined {
    const id = this.readMeta(sessionId).compactionMessageId;
    return typeof id === "string" && id.length > 0 ? (id as MessageId) : undefined;
  }

  /** Persist the latest provider-reported usage — the compaction trigger input. */
  private recordUsage(sessionId: SessionId, usage: { inputTokens?: number; outputTokens?: number }): void {
    const existing = this.deps.store.sessions.get(sessionId);
    if (existing === undefined) return;
    const meta = { ...(existing.meta as Record<string, unknown>), lastUsage: usage };
    // Quiet bookkeeping — no session.updated spam; surfaces read usage via meta.
    this.deps.store.sessions.update(sessionId, { meta, now: this.deps.clock.iso() });
  }

  /**
   * Compaction: when the last provider-reported input crosses the window
   * threshold, summarize the transcript with the small-model path and store
   * a summary pointer. Best-effort: failures leave the run untouched.
   */
  private async maybeCompact(
    sessionId: SessionId,
    usage: { inputTokens?: number; outputTokens?: number } | undefined,
    contextWindow: number | undefined,
    providerId: string,
    sessionModel: { provider: Provider; model: string; credentials: ResolvedCredentials },
    signal: AbortSignal,
  ): Promise<void> {
    const recorded = this.readMeta(sessionId).lastUsage as { inputTokens?: number } | undefined;
    const inputTokens = usage?.inputTokens ?? recorded?.inputTokens;
    if (!shouldCompact(inputTokens, contextWindow)) return;
    if (signal.aborted) return;

    const history = this.deps.store.messages.history(sessionId);
    if (history.length < 2) return; // nothing substantial to summarize

    try {
      const summarizer = await this.resolveTitleModel(providerId, sessionModel);
      const stream = await summarizer.provider.stream({
        model: summarizer.model,
        messages: [
          { role: "system", content: SUMMARY_SYSTEM_PROMPT },
          { role: "user", content: buildSummaryInput(history) },
        ],
        auth: {
          ...(summarizer.credentials.apiKey !== undefined ? { apiKey: summarizer.credentials.apiKey } : {}),
          ...(summarizer.credentials.baseUrl !== undefined ? { baseUrl: summarizer.credentials.baseUrl } : {}),
        },
        signal: AbortSignal.timeout(COMPACT_TIMEOUT_MS),
      });
      let text = "";
      try {
        for await (const evt of stream) {
          if (evt.type === "text_delta") text += evt.delta;
          else if (evt.type === "done") break;
        }
      } finally {
        await stream.close();
      }
      const summary = text.trim();
      if (summary.length === 0) return;

      // Persist the summary as a user-role message (valid leading context for
      // both wire formats) and point the session at it.
      const message = this.deps.store.messages.append(sessionId, "user", this.deps.clock.iso());
      const part = this.deps.store.parts.append(message.id, 0, "text", {
        text: `${SUMMARY_PREFIX}\n\n${summary}`,
        compaction: true,
      });
      this.emitDurable(sessionId, "message.created", { messageId: message.id, role: "user" });
      this.emitDurable(sessionId, "message.part.updated", {
        messageId: message.id,
        partId: part.id,
        kind: "text",
        payload: part.payload,
      });

      const existing = this.deps.store.sessions.get(sessionId);
      if (existing === undefined) return;
      const meta: Record<string, unknown> = { ...(existing.meta as Record<string, unknown>), compactionMessageId: message.id };
      delete meta.lastUsage; // re-arm the trigger
      this.deps.store.sessions.update(sessionId, { meta, now: this.deps.clock.iso() });
    } catch (err) {
      if (!signal.aborted) console.warn(`[bai] compaction skipped: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Consume one provider turn: persist text/thinking parts (streaming
   * deltas), accumulate tool-call arguments into tool_call parts, and
   * return the completed calls for execution.
   */
  private async consumeStream(
    sessionId: SessionId,
    assistantId: MessageId,
    stream: AsyncIterable<StreamEvent>,
    toolsOffered: boolean,
    signal: AbortSignal,
  ): Promise<{ calls: ParsedCall[]; stopReason?: string; usage?: { inputTokens?: number; outputTokens?: number } }> {
    let ord = 0;
    let textPartId: PartId | null = null;
    let textBuffer = "";
    let thinkingPartId: PartId | null = null;
    let thinkingBuffer = "";
    // callId → accumulating call
    const pending = new Map<string, { name: string; args: string; partId: PartId }>();
    let stopReason: string | undefined;
    let usage: { inputTokens?: number; outputTokens?: number } | undefined;

    const ensureTextPart = (): PartId => {
      if (textPartId === null) {
        const part = this.deps.store.parts.append(assistantId, ord++, "text", { text: "" });
        textPartId = part.id;
        textBuffer = "";
      }
      return textPartId;
    };
    const ensureThinkingPart = (): PartId => {
      if (thinkingPartId === null) {
        const part = this.deps.store.parts.append(assistantId, ord++, "thinking", { text: "" });
        thinkingPartId = part.id;
        thinkingBuffer = "";
        // Surfaces learn the kind before deltas arrive (mirrors user parts)
        // — otherwise they'd default the part to "text".
        this.emitDurable(sessionId, "message.part.updated", {
          messageId: assistantId,
          partId: thinkingPartId,
          kind: "thinking",
          payload: { text: "" },
        });
      }
      return thinkingPartId;
    };
    const ensureCallPart = (callId: string, name: string): PartId => {
      const hit = pending.get(callId);
      if (hit !== undefined) return hit.partId;
      const part = this.deps.store.parts.append(assistantId, ord++, "tool_call", { callId, name, args: "" });
      this.emitDurable(sessionId, "message.part.updated", {
        messageId: assistantId,
        partId: part.id,
        kind: "tool_call",
        payload: { callId, name, args: "" },
      });
      const entry = { name, args: "", partId: part.id };
      pending.set(callId, entry);
      return part.id;
    };

    for await (const evt of raceSignal(stream, signal)) {
      if (evt.type === "text_delta") {
        const partId = ensureTextPart();
        textBuffer += evt.delta;
        this.deps.store.parts.updatePayload(partId, { text: textBuffer });
        this.emitDurable(sessionId, "message.part.delta", { messageId: assistantId, partId, delta: evt.delta });
      } else if (evt.type === "thinking_delta") {
        const partId = ensureThinkingPart();
        thinkingBuffer += evt.delta;
        this.deps.store.parts.updatePayload(partId, { text: thinkingBuffer });
        this.emitDurable(sessionId, "message.part.delta", { messageId: assistantId, partId, delta: evt.delta });
      } else if (evt.type === "tool_call_delta") {
        // OpenAI-compat providers may stream id/name only on the first chunk.
        const callId = evt.id.length > 0 ? evt.id : `openai_idx_${pending.size}`;
        const partId = ensureCallPart(callId, evt.name.length > 0 ? evt.name : pending.get(callId)?.name ?? "unknown");
        const entry = pending.get(callId) as { name: string; args: string; partId: PartId };
        if (evt.name.length > 0 && entry.name === "unknown") entry.name = evt.name;
        if (evt.argsDelta.length > 0) {
          entry.args += evt.argsDelta;
          this.deps.store.parts.updatePayload(partId, { callId, name: entry.name, args: entry.args });
          this.emitDurable(sessionId, "message.part.delta", { messageId: assistantId, partId, delta: evt.argsDelta });
        }
      } else if (evt.type === "usage") {
        usage = {
          inputTokens: evt.inputTokens ?? usage?.inputTokens,
          outputTokens: evt.outputTokens ?? usage?.outputTokens,
        };
      } else if (evt.type === "done") {
        stopReason = evt.stopReason;
        break;
      }
    }
    void toolsOffered;

    const calls: ParsedCall[] = [...pending.entries()].map(([callId, entry]) => ({
      callId,
      name: entry.name,
      args: entry.args,
      partId: entry.partId,
    }));
    return { calls, stopReason, usage };
  }

  /**
   * Execute completed tool calls: gate every call in order (parse →
   * unknown-tool → subagent strip → central permission check), run the
   * tools, then persist results in original call order. A batch made
   * entirely of `task` calls runs concurrently (independent child sessions
   * by contract); every other composition stays sequential. Throws become
   * error results (errors-as-results convention: only infra failures kill
   * the turn).
   */
  private async executeCalls(
    sessionId: SessionId,
    assistantId: MessageId,
    calls: ParsedCall[],
    signal: AbortSignal,
  ): Promise<Array<"executed" | "denied">> {
    const session = this.deps.store.sessions.get(sessionId);
    const ctx: ToolContext = {
      sessionId,
      ...(session?.cwd !== undefined ? { cwd: session.cwd } : {}),
      signal,
      emitLive: (type: EventType, payload: unknown) => this.emitLive(type, payload),
      ask: async (tool, metadata) =>
        this.deps.permissions.authorize({ tool, sessionId, metadata, signal, ...(session?.cwd !== undefined ? { cwd: session.cwd } : {}) }),
      // plan.exit's mid-run switch: flip session.meta.agent + broadcast; the
      // drain loop re-resolves the run context after this batch.
      switchAgent: async (name) => {
        const target = this.deps.agents.get(name);
        if (target === undefined) return false;
        const current = this.deps.store.sessions.get(sessionId);
        if (current === undefined) return false;
        const meta = { ...(current.meta as Record<string, unknown>), agent: name };
        const updated = this.deps.store.sessions.update(sessionId, { meta, now: this.deps.clock.iso() });
        if (updated !== undefined) this.emitDurable(sessionId, "session.updated", { session: updated });
        return true;
      },
    };

    // --- stage 1: gate every call, in order ---
    const isSubagent = typeof session?.meta.parent === "string" && (session.meta.parent as string).length > 0;
    const gated: GatedCall[] = [];
    for (const call of calls) {
      // Parse the streamed JSON args; malformed → error result for the model.
      let args: unknown;
      try {
        args = call.args.trim().length === 0 ? {} : JSON.parse(call.args);
      } catch {
        gated.push({
          call,
          error: `Invalid arguments: the JSON was malformed (${call.args.slice(0, 200)}). Rewrite the arguments as valid JSON.`,
        });
        continue;
      }

      // Unknown tools never reach the permission gate (an unmatched tool
      // would default to "ask" and stall the run waiting on a human).
      if (!this.deps.tools.has(call.name)) {
        gated.push({
          call,
          error: `Unknown tool: ${call.name}. Available tools: ${this.deps.tools.names().join(", ") || "(none)"}.`,
        });
        continue;
      }

      // Subagent backstop: interaction/recursion tools are never offered to
      // child sessions (toolDefsFor), and a hallucinated call errors here
      // instead of stalling the run on an ask nobody should answer.
      if (isSubagent && SUBAGENT_STRIPPED.has(call.name)) {
        gated.push({
          call,
          error: `Tool ${call.name} is not available to subagents. Continue autonomously and respond with a final message.`,
        });
        continue;
      }

      // Central fail-closed check (config deny works even for tools that
      // never call ctx.ask). Read-only tools default to allow. Write/edit
      // asks carry a computed diff so surfaces can preview the change; a
      // rejection may carry the user's feedback, which becomes the reason
      // the model sees (opencode's CorrectedError pattern).
      const detail = askDetailFor(call.name, args, session?.cwd);
      const verdict = await this.deps.permissions.authorize({
        tool: call.name,
        sessionId,
        metadata: args as Record<string, unknown>,
        ...(detail !== undefined ? { detail } : {}),
        // An interrupted run must not park on an unanswered ask (the task
        // tool's child sessions made this reachable mid-drain).
        signal,
        // cwd-relative defaults: fs tools inside the session's working
        // directory are allowed without an ask (config/approvals still win).
        ...(session?.cwd !== undefined ? { cwd: session.cwd } : {}),
      });
      if (!verdict.allowed) {
        const feedback = verdict.feedback !== undefined ? ` User feedback: "${verdict.feedback}".` : "";
        gated.push({
          call,
          error: `Permission denied for tool: ${call.name}.${feedback} Ask the user to allow it, or use a different approach.`,
          denied: true,
          ...(verdict.ask !== undefined ? { ask: verdict.ask } : {}),
        });
        continue;
      }
      gated.push({
        call,
        args,
        ...(verdict.ask !== undefined ? { ask: verdict.ask } : {}),
      });
    }

    // --- stage 2: execute the ready calls ---
    const readyIdx = gated.flatMap((entry, i) => (entry.error === undefined ? [i] : []));

    // Shadow-repo snapshot before any mutating call runs: the tree hash plus
    // the files the batch goes on to change become a `patch` part on this
    // assistant message — revert's rollback input (opencode's per-message
    // patch parts). Best-effort: snapshot failures never break the run.
    const snapshotCwd = session?.cwd;
    let patchHash: string | undefined;
    const snapshot = this.deps.snapshot;
    if (
      snapshot !== undefined &&
      snapshotCwd !== undefined &&
      readyIdx.length > 0 &&
      readyIdx.some((i) => SNAPSHOT_TOOLS.has(gated[i]?.call.name ?? ""))
    ) {
      patchHash = await snapshot.track(snapshotCwd).catch(() => undefined);
    }

    const parallel = readyIdx.length > 1 && readyIdx.every((i) => gated[i]?.call.name === "task");
    const executed: Array<
      { content: string; isError: boolean; title?: string; subagent?: { sessionId: string; agent: string }; questions?: QuestionReview[] } | undefined
    > = new Array(gated.length).fill(undefined);
    const runOne = async (i: number): Promise<void> => {
      const entry = gated[i];
      if (entry === undefined || entry.args === undefined) return;
      try {
        const result = await this.deps.tools.execute(entry.call.name, entry.args, ctx);
        executed[i] = {
          content: result.content,
          isError: false,
          ...(typeof result.meta?.title === "string" ? { title: result.meta.title as string } : {}),
          ...readSubagentMeta(result.meta?.subagent),
          ...readQuestionsMeta(result.meta?.questions),
        };
      } catch (err) {
        executed[i] = { content: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    };
    if (parallel) await Promise.all(readyIdx.map((i) => runOne(i)));
    else for (const i of readyIdx) await runOne(i);

    // --- stage 3: persist in original call order (deterministic ords) ---
    const outcomes: Array<"executed" | "denied"> = [];
    for (let i = 0; i < gated.length; i++) {
      const entry = gated[i];
      if (entry === undefined) continue;
      const outcome = executed[i];
      if (entry.error !== undefined || outcome === undefined) {
        // Gate-stage errors are error results like any other (isError true);
        // `denied` only drives the outcomes array (all-denied ends the run).
        this.persistToolResult(
          sessionId,
          assistantId,
          entry.call,
          entry.error ?? "Tool execution failed.",
          true,
          undefined,
          undefined,
          entry.ask,
        );
        outcomes.push(entry.denied === true ? "denied" : "executed");
      } else {
        this.persistToolResult(
          sessionId,
          assistantId,
          entry.call,
          outcome.content,
          outcome.isError,
          outcome.title,
          outcome.subagent,
          entry.ask,
          outcome.questions,
        );
        outcomes.push("executed");
      }
    }

    // Record what this batch changed (revert rolls each file back to its
    // pre-change tree). No changes or a failed probe → no patch part.
    if (patchHash !== undefined && snapshotCwd !== undefined && snapshot !== undefined) {
      const files = await snapshot.patch(snapshotCwd, patchHash).catch(() => undefined);
      if (files !== undefined && files.length > 0) {
        const part = this.deps.store.parts.append(assistantId, this.deps.store.parts.nextOrd(assistantId), "patch", {
          hash: patchHash,
          files,
        });
        this.emitDurable(sessionId, "message.part.updated", {
          messageId: assistantId,
          partId: part.id,
          kind: "patch",
          payload: part.payload,
        });
      }
    }
    return outcomes;
  }

  /** Persist + broadcast one tool_result part (payload contract: domain.ts). */
  private persistToolResult(
    sessionId: SessionId,
    assistantId: MessageId,
    call: ParsedCall,
    content: string,
    isError: boolean,
    title?: string,
    subagent?: { sessionId: string; agent: string },
    permission?: AskOutcome,
    questions?: QuestionReview[],
  ): void {
    // Final args snapshot lands in the tool_call part (deltas may have raced).
    const callPart = this.deps.store.parts.get(call.partId);
    if (callPart !== undefined && isToolCallPayload(callPart.payload)) {
      this.deps.store.parts.updatePayload(call.partId, { ...callPart.payload, args: call.args, name: call.name });
    }
    const part = this.deps.store.parts.append(assistantId, this.deps.store.parts.nextOrd(assistantId), "tool_result", {
      callId: call.callId,
      content,
      ...(isError ? { isError: true } : {}),
      ...(title !== undefined ? { title } : {}),
      ...(subagent !== undefined ? { subagent } : {}),
      ...(permission !== undefined ? { permission } : {}),
      ...(questions !== undefined ? { questions } : {}),
    });
    this.emitDurable(sessionId, "message.part.updated", {
      messageId: assistantId,
      partId: part.id,
      kind: "tool_result",
      payload: part.payload,
    });
  }

  /**
   * Title-call model: config models.title → a small non-reasoning model of
   * the session's provider (opencode's getSmallModel) → the session's own
   * model. Resolution failures fall back to the session's model — the title
   * call is best-effort and must never break the drain.
   */
  private async resolveTitleModel(
    sessionProviderId: string,
    session: { provider: Provider; model: string; credentials: ResolvedCredentials },
  ): Promise<{ provider: Provider; model: string; credentials: ResolvedCredentials }> {
    const configured = this.deps.titleModel();
    const modelId =
      configured ?? (await this.deps.providers.smallModelFor(sessionProviderId).catch(() => undefined));
    if (modelId === undefined) return session;
    try {
      const resolved = await this.deps.providers.resolveModel(modelId);
      const account = await this.deps.providers.defaultAccount(resolved.providerId);
      return {
        provider: resolved.provider,
        model: resolved.model,
        credentials: await this.deps.providers.resolveCredentials(resolved.providerId, account),
      };
    } catch {
      return session;
    }
  }

  /**
   * Detached title refine: a mini LLM call that
   * replaces the creation-time default title with a generated one. Never
   * awaited — the drain's timing (run.finished, one-shot exit) is untouched —
   * and never rejects. The generated title applies only while the session's
   * title still equals the default it started with: a concurrent rename wins.
   */
  private refineSessionTitle(input: {
    sessionId: SessionId;
    provider: Provider;
    model: string;
    credentials: ResolvedCredentials;
    defaultTitle: string;
    prompt: string;
  }): void {
    void (async () => {
      const stream = await input.provider.stream({
        model: input.model,
        messages: [
          { role: "system", content: TITLE_SYSTEM_PROMPT },
          {
            role: "user",
            // The word-count target rides the user message too — models
            // weight it heavily, and it's the fix for one-word titles on
            // long prompts.
            content: `Generate a 5-10 word title for this conversation:\n${input.prompt.slice(0, TITLE_PROMPT_CHARS)}`,
          },
        ],
        auth: {
          ...(input.credentials.apiKey !== undefined ? { apiKey: input.credentials.apiKey } : {}),
          ...(input.credentials.baseUrl !== undefined ? { baseUrl: input.credentials.baseUrl } : {}),
        },
        // No token cap: a reasoning fallback model may spend tokens thinking
        // first, and a title call stops naturally after a line anyway.
        // Thinking is deliberately not enabled (Anthropic requires
        // max_tokens > budget_tokens).
        signal: AbortSignal.timeout(TITLE_TIMEOUT_MS),
      });
      try {
        let text = "";
        for await (const evt of stream) {
          if (evt.type === "text_delta") text += evt.delta;
          else if (evt.type === "done") break;
        }
        const title = sanitizeGeneratedTitle(text);
        if (title.length === 0) return;
        const current = this.deps.store.sessions.get(input.sessionId);
        if (current === undefined || current.title !== input.defaultTitle) return;
        const updated = this.deps.store.sessions.update(input.sessionId, {
          title,
          now: this.deps.clock.iso(),
        });
        if (updated !== undefined) {
          this.emitDurable(input.sessionId, "session.updated", { session: updated });
        }
      } finally {
        await stream.close();
      }
    })().catch(() => {
      // Best-effort: any failure (provider error, timeout, abort) leaves the
      // default title in place.
    });
  }

  private emitDurable(sessionId: SessionId, type: EventType, payload: unknown): void {
    const evt = this.deps.log.append(sessionId, type, payload, this.deps.clock.iso());
    this.deps.bus.publish(evt);
  }

  private emitLive(type: EventType, payload: unknown): void {
    this.deps.bus.publish({
      seq: 0,
      type,
      ts: this.deps.clock.iso(),
      payload,
    } as never);
  }
}

/**
 * Validate a tool result's `subagent` metadata (the task tool's child-session
 * link) — malformed shapes are dropped rather than trusted.
 */
function readSubagentMeta(value: unknown): { subagent?: { sessionId: string; agent: string } } {
  if (value === null || typeof value !== "object") return {};
  const candidate = value as { sessionId?: unknown; agent?: unknown };
  if (typeof candidate.sessionId !== "string" || candidate.sessionId.length === 0) return {};
  if (typeof candidate.agent !== "string" || candidate.agent.length === 0) return {};
  return { subagent: { sessionId: candidate.sessionId, agent: candidate.agent } };
}

/** Structured Q&A retention (question tool): validated row-per-question. */
function readQuestionsMeta(value: unknown): { questions?: QuestionReview[] } {
  if (!Array.isArray(value)) return {};
  const rows: QuestionReview[] = [];
  for (const item of value) {
    if (item === null || typeof item !== "object") continue;
    const candidate = item as { header?: unknown; question?: unknown; answers?: unknown };
    if (typeof candidate.question !== "string" || candidate.question.length === 0) continue;
    rows.push({
      ...(typeof candidate.header === "string" && candidate.header.length > 0 ? { header: candidate.header } : {}),
      question: candidate.question,
      answers: Array.isArray(candidate.answers)
        ? candidate.answers.filter((a): a is string => typeof a === "string")
        : [],
    });
  }
  return rows.length > 0 ? { questions: rows } : {};
}

/**
 * Stop consuming the moment the run is interrupted — regardless of whether
 * the provider's HTTP layer honors the signal. Bun's fetch (as of 1.3) does
 * not cancel a streaming body after the headers arrive, so waiting for the
 * next chunk would hold the drain hostage until the provider finishes; the
 * race makes the stop instant. The abandoned `next()` settles later and its
 * value is dropped; `stream.close()` in the caller's finally releases what
 * the runtime can release (and cancels upstream on runtimes that support it).
 */
async function* raceSignal<T>(stream: AsyncIterable<T>, signal: AbortSignal): AsyncGenerator<T> {
  const iterator = stream[Symbol.asyncIterator]();
  const aborted = new Promise<"abort">((resolve) => {
    if (signal.aborted) {
      resolve("abort");
      return;
    }
    signal.addEventListener("abort", () => resolve("abort"), { once: true });
  });
  while (true) {
    const result = await Promise.race([iterator.next(), aborted]);
    if (result === "abort" || result.done) return;
    yield result.value;
  }
}

export type { PromptPayload };
