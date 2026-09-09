import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_BUILD_AGENT, BUILTIN_CHAT_AGENT, BUILTIN_PLAN_AGENT, type SessionId, type ModelInfo } from "@bai/shared";
import { makeCore, sleep, waitForEvent, type TestCore } from "./harness";
import type { LlmRequest, Provider, ProviderStream, StreamEvent } from "../src/provider/types";
import type { ToolContext } from "../src/tools/registry";

/**
 * A provider that replays a per-turn script (same pattern as
 * run-tools.test.ts — title calls answered inline without consuming script
 * indices). Script functions may be async (barrier tests use this).
 * Requests from parent and child drains share one provider, so script
 * functions dispatch on message content (task-prompt markers).
 */
class ScriptedToolProvider implements Provider {
  readonly requests: LlmRequest[] = [];

  constructor(private readonly script: Array<StreamEvent[] | ((req: LlmRequest) => StreamEvent[] | Promise<StreamEvent[]>)>) {}

  name(): string {
    return "scripted";
  }

  async models(): Promise<ModelInfo[]> {
    return [{ id: "scripted/main", provider: "scripted", label: "Scripted", supportsTools: true }];
  }

  async stream(req: LlmRequest): Promise<ProviderStream> {
    const first = req.messages[0];
    const isTitleCall = first?.role === "system" && (first as { content: string }).content.startsWith("You are a title generator");
    if (isTitleCall) {
      return this.streamOf([{ type: "text_delta", delta: "Title" }, { type: "done", stopReason: "end_turn" }]);
    }
    const index = this.requests.length;
    this.requests.push(req);
    const entry = this.script[index];
    const events =
      typeof entry === "function" ? await entry(req) : (entry ?? [{ type: "done", stopReason: "end_turn" } as StreamEvent]);
    return this.streamOf(events);
  }

  private streamOf(events: StreamEvent[]): ProviderStream {
    async function* generate(): AsyncGenerator<StreamEvent> {
      for (const evt of events) yield evt;
    }
    const iterator = generate();
    return { [Symbol.asyncIterator]: () => iterator, close: async () => {} };
  }
}

const toolCall = (callId: string, name: string, args: string): StreamEvent[] => [
  { type: "tool_call_delta", id: callId, name, argsDelta: args },
  { type: "done", stopReason: "tool_use" },
];

const finalText = (delta: string): StreamEvent[] => [{ type: "text_delta", delta }, { type: "done", stopReason: "end_turn" }];

const taskArgs = (description: string, prompt: string, subagentType: string): Record<string, string> => ({
  description,
  prompt,
  subagent_type: subagentType,
});

/** A minimal ToolContext for direct task-tool execution (no provider loop). */
function directCtx(sessionId: SessionId): ToolContext {
  return { sessionId, signal: new AbortController().signal, emitLive: () => {} };
}

/** The session's first tool_result payload (one assistant tool batch). */
function lastToolResult(
  core: TestCore["core"],
  sessionId: SessionId,
): { content: string; isError?: boolean; title?: string; subagent?: { sessionId: string; agent: string } } {
  const assistant = core.history(sessionId).find((m) => m.role === "assistant");
  return (assistant?.parts.find((p) => p.kind === "tool_result")?.payload ?? {}) as {
    content: string;
    isError?: boolean;
    title?: string;
    subagent?: { sessionId: string; agent: string };
  };
}

/** Poll until the condition holds (fs.watch hot-reload is debounced/async). */
async function waitForCondition(fn: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await sleep(20);
  }
  throw new Error(`condition not met in time: ${what}`);
}

/**
 * Wait for the PARENT session's run.finished — child drains emit their own
 * run.finished events, and resubscribing per attempt can miss the parent's
 * event in the gap, so this holds one subscription until it matches.
 */
async function waitForRunFinished(bus: TestCore["bus"], sessionId: SessionId): Promise<void> {
  const sub = bus.subscribe();
  const deadline = Date.now() + 5000;
  try {
    while (Date.now() < deadline) {
      for (const evt of sub.take()) {
        if (evt.type === "run.finished" && evt.sessionId === sessionId) return;
      }
      await sleep(5);
    }
    throw new Error(`timeout waiting for run.finished of ${sessionId}`);
  } finally {
    bus.unsubscribe(sub.id);
  }
}

