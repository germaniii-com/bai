import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeCore, sleep, waitForEvent, type TestCore } from "./harness";
import type { Provider, ProviderStream, StreamEvent, ToolDef, LlmRequest } from "../src/provider/types";
import type { ModelInfo } from "@bai/shared";

/**
 * A provider that replays a per-turn script — the harness for the whole
 * tool-call loop (same pattern as ScriptedTitleProvider, with tool calls).
 * Detached title-refine calls are answered inline WITHOUT consuming script
 * indices, so `script[n]` reliably maps to main turn n+1.
 */
class ScriptedToolProvider implements Provider {
  readonly requests: LlmRequest[] = [];

  constructor(
    private readonly script: Array<StreamEvent[] | ((req: LlmRequest) => StreamEvent[])>,
  ) {}

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

describe("tool-call loop", () => {
  let t: TestCore;
  let dir: string;

  beforeEach(() => {
    t = makeCore();
    dir = mkdtempSync(join(tmpdir(), "bai-runtools-"));
  });

  afterEach(() => {
    t.store.close();
    rmSync(t.dir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  test("full agentic loop: tool call → execute → result feeds next turn → final answer", async () => {
    t.config.models.default = "scripted/main";
    writeFileSync(join(dir, "note.txt"), "the secret is bai");
    const provider = new ScriptedToolProvider([
      toolCall("c1", "fs.read", JSON.stringify({ path: "note.txt" })),
      [{ type: "text_delta", delta: "The note says: the secret is bai" }, { type: "done", stopReason: "end_turn" }],
    ]);
    t.providers.register(provider);
    const session = t.core.createSession({ workbench: "code", cwd: dir });
    await t.core.setSessionAgent(session.id, { agent: "build" });
    const finished = waitForEvent(t.bus, "run.finished");
    t.core.submitPrompt(session.id, { text: "read the note" });
    await finished;

    const history = t.core.history(session.id);
    const assistant = history.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    const kinds = (assistant?.parts ?? []).map((p) => p.kind);
    expect(kinds).toContain("tool_call");
    expect(kinds).toContain("tool_result");
    const callPart = assistant?.parts.find((p) => p.kind === "tool_call");
    expect(callPart?.payload).toMatchObject({ callId: "c1", name: "fs.read" });
    const resultPart = assistant?.parts.find((p) => p.kind === "tool_result");
    expect((resultPart?.payload as { content: string }).content).toContain("the secret is bai");

    // Two provider turns: the scripted answer consumed the tool result.
    expect(provider.requests).toHaveLength(2);
    const secondTurn = provider.requests[1] as LlmRequest;
    const serialized = JSON.stringify(secondTurn.messages);
    expect(serialized).toContain("tool_use");
    expect(serialized).toContain("the secret is bai");
    // The agent persona rode the request as the leading system message.
    expect(secondTurn.messages[0]?.role).toBe("system");
  });

  test("config deny is enforced centrally (error result, run ends)", async () => {
    t.config.models.default = "scripted/main";
    t.config.permissions = { "fs.*": "deny" };
    const provider = new ScriptedToolProvider([
      toolCall("c1", "fs.read", '{"path":"note.txt"}'),
      [{ type: "text_delta", delta: "gave up" }, { type: "done", stopReason: "end_turn" }],
    ]);
    t.providers.register(provider);

    const session = t.core.createSession({ workbench: "code", cwd: dir });
    await t.core.setSessionAgent(session.id, { agent: "build" });
    const finished = waitForEvent(t.bus, "run.finished");
    t.core.submitPrompt(session.id, { text: "read" });
    await finished;

    const assistant = t.core.history(session.id).find((m) => m.role === "assistant");
    const result = (assistant?.parts.find((p) => p.kind === "tool_result")?.payload ?? {}) as { content: string; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Permission denied");
  });

  test("interactive ask: blocks, reply approved-once executes; always skips the next ask", async () => {
    t.config.models.default = "scripted/main";
    const provider = new ScriptedToolProvider([
      toolCall("w1", "fs.write", JSON.stringify({ path: "out.txt", content: "one" })),
      toolCall("w2", "fs.write", JSON.stringify({ path: "out.txt", content: "two" })),
      [{ type: "text_delta", delta: "done" }, { type: "done", stopReason: "end_turn" }],
    ]);
    t.providers.register(provider);
    const session = t.core.createSession({ workbench: "code", cwd: dir });
    await t.core.setSessionAgent(session.id, { agent: "build" });

    let replies = 0;
    const askReader = (async () => {
      for (;;) {
        const evt = await waitForEvent(t.bus, "permission.asked", { timeoutMs: 3000 });
        replies++;
        await t.core.replyPermission((evt.payload as { request: { id: string } }).request.id, "approved", replies === 1 ? "always" : "once");
        if (replies >= 1) break; // "always" covers the second write
      }
    })();

    const finished = waitForEvent(t.bus, "run.finished");
    t.core.submitPrompt(session.id, { text: "write twice" });
    await finished;
    await askReader.catch(() => {});

    expect(replies).toBe(1); // second write auto-allowed via meta approval
    const meta = t.core.getSession(session.id)?.meta as { approvals?: Record<string, string> };
    expect(meta.approvals?.["fs.write"]).toBe("allow");
    const history = t.core.history(session.id);
    const results = history.flatMap((m) => m.parts).filter((p) => p.kind === "tool_result");
    expect(results).toHaveLength(2);
    expect((results[0]?.payload as { content: string }).content).toContain("Wrote");
  });

  test("rejected ask feeds an error result and stops the run", async () => {
    t.config.models.default = "scripted/main";
    const provider = new ScriptedToolProvider([
      toolCall("w1", "fs.write", JSON.stringify({ path: "nope.txt", content: "x" })),
    ]);
    t.providers.register(provider);
    const session = t.core.createSession({ workbench: "code", cwd: dir });
    await t.core.setSessionAgent(session.id, { agent: "build" });

    const askReader = (async () => {
      const evt = await waitForEvent(t.bus, "permission.asked", { timeoutMs: 3000 });
      await t.core.replyPermission((evt.payload as { request: { id: string } }).request.id, "rejected", "once");
    })();
    const finished = waitForEvent(t.bus, "run.finished");
    t.core.submitPrompt(session.id, { text: "write" });
    await finished;
    await askReader.catch(() => {});

    const assistant = t.core.history(session.id).find((m) => m.role === "assistant");
    const result = (assistant?.parts.find((p) => p.kind === "tool_result")?.payload ?? {}) as { content: string; isError?: boolean };
    expect(result.isError).toBe(true);
    // The run ended after the denial: exactly one provider turn.
    expect(provider.requests).toHaveLength(1);
  });

  test("unknown agent selections are rejected at the API; deleted agents fall back at drain", async () => {
    t.config.models.default = "scripted/main";
    const provider = new ScriptedToolProvider([[{ type: "text_delta", delta: "hi" }, { type: "done", stopReason: "end_turn" }]]);
    t.providers.register(provider);

    // Unknown names are rejected immediately (surface feedback).
    const session = t.core.createSession({ workbench: "code" });
    expect(() => t.core.setSessionAgent(session.id, { agent: "ghost" })).toThrow(/Unknown agent/);

    // A selected agent deleted before the next prompt → drain falls back.
    t.agents.put("ephemeral", { description: "d", prompt: "EPHEMERAL PERSONA", tools: ["fs.read"] });
    await t.core.setSessionAgent(session.id, { agent: "ephemeral" });
    t.agents.remove("ephemeral");
    const finished = waitForEvent(t.bus, "run.finished");
    t.core.submitPrompt(session.id, { text: "hello" });
    await finished;

    // Fallback: the build persona led the request, with the build tool set.
    const first = provider.requests[0] as LlmRequest & { tools?: ToolDef[] };
    expect((first.messages[0] as { content: string }).content).not.toContain("EPHEMERAL PERSONA");
    expect(first.tools?.map((d) => d.name)).toEqual(["fs.edit", "fs.glob", "fs.list", "fs.read", "fs.write"]);
  });

  test("custom file-defined agent restricts offered tools", async () => {
    t.config.models.default = "scripted/main";
    t.agents.put("reader", { description: "read only", prompt: "You only read.", tools: ["fs.read"] });
    const provider = new ScriptedToolProvider([[{ type: "text_delta", delta: "hi" }, { type: "done", stopReason: "end_turn" }]]);
    t.providers.register(provider);
    const session = t.core.createSession({ workbench: "code" });
    await t.core.setSessionAgent(session.id, { agent: "reader" });
    const finished = waitForEvent(t.bus, "run.finished");
    t.core.submitPrompt(session.id, { text: "hello" });
    await finished;
    expect((provider.requests[0] as { tools?: ToolDef[] }).tools?.map((d) => d.name)).toEqual(["fs.read"]);
  });

  test("malformed tool arguments become an error result (not a crash)", async () => {
    t.config.models.default = "scripted/main";
    const provider = new ScriptedToolProvider([
      toolCall("bad", "fs.read", '{"path": nope'),
      [{ type: "text_delta", delta: "recovered" }, { type: "done", stopReason: "end_turn" }],
    ]);
    t.providers.register(provider);
    const session = t.core.createSession({ workbench: "code", cwd: dir });
    await t.core.setSessionAgent(session.id, { agent: "build" });
    const finished = waitForEvent(t.bus, "run.finished");
    t.core.submitPrompt(session.id, { text: "go" });
    await finished;
    const assistant = t.core.history(session.id).find((m) => m.role === "assistant");
    const result = (assistant?.parts.find((p) => p.kind === "tool_result")?.payload ?? {}) as { content: string; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Invalid arguments");
  });

  test("unknown tool name becomes an error result and the loop continues", async () => {
    t.config.models.default = "scripted/main";
    const provider = new ScriptedToolProvider([
      toolCall("u1", "nonexistent_tool", "{}"),
      [{ type: "text_delta", delta: "ok" }, { type: "done", stopReason: "end_turn" }],
    ]);
    t.providers.register(provider);
    const session = t.core.createSession({ workbench: "code", cwd: dir });
    await t.core.setSessionAgent(session.id, { agent: "build" });
    const finished = waitForEvent(t.bus, "run.finished");
    t.core.submitPrompt(session.id, { text: "go" });
    await finished;
    const assistant = t.core.history(session.id).find((m) => m.role === "assistant");
    const result = (assistant?.parts.find((p) => p.kind === "tool_result")?.payload ?? {}) as { content: string; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content).toContain("nonexistent_tool");
  });
});

// The sleep import keeps parity with sibling test files; retained for future
// timing-sensitive assertions.
void sleep;
