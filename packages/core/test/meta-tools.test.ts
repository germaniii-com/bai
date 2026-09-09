import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionId } from "@bai/shared";
import { makeCore, waitForEvent, type TestCore } from "./harness";
import { workspaceCreateTool } from "../src/tools/workspace-create";
import { QuestionRejectedError } from "../src/question/service";
import type { LlmRequest, Provider, ProviderStream, StreamEvent } from "../src/provider/types";
import type { ModelInfo } from "@bai/shared";

/**
 * The orchestrator's meta-tools — agent.view/agent.save (agent authoring),
 * tool.create (custom-tool authoring), workspace.create (folder + config
 * registration) — plus the tool_result payload contract that carries the
 * created workspace path to surfaces (the "Open workspace" node action).
 */

class ScriptedToolProvider implements Provider {
  readonly requests: LlmRequest[] = [];

  constructor(private readonly script: Array<StreamEvent[] | ((req: LlmRequest) => StreamEvent[])>) {}

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
    const events = typeof entry === "function" ? entry(req) : (entry ?? [{ type: "done", stopReason: "end_turn" } as StreamEvent]);
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

describe("agent.view tool", () => {
  let t: TestCore;

  beforeEach(() => {
    t = makeCore();
  });

  afterEach(() => {
    t.store.close();
  });

  const ctx = () => ({
    sessionId: t.core.createSession({ workbench: "chat" }).id,
    signal: new AbortController().signal,
    emitLive: () => {},
  });

  test("returns a built-in agent's full definition (read-before-edit)", async () => {
    const result = await t.tools.execute("agent.view", { name: "chat" }, ctx());
    expect(result.content).toContain('Agent "chat" (builtin');
    // The prompt body rides the markdown source — the edit round-trip input.
    expect(result.content).toContain("all-in-one orchestrator");
    expect(result.content).toContain("tools:");
  });

  test("unknown agent rejected", async () => {
    await expect(t.tools.execute("agent.view", { name: "ghost" }, ctx())).rejects.toThrow("Unknown agent");
  });
});

describe("agent.save tool", () => {
  let t: TestCore;

  beforeEach(() => {
    t = makeCore();
  });

  afterEach(() => {
    t.store.close();
  });

  const ctx = () => ({
    sessionId: t.core.createSession({ workbench: "chat" }).id,
    signal: new AbortController().signal,
    emitLive: () => {},
  });

  test("creates an agent file, registers it live, and broadcasts agents.updated", async () => {
    const updated = waitForEvent(t.bus, "agents.updated");
    const result = await t.tools.execute(
      "agent.save",
      { name: "reviewer", description: "Reviews code changes.", prompt: "You review code.", tools: ["fs.read", "fs.grep"] },
      ctx(),
    );
    expect(result.content).toContain("Saved agent");
    await updated; // the registry's onChange broadcast fired

    const agent = t.agents.get("reviewer");
    expect(agent?.description).toBe("Reviews code changes.");
    expect(agent?.tools).toEqual(["fs.read", "fs.grep"]);
    expect(agent?.source).toBe("file");
    expect(existsSync(t.agents.fileFor("reviewer"))).toBe(true);
    const onDisk = readFileSync(t.agents.fileFor("reviewer"), "utf8");
    expect(onDisk).toContain("You review code.");
  });

  test("edit path: save replaces the whole definition (fields not carried are dropped)", async () => {
    const ctxv = ctx();
    await t.tools.execute("agent.save", { name: "rev", description: "v1", prompt: "p1", tools: ["fs.read"] }, ctxv);
    await t.tools.execute("agent.save", { name: "rev", description: "v2", prompt: "p2", tools: ["fs.read", "bash"] }, ctxv);
    expect(t.agents.get("rev")?.description).toBe("v2");
    expect(t.agents.get("rev")?.prompt).toBe("p2");
    expect(t.agents.get("rev")?.tools).toEqual(["fs.read", "bash"]);
  });

  test("built-in agents cannot be overwritten", async () => {
    await expect(t.tools.execute("agent.save", { name: "chat", prompt: "hijack" }, ctx())).rejects.toThrow("built-in");
  });

  test("validation rejections", async () => {
    const ctxv = ctx();
    await expect(t.tools.execute("agent.save", { name: "9bad", prompt: "p" }, ctxv)).rejects.toThrow("name must start");
    await expect(t.tools.execute("agent.save", { name: "ok", prompt: "  " }, ctxv)).rejects.toThrow("prompt");
    await expect(t.tools.execute("agent.save", { name: "ok", prompt: "p", tools: "fs.read" }, ctxv)).rejects.toThrow("tools must be an array");
  });
});

describe("tool.create tool", () => {
  let t: TestCore;

  beforeEach(() => {
    t = makeCore();
  });

  afterEach(() => {
    t.store.close();
  });

  const ctx = () => ({
    sessionId: t.core.createSession({ workbench: "chat" }).id,
    signal: new AbortController().signal,
    emitLive: () => {},
  });

  test("creates a custom tool that hot-registers and executes", async () => {
    const live: string[] = [];
    const cap = () => ({
      sessionId: t.core.createSession({ workbench: "chat" }).id,
      signal: new AbortController().signal,
      emitLive: (type: string) => live.push(type),
    });
    const code = [
      "export default {",
      '  description: "flips a coin",',
      '  schema: { type: "object", properties: {} },',
      "  execute() {",
      '    return { content: Math.random() < 0.5 ? "heads" : "tails" };',
      "  },",
      "};",
    ].join("\n");
    const result = await t.tools.execute("tool.create", { name: "coin_flip", code }, cap());
    expect(result.content).toContain("registered and callable");
    expect(live).toContain("tools.updated"); // the firehose broadcast fired

    const tool = t.tools.get("coin_flip");
    expect(tool).toBeDefined();
    expect(tool?.description).toBe("flips a coin");
    const out = await tool?.execute({}, cap());
    const flipped = out?.content ?? "";
    expect(["heads", "tails"]).toContain(flipped);
    // The file landed in the loader's (throwaway) directory.
    expect(existsSync(join(t.dir, "tools", "coin_flip.ts"))).toBe(true);
  });

  test("broken code → written but not registered → clear error", async () => {
    await expect(t.tools.execute("tool.create", { name: "broken_t", code: "export default {" }, ctx())).rejects.toThrow(
      "did not register",
    );
  });

  test("invalid name rejected (putTool validation)", async () => {
    await expect(t.tools.execute("tool.create", { name: "9bad", code: "export default {}" }, ctx())).rejects.toThrow(
      "Invalid tool name",
    );
  });
});

describe("workspace.create tool", () => {
  let t: TestCore;
  let home: string;
  let workspaces: string[];
  /** How the stubbed path ask answers: the prefill, a custom path, or a dismissal. */
  let answer: { kind: "prefill" } | { kind: "custom"; path: string } | { kind: "dismiss" };
  /** Captured askPath inputs (prompt/prefill assertions). */
  let asked: Array<{ prompt: string; prefill: string; hint?: string }>;

  beforeEach(() => {
    t = makeCore();
    mkdirSync(join(t.dir, "ws-home"), { recursive: true });
    // realpath: on macOS /var is a symlink to /private/var — the tool
    // registers the REAL path, so expectations must be real too.
    home = realpathSync(join(t.dir, "ws-home"));
    workspaces = [];
    answer = { kind: "prefill" };
    asked = [];
  });

  afterEach(() => {
    t.store.close();
  });

  /** Direct construction — home/config/questions injected (the Service wires QuestionService + homedir()). */
  const standalone = () =>
    workspaceCreateTool({
      questions: {
        askPath: async (input) => {
          asked.push(input.path);
          if (answer.kind === "dismiss") throw new QuestionRejectedError();
          return answer.kind === "custom" ? answer.path : input.path.prefill;
        },
      },
      updateConfig: (patch) => {
        if (patch.workspaces !== undefined) workspaces = [...patch.workspaces];
        return patch;
      },
      home: () => home,
      config: () => ({ workspaces }),
    });

  const ctx = (): { sessionId: SessionId; signal: AbortSignal; emitLive: (type: string, payload: unknown) => void } => ({
    sessionId: t.core.createSession({ workbench: "chat" }).id,
    signal: new AbortController().signal,
    emitLive: () => {},
  });

  test("asks first with the suggested absolute path pre-filled, then creates on confirm", async () => {
    const result = await standalone().execute({ path: "my-idea" }, ctx());
    // The ask carried the prompt + the resolved absolute suggestion.
    expect(asked).toHaveLength(1);
    expect(asked[0]?.prompt).toBe("Where should the workspace be created?");
    expect(asked[0]?.prefill).toBe(join(home, "my-idea"));
    // Confirming the prefill creates + registers it.
    const ws = join(home, "my-idea");
    expect(workspaces).toEqual([ws]);
    expect(existsSync(ws)).toBe(true);
    expect(result.meta?.workspace).toBe(ws);
    expect(result.content).toContain("Created workspace");
    // The confirmed path is retained as Q&A on the result.
    expect(result.meta?.questions).toEqual([
      { header: "Workspace folder", question: "Where should the workspace be created?", answers: [ws] },
    ]);
  });

  test("an edited (custom) answer is what gets created/registered", async () => {
    answer = { kind: "custom", path: join(home, "renamed-idea") };
    const result = await standalone().execute({ path: "my-idea" }, ctx());
    expect(workspaces).toEqual([join(home, "renamed-idea")]);
    expect(result.meta?.workspace).toBe(join(home, "renamed-idea"));
    expect(existsSync(join(home, "my-idea"))).toBe(false); // the suggestion was NOT created
  });

  test("dismissal creates nothing and fails with a clear error", async () => {
    answer = { kind: "dismiss" };
    await expect(standalone().execute({ path: "my-idea" }, ctx())).rejects.toThrow("No workspace created");
    expect(workspaces).toEqual([]);
    expect(existsSync(join(home, "my-idea"))).toBe(false);
    expect(asked).toHaveLength(1); // the ask WAS raised
  });

  test("registers an EXISTING folder outside home without creating anything", async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "bai-ws-outside-")));
    try {
      const result = await standalone().execute({ path: outside }, ctx());
      expect(workspaces).toEqual([outside]);
      expect(result.meta?.workspace).toBe(outside);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("creation outside home is rejected (the home-only guard)", async () => {
    await expect(standalone().execute({ path: "/definitely/not/a/real/place/bai-ws" }, ctx())).rejects.toThrow(
      "only allowed inside your home directory",
    );
    expect(workspaces).toEqual([]);
  });

  test("an existing FILE at the path is rejected", async () => {
    const file = join(home, "afile");
    writeFileSync(file, "x");
    await expect(standalone().execute({ path: file }, ctx())).rejects.toThrow("not a directory");
  });

  test("idempotent: an already-registered path succeeds without a config write", async () => {
    const t1 = standalone();
    await t1.execute({ path: "idea" }, ctx());
    expect(workspaces).toHaveLength(1);
    const live: string[] = [];
    const second = {
      ...ctx(),
      emitLive: (type: string) => live.push(type),
    };
    const result = await t1.execute({ path: "idea" }, second);
    expect(result.content).toContain("already registered");
    expect(workspaces).toHaveLength(1); // no duplicate registration
    expect(live).not.toContain("config.updated"); // no redundant broadcast
  });
});