/** Two tool calls streamed in one turn. */
const twoCalls = (a: { id: string; name: string; args: string }, b: { id: string; name: string; args: string }): StreamEvent[] => [
  { type: "tool_call_delta", id: a.id, name: a.name, argsDelta: a.args },
  { type: "tool_call_delta", id: b.id, name: b.name, argsDelta: b.args },
  { type: "done", stopReason: "tool_use" },
];

describe("task tool (subagent spawning)", () => {
  let t: TestCore;
  let dir: string;

  beforeEach(() => {
    t = makeCore();
    dir = mkdtempSync(join(tmpdir(), "bai-task-"));
    // Mechanics tests allow spawns globally; dedicated tests below exercise
    // the interactive ask and the deny path.
    t.config.permissions = { task: "allow" };
  });

  afterEach(() => {
    t.store.close();
    rmSync(t.dir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  test("happy path: task call spawns a child session, awaits it, returns its final text", async () => {
    t.config.models.default = "scripted/main";
    writeFileSync(join(dir, "note.txt"), "the secret is bai");
    t.agents.put("researcher", { description: "read-only researcher", prompt: "You research read-only.", tools: ["fs.read"] });

    const CHILD_MARKER = "SUBAGENT-TASK: read note.txt and report its contents";
    const provider = new ScriptedToolProvider([
      toolCall("t1", "task", JSON.stringify(taskArgs("Read the note", CHILD_MARKER, "researcher"))),
      (req) =>
        JSON.stringify(req.messages).includes("SUBAGENT-TASK")
          ? finalText("child report: the secret is bai")
          : finalText("unexpected"),
      finalText("parent summary: the note says the secret is bai"),
    ]);
    t.providers.register(provider);
    const parent = t.core.createSession({ workbench: "code", cwd: dir });
    await t.core.setSessionAgent(parent.id, { agent: "build" });

    const finished = waitForRunFinished(t.bus, parent.id);
    t.core.submitPrompt(parent.id, { text: "delegate reading the note" });
    await finished;

    // Child session: linked, titled, workbench+cwd inherited, real history.
    const child = t.core.listSessions().find((s) => s.meta.parent === parent.id);
    expect(child).toBeDefined();
    expect(child?.title).toBe("Read the note (@researcher subagent)");
    expect(child?.workbench).toBe("code");
    expect(child?.cwd).toBe(dir);
    expect(child?.meta.agent).toBe("researcher");
    const childHistory = t.core.history(child?.id as SessionId);
    const childUser = childHistory.find((m) => m.role === "user");
    expect((childUser?.parts[0]?.payload as { text?: string }).text).toBe(CHILD_MARKER);
    const childAssistant = childHistory.find((m) => m.role === "assistant");
    expect((childAssistant?.parts.find((p) => p.kind === "text")?.payload as { text?: string }).text).toBe(
      "child report: the secret is bai",
    );

    // Parent tool_result: opencode-style XML wrapping the child's answer.
    const result = lastToolResult(t.core, parent.id);
    expect(result.content).toContain(`<task id="${child?.id}" state="completed">`);
    expect(result.content).toContain("<task_result>");
    expect(result.content).toContain("child report: the secret is bai");
    expect(result.isError).toBeUndefined();
    expect(result.title).toBe("Read the note (@researcher subagent)");
    // The payload links to the child session (surface "open subagent" affordance).
    expect(result.subagent).toEqual({ sessionId: child?.id as string, agent: "researcher" });
  });

  test("subagent sessions cannot spawn at all (execution backstop; strip beats depth)", async () => {
    t.config.models.default = "scripted/main";
    const provider = new ScriptedToolProvider([toolCall("t1", "task", JSON.stringify(taskArgs("Nested", "nested attempt", "build")))]);
    t.providers.register(provider);
    const root = t.core.createSession({ workbench: "code" });
    const child = t.core.createSession({ parent: root.id, agent: "build" });

    const finished = waitForRunFinished(t.bus, child.id);
    t.core.submitPrompt(child.id, { text: "try to nest" });
    await finished;

    // The gate-side strip fires before the tool's own depth check — a
    // subagent session can never spawn, regardless of the configured cap.
    const result = lastToolResult(t.core, child.id);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Tool task is not available to subagents");
    expect(t.core.listSessions().filter((s) => s.meta.parent === child.id)).toHaveLength(0);
  });

  test("agents.subagentDepth = 0 disables spawning entirely", async () => {
    t.config.models.default = "scripted/main";
    t.config.agents.subagentDepth = 0;
    const provider = new ScriptedToolProvider([toolCall("t1", "task", JSON.stringify(taskArgs("Any", "prompt", "build")))]);
    t.providers.register(provider);
    const session = t.core.createSession({ workbench: "code" });
    await t.core.setSessionAgent(session.id, { agent: "build" });

    const finished = waitForRunFinished(t.bus, session.id);
    t.core.submitPrompt(session.id, { text: "try to spawn" });
    await finished;

    const result = lastToolResult(t.core, session.id);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Subagent depth limit reached (0)");
  });

  test("unknown subagent_type errors and lists the available agents", async () => {
    t.config.models.default = "scripted/main";
    const provider = new ScriptedToolProvider([toolCall("t1", "task", JSON.stringify(taskArgs("Ghost", "prompt", "ghost")))]);
    t.providers.register(provider);
    const session = t.core.createSession({ workbench: "code" });
    await t.core.setSessionAgent(session.id, { agent: "build" });

    const finished = waitForRunFinished(t.bus, session.id);
    t.core.submitPrompt(session.id, { text: "spawn a ghost" });
    await finished;

    const result = lastToolResult(t.core, session.id);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Unknown agent type: ghost");
    expect(result.content).toContain("Available agents: build, chat, plan");
  });

  test("config deny for task produces a denied result and ends the run", async () => {
    t.config.models.default = "scripted/main";
    t.config.permissions = { task: "deny" };
    const provider = new ScriptedToolProvider([toolCall("t1", "task", JSON.stringify(taskArgs("Denied", "prompt", "build")))]);
    t.providers.register(provider);
    const session = t.core.createSession({ workbench: "code" });
    await t.core.setSessionAgent(session.id, { agent: "build" });

    const finished = waitForRunFinished(t.bus, session.id);
    t.core.submitPrompt(session.id, { text: "spawn" });
    await finished;

    const result = lastToolResult(t.core, session.id);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Permission denied for tool: task");
    expect(provider.requests).toHaveLength(1); // run ended fail-closed
  });

  test("child sessions with a '*' allow-list are not offered interaction/recursion tools", async () => {
    t.config.models.default = "scripted/main";
    t.agents.put("star", { description: "everything agent", prompt: "STAR PERSONA", tools: ["*"] });
    const provider = new ScriptedToolProvider([
      toolCall("t1", "task", JSON.stringify(taskArgs("Star child", "STAR CHILD TASK", "star"))),
      (req) => (JSON.stringify(req.messages).includes("STAR CHILD TASK") ? finalText("star done") : finalText("unexpected")),
      finalText("parent done"),
    ]);
    t.providers.register(provider);
    const parent = t.core.createSession({ workbench: "code" });
    await t.core.setSessionAgent(parent.id, { agent: "build" });

    const finished = waitForRunFinished(t.bus, parent.id);
    t.core.submitPrompt(parent.id, { text: "spawn the star" });
    await finished;

    // The child's offered tool defs exclude the stripped set.
    const childRequest = provider.requests[1] as LlmRequest & { tools?: Array<{ name: string }> };
    const names = childRequest.tools?.map((d) => d.name) ?? [];
    expect(names).toContain("fs.read");
    expect(names).not.toContain("task");
    expect(names).not.toContain("question");
    expect(names).not.toContain("plan.exit");
    // The meta-tools are orchestrator-only — never offered to subagents.
    expect(names).not.toContain("agent.view");
    expect(names).not.toContain("agent.save");
    expect(names).not.toContain("tool.create");
    expect(names).not.toContain("workspace.create");
  });

  test("child sessions cannot execute stripped tools even when hallucinated", async () => {
    t.config.models.default = "scripted/main";
    t.agents.put("star", { description: "everything agent", prompt: "STAR PERSONA", tools: ["*"] });
    // Both child request slots dispatch on the task marker (which child
    // requests first is nondeterministic under parallel execution).
    const childSlot = (req: LlmRequest): StreamEvent[] => {
      const text = JSON.stringify(req.messages);
      if (!text.includes("STAR CHILD TASK")) return finalText("unexpected");
      const answered = text.includes("not available to subagents");
      return answered ? finalText("recovered autonomously") : toolCall("q1", "question", '{"questions":[]}');
    };
    const provider = new ScriptedToolProvider([
      toolCall("t1", "task", JSON.stringify(taskArgs("Star child", "STAR CHILD TASK", "star"))),
      childSlot,
      childSlot,
      finalText("parent done"),
    ]);
    t.providers.register(provider);
    const parent = t.core.createSession({ workbench: "code" });
    await t.core.setSessionAgent(parent.id, { agent: "build" });

    const finished = waitForRunFinished(t.bus, parent.id);
    t.core.submitPrompt(parent.id, { text: "spawn the star" });
    await finished;

    const child = t.core.listSessions().find((s) => s.meta.parent === parent.id);
    const childResult = lastToolResult(t.core, child?.id as SessionId);
    expect(childResult.isError).toBe(true);
    expect(childResult.content).toContain("Tool question is not available to subagents");
    // The child recovered and produced its final message anyway.
    expect(lastToolResult(t.core, parent.id).content).toContain("recovered autonomously");
  });

  test("subagent model override wins over the parent's model", async () => {
    t.config.models.default = "scripted/main";
    t.agents.put("echoagent", { description: "echo persona", prompt: "ECHO PERSONA", tools: [], model: "stub/echo" });
    const parent = t.core.createSession({ workbench: "code" });
    await t.core.setSessionModel(parent.id, { model: "scripted/main" });

    const task = t.tools.get("task");
    expect(task).toBeDefined();
    const result = await task?.execute(taskArgs("Echo child", "THE ECHO TASK", "echoagent"), directCtx(parent.id));

    const child = t.core.listSessions().find((s) => s.meta.parent === parent.id);
    expect(child?.meta.model).toBeUndefined(); // no copy — the agent's model rules
    expect(result?.content).toContain("Echo: THE ECHO TASK");
  });

  test("parent's explicit model is copied down when the subagent defines none", async () => {
    t.config.models.default = "scripted/main";
    t.agents.put("plain", { description: "plain persona", prompt: "PLAIN PERSONA", tools: [] });
    const parent = t.core.createSession({ workbench: "code" });
    await t.core.setSessionModel(parent.id, { model: "stub/echo" });

    const task = t.tools.get("task");
    const result = await task?.execute(taskArgs("Plain child", "THE PLAIN TASK", "plain"), directCtx(parent.id));

    const child = t.core.listSessions().find((s) => s.meta.parent === parent.id);
    expect(child?.meta.model).toBe("stub/echo");
    expect(result?.content).toContain("Echo: THE PLAIN TASK");
  });

  test("built-in allow-lists: build may spawn; chat/plan may not", () => {
    expect(BUILTIN_BUILD_AGENT.tools).toContain("task");
    expect(BUILTIN_CHAT_AGENT.tools).not.toContain("task");
    expect(BUILTIN_PLAN_AGENT.tools).not.toContain("task");
  });

  test("task tool description embeds the agent catalog and refreshes on hot-reload", () => {
    const before = t.tools.get("task");
    expect(before).toBeDefined();
    expect(before?.description).toContain("Available agent types");
    expect(before?.description).toContain("- build:");

    // put/remove broadcast agents.updated synchronously (registry fires
    // onChange when its scan detects a change) → the Service re-registers
    // the tool with a fresh catalog.
    t.agents.put("scout", { description: "fast scout", prompt: "SCOUT PERSONA", tools: ["fs.read"] });
    expect(t.tools.get("task")?.description).toContain("- scout: fast scout");

    t.agents.remove("scout");
    expect(t.tools.get("task")?.description).not.toContain("scout");
  });

  test("task spawn asks carry a human-readable summary (fail-closed default)", async () => {
    t.config.models.default = "scripted/main";
    t.config.permissions = {}; // task unmatched → ask
    const provider = new ScriptedToolProvider([
      toolCall("t1", "task", JSON.stringify(taskArgs("Summarize repo", "SUMMARY TASK", "build"))),
      finalText("parent done"),
    ]);
    t.providers.register(provider);
    const session = t.core.createSession({ workbench: "code" });
    await t.core.setSessionAgent(session.id, { agent: "build" });

    const askReader = (async () => {
      const evt = await waitForEvent(t.bus, "permission.asked", { timeoutMs: 3000 });
      expect(evt.payload.request.detail?.summary).toBe('spawn subagent "Summarize repo" (agent: build)');
      await t.core.replyPermission(evt.payload.request.id, "approved", "once");
    })();
    const finished = waitForRunFinished(t.bus, session.id);
    t.core.submitPrompt(session.id, { text: "spawn with ask" });
    await finished;
    await askReader;

    // The spawn proceeded after approval (child session exists).
    expect(t.core.listSessions().some((s) => s.meta.parent === session.id)).toBe(true);
  });

  test("interrupt unblocks a subagent parked on a permission ask (the esc/ctrl+c stall)", async () => {
    t.config.models.default = "scripted/main";
    t.agents.put("runner", { description: "runs bash", prompt: "RUNNER PERSONA", tools: ["bash"] });
    const provider = new ScriptedToolProvider([
      toolCall("t1", "task", JSON.stringify(taskArgs("Run a command", "CHILD-RUNS-BASH", "runner"))),
      // The child's bash call parks on its ask — nobody replies. The
      // interrupt below must unblock BOTH drains (the reported stall: the
      // gate used to await its resolver forever, so drainNow never resolved
      // and the parent run never finished).
      (req) => (JSON.stringify(req.messages).includes("CHILD-RUNS-BASH") ? toolCall("b1", "bash", JSON.stringify({ command: "sleep 5" })) : finalText("unexpected")),
    ]);
    t.providers.register(provider);
    const parent = t.core.createSession({ workbench: "code" });
    await t.core.setSessionAgent(parent.id, { agent: "build" });

    const finished = waitForAllRunFinished(t.bus, parent.id, 2);
    // Subscribe before the spawn: the child's bash ask may publish before
    // waitForChildSession's poll resumes.
    const childAsk = waitForEvent(t.bus, "permission.asked", { timeoutMs: 3000 });
    t.core.submitPrompt(parent.id, { text: "spawn" });
    const child = await waitForChildSession(parent.id);
    await childAsk; // the child's bash ask is pending
    t.core.interrupt(parent.id);
    await finished; // resolves only when BOTH parent and child runs finished

    expect(t.store.permissions.pendingBySession(parent.id)).toHaveLength(0);
    expect(t.store.permissions.pendingBySession(child.id)).toHaveLength(0);
    const childResult = lastToolResult(t.core, child.id);
    expect(childResult.isError).toBe(true);
    expect(childResult.content).toContain("Permission denied for tool: bash");
    // The task tool returned (partial — no final answer) instead of hanging.
    expect(lastToolResult(t.core, parent.id).content).toContain("produced no final answer");
  });

  test("interrupt during the parent's own pending spawn ask ends the run (no stall)", async () => {
    t.config.models.default = "scripted/main";
    t.config.permissions = {}; // task unmatched → ask; nobody replies
    const provider = new ScriptedToolProvider([toolCall("t1", "task", JSON.stringify(taskArgs("Any", "p", "build")))]);
    t.providers.register(provider);
    const session = t.core.createSession({ workbench: "code" });
    await t.core.setSessionAgent(session.id, { agent: "build" });

    const finished = waitForRunFinished(t.bus, session.id);
    const spawnAsk = waitForEvent(t.bus, "permission.asked", { timeoutMs: 3000 });
    t.core.submitPrompt(session.id, { text: "spawn" });
    await spawnAsk;
    t.core.interrupt(session.id);
    await finished;

    expect(t.store.permissions.pendingBySession(session.id)).toHaveLength(0);
    const result = lastToolResult(t.core, session.id);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Permission denied for tool: task");
    expect(t.core.listSessions().some((s) => s.meta.parent === session.id)).toBe(false);
  });

  // --- helpers -------------------------------------------------------------

  /** The child session spawned by the active session's task call. */
  async function waitForChildSession(parentId: SessionId): Promise<{ id: SessionId }> {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const child = t.core.listSessions().find((s) => s.meta.parent === parentId);
      if (child !== undefined) return child;
      await sleep(10);
    }
    throw new Error("timeout waiting for the child session");
  }

  /**
   * Resolves once `count` distinct sessions (including `parentId`) have
   * emitted run.finished — child session ids aren't known up front.
   */
  function waitForAllRunFinished(bus: TestCore["bus"], parentId: SessionId, count: number): Promise<void> {
    const sub = bus.subscribe();
    const deadline = Date.now() + 5000;
    const seen = new Set<string>();
    const promise = (async () => {
      try {
        while (Date.now() < deadline) {
          for (const evt of sub.take()) {
            if (evt.type === "run.finished" && typeof evt.sessionId === "string") seen.add(evt.sessionId);
          }
          if (seen.has(parentId) && seen.size >= count) return;
          await sleep(5);
        }
        throw new Error(`timeout waiting for ${count} run.finished (got ${[...seen].join(", ")})`);
      } finally {
        bus.unsubscribe(sub.id);
      }
    })();
    return promise;
  }

  test("a batch of task calls runs concurrently and persists results in call order", async () => {
    t.config.models.default = "scripted/main";
    t.agents.put("probe", { description: "probe persona", prompt: "PROBE PERSONA", tools: [] });

    // Each child's stream waits until the OTHER child has started: if
    // execution were sequential, the first child would stall for the full
    // barrier window. Overlap proves concurrency. (The sibling's flag is
    // read inside the wait loop — a snapshot taken at call time would be
    // stale by definition.)
    const state = { aStarted: false, bStarted: false };
    const barrier = (mine: "a" | "b"): Promise<StreamEvent[]> => {
      if (mine === "a") state.aStarted = true;
      else state.bStarted = true;
      return (async () => {
        const deadline = Date.now() + 1500;
        while (!(mine === "a" ? state.bStarted : state.aStarted) && Date.now() < deadline) await sleep(5);
        return finalText(mine === "a" ? "RESULT-A-DONE" : "RESULT-B-DONE");
      })();
    };
    const childHandler = (req: LlmRequest): Promise<StreamEvent[]> => {
      const text = JSON.stringify(req.messages);
      if (text.includes("TASK-A-MARKER")) return barrier("a");
      if (text.includes("TASK-B-MARKER")) return barrier("b");
      return Promise.resolve(finalText("unexpected"));
    };

    const provider = new ScriptedToolProvider([
      twoCalls(
        { id: "ta", name: "task", args: JSON.stringify(taskArgs("Child A", "TASK-A-MARKER", "probe")) },
        { id: "tb", name: "task", args: JSON.stringify(taskArgs("Child B", "TASK-B-MARKER", "probe")) },
      ),
      childHandler,
      childHandler,
      finalText("parent done"),
    ]);
    t.providers.register(provider);
    const parent = t.core.createSession({ workbench: "code" });
    await t.core.setSessionAgent(parent.id, { agent: "build" });

    const startedAt = Date.now();
    const finished = waitForRunFinished(t.bus, parent.id);
    t.core.submitPrompt(parent.id, { text: "spawn both" });
    await finished;
    const elapsed = Date.now() - startedAt;

    // Sequential execution would burn the full 1500ms barrier; overlapped
    // children release it almost immediately.
    expect(elapsed).toBeLessThan(1200);

    // Both children exist, and the results persisted in call order.
    const children = t.core.listSessions().filter((s) => s.meta.parent === parent.id);
    expect(children).toHaveLength(2);
    const assistant = t.core.history(parent.id).find((m) => m.role === "assistant");
    const results = (assistant?.parts ?? []).filter((p) => p.kind === "tool_result");
    expect(results).toHaveLength(2);
    expect((results[0]?.payload as { content: string }).content).toContain("RESULT-A-DONE");
    expect((results[1]?.payload as { content: string }).content).toContain("RESULT-B-DONE");
  });

  test("a mixed batch (task + fs.read) stays sequential with call-order results", async () => {
    t.config.models.default = "scripted/main";
    writeFileSync(join(dir, "note.txt"), "file body here");
    t.agents.put("probe", { description: "probe persona", prompt: "PROBE PERSONA", tools: [] });
    const provider = new ScriptedToolProvider([
      twoCalls(
        { id: "t1", name: "task", args: JSON.stringify(taskArgs("One child", "MIXED-CHILD-TASK", "probe")) },
        { id: "f1", name: "fs.read", args: JSON.stringify({ path: "note.txt" }) },
      ),
      (req) => (JSON.stringify(req.messages).includes("MIXED-CHILD-TASK") ? finalText("mixed child answer") : finalText("unexpected")),
      finalText("parent done"),
    ]);
    t.providers.register(provider);
    const parent = t.core.createSession({ workbench: "code", cwd: dir });
    await t.core.setSessionAgent(parent.id, { agent: "build" });

    const finished = waitForRunFinished(t.bus, parent.id);
    t.core.submitPrompt(parent.id, { text: "do both" });
    await finished;

    const assistant = t.core.history(parent.id).find((m) => m.role === "assistant");
    const results = (assistant?.parts ?? []).filter((p) => p.kind === "tool_result");
    expect(results).toHaveLength(2);
    expect((results[0]?.payload as { content: string }).content).toContain("mixed child answer");
    expect((results[1]?.payload as { content: string }).content).toContain("file body here");
    // Sequential: parent, child, then the parent's final turn.
    expect(provider.requests).toHaveLength(3);
  });

  test("one child producing no answer doesn't kill its sibling in a parallel batch", async () => {
    t.config.models.default = "scripted/main";
    t.agents.put("probe", { description: "probe persona", prompt: "PROBE PERSONA", tools: [] });
    // Which child requests first is nondeterministic — dispatch by marker.
    const childSlot = (req: LlmRequest): Promise<StreamEvent[]> => {
      const text = JSON.stringify(req.messages);
      if (text.includes("EMPTY-CHILD-TASK")) return Promise.resolve(finalText(""));
      if (text.includes("GOOD-CHILD-TASK")) return Promise.resolve(finalText("good child answer"));
      return Promise.resolve(finalText("unexpected"));
    };
    const provider = new ScriptedToolProvider([
      twoCalls(
        { id: "ta", name: "task", args: JSON.stringify(taskArgs("Empty child", "EMPTY-CHILD-TASK", "probe")) },
        { id: "tb", name: "task", args: JSON.stringify(taskArgs("Good child", "GOOD-CHILD-TASK", "probe")) },
      ),
      childSlot,
      childSlot,
      finalText("parent done"),
    ]);
    t.providers.register(provider);
    const parent = t.core.createSession({ workbench: "code" });
    await t.core.setSessionAgent(parent.id, { agent: "build" });

    const finished = waitForRunFinished(t.bus, parent.id);
    t.core.submitPrompt(parent.id, { text: "spawn both" });
    await finished;

    const assistant = t.core.history(parent.id).find((m) => m.role === "assistant");
    const results = (assistant?.parts ?? []).filter((p) => p.kind === "tool_result");
    expect(results).toHaveLength(2);
    const empty = results[0]?.payload as { content: string };
    expect(empty.content).toContain("<task_error>");
    expect(empty.content).toContain("produced no final answer");
    expect((results[1]?.payload as { content: string }).content).toContain("good child answer");
  });
});