describe("workspace.create → tool_result payload contract", () => {
  let t: TestCore;

  beforeEach(() => {
    t = makeCore();
    t.config.models.default = "scripted/main";
    // Auto-allowed by default — the tool's own path ask is the consent gate;
    // the drain test replies to it below.
  });

  afterEach(() => {
    t.store.close();
  });

  test("the registered workspace path rides the persisted tool_result part", async () => {
    const provider = new ScriptedToolProvider([
      toolCall("c1", "workspace.create", JSON.stringify({ path: "drain-idea" })),
      [{ type: "text_delta", delta: "workspace ready" }, { type: "done", stopReason: "end_turn" }],
    ]);
    t.providers.register(provider);
    const session = t.core.createSession({ workbench: "chat" });
    await t.core.setSessionAgent(session.id, { agent: "chat" });
    // The tool's path ask blocks the run — confirm the pre-filled path
    // (subscribe BEFORE the prompt: question.asked emits synchronously).
    const askedPromise = waitForEvent(t.bus, "question.asked");
    const finished = waitForEvent(t.bus, "run.finished");
    t.core.submitPrompt(session.id, { text: "make a workspace for this idea" });
    const asked = await askedPromise;
    const request = (asked.payload as { request: { id: string; path?: { prefill: string } } }).request;
    expect(request.path?.prefill).toContain("drain-idea");
    expect(t.core.replyQuestion(request.id, [[request.path?.prefill ?? ""]])).toBe(true);
    await finished;

    const assistant = t.core.history(session.id).find((m) => m.role === "assistant");
    const resultPart = assistant?.parts.find((p) => p.kind === "tool_result");
    const payload = resultPart?.payload as { workspace?: string; isError?: boolean };
    expect(payload.isError).toBeUndefined();
    // realpath: the tool registers the REAL path (/var → /private/var on macOS).
    const expected = join(realpathSync(join(t.dir, "home")), "drain-idea");
    expect(payload.workspace).toBe(expected);
    expect(existsSync(expected)).toBe(true);
    expect(t.config.workspaces).toContain(expected);
  });
});
