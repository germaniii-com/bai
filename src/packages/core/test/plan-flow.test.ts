import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeCore, waitForEvent, type TestCore } from "./harness";
import { planWriteTool } from "../src/tools/plan-write";
import type { Event } from "@bai/shared";
import type { ToolDef } from "../src/provider/types";
import type { LlmRequest, Provider, ProviderStream, StreamEvent } from "../src/provider/types";
import type { ModelInfo } from "@bai/shared";

class ScriptedToolProvider implements Provider {
  readonly requests: LlmRequest[] = [];
  constructor(private readonly script: Array<StreamEvent[]>) {}
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
    this.requests.push(req);
    const events = this.script[this.requests.length - 1] ?? [{ type: "done", stopReason: "end_turn" } as StreamEvent];
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

describe("plan.write tool", () => {
  test("writes, replaces, and refuses path escapes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bai-plans-"));
    try {
      const t = planWriteTool(dir);
      const ctx = {} as never;
      const first = await t.execute({ name: "refactor-db", content: "# Plan\n\nStep 1." }, ctx);
      expect(first.content).toContain("Wrote plan refactor-db");
      expect(readFileSync(join(dir, "refactor-db.md"), "utf8")).toContain("# Plan");

      const second = await t.execute({ name: "refactor-db", content: "# Plan v2" }, ctx);
      expect(second.content).toContain("Updated plan");
      expect(readFileSync(join(dir, "refactor-db.md"), "utf8")).toContain("v2");

      await expect(t.execute({ name: "../escape", content: "x" }, ctx)).rejects.toThrow(/letters, digits/);
      await expect(t.execute({ name: "ok", content: "   " }, ctx)).rejects.toThrow(/non-empty/);
      expect(existsSync(join(dir, "escape.md"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("plan agent flow (end-to-end)", () => {
  let t: TestCore;
  let dir: string;

  beforeEach(() => {
    t = makeCore();
    dir = mkdtempSync(join(tmpdir(), "bai-planflow-"));
  });

  afterEach(() => {
    t.core.questions.stop();
    t.store.close();
    rmSync(t.dir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  test("plan → plan.exit approved → mid-run switch to build (persona + tools change)", async () => {
    t.config.models.default = "scripted/main";
    const provider = new ScriptedToolProvider([
      toolCall("w1", "plan.write", JSON.stringify({ name: "refactor", content: "# Refactor plan\n\n1. Split module." })),
      toolCall("p1", "plan.exit", JSON.stringify({ summary: "split the module" })),
      [{ type: "text_delta", delta: "implementing step 1" }, { type: "done", stopReason: "end_turn" }],
    ]);
    t.providers.register(provider);
    const session = t.core.createSession({ workbench: "code", cwd: dir });
    await t.core.setSessionAgent(session.id, { agent: "plan" });

    const answerer = (async () => {
      const evt = await waitForEvent(t.bus, "question.asked", { timeoutMs: 3000 });
      const request = (evt.payload as { request: { id: string } }).request;
      t.core.replyQuestion(request.id, [["Yes (Recommended)"]]);
    })();
    const finished = waitForEvent(t.bus, "run.finished");
    t.core.submitPrompt(session.id, { text: "plan it" });
    await finished;
    await answerer.catch(() => {});

    // The plan file landed in the plans dir.
    expect(readFileSync(join(t.dir, "plans", "refactor.md"), "utf8")).toContain("# Refactor plan");

    // Turn 1: the built-in plan agent's persona and its restricted tool set.
    const first = provider.requests[0] as LlmRequest & { tools?: ToolDef[] };
    expect((first.messages[0] as { content: string }).content).toContain("You are bai's plan agent");
    expect(first.tools?.map((d) => d.name)).toEqual(["fs.glob", "fs.grep", "fs.list", "fs.read", "plan.exit", "plan.write", "question", "todo"]);

    // The session's agent flipped to build (mid-run).
    const meta = t.core.getSession(session.id)?.meta as { agent?: string };
    expect(meta.agent).toBe("build");

    // Turn 3 (after the switch): build persona + build tool set.
    const third = provider.requests[2] as LlmRequest & { tools?: ToolDef[] };
    expect(third).toBeDefined();
    expect((third.messages[0] as { content: string }).content).toContain("bai's build agent");
    expect(third.tools?.map((d) => d.name)).toEqual(["bash", "fs.edit", "fs.glob", "fs.grep", "fs.list", "fs.read", "fs.write"]);

    // The plan.exit tool result told the model the switch happened.
    const results = t.core.history(session.id).flatMap((m) => m.parts).filter((p) => p.kind === "tool_result");
    const exitResult = results.find((p) => (p.payload as { content: string }).content.includes("switched to the build agent"));
    expect(exitResult).toBeDefined();
  });

  test("plan.exit declined: no switch, planning continues", async () => {
    t.config.models.default = "scripted/main";
    const provider = new ScriptedToolProvider([
      toolCall("w1", "plan.write", JSON.stringify({ name: "small", content: "# Small plan" })),
      toolCall("p1", "plan.exit", JSON.stringify({})),
      [{ type: "text_delta", delta: "refining" }, { type: "done", stopReason: "end_turn" }],
    ]);
    t.providers.register(provider);
    const session = t.core.createSession({ workbench: "code", cwd: dir });
    await t.core.setSessionAgent(session.id, { agent: "plan" });

    const answerer = (async () => {
      const evt = await waitForEvent(t.bus, "question.asked", { timeoutMs: 3000 });
      const request = (evt.payload as { request: { id: string } }).request;
      t.core.replyQuestion(request.id, [["No"]]);
    })();
    const finished = waitForEvent(t.bus, "run.finished");
    t.core.submitPrompt(session.id, { text: "plan" });
    await finished;
    await answerer.catch(() => {});

    // No switch: every turn stays on the plan agent.
    const meta = t.core.getSession(session.id)?.meta as { agent?: string };
    expect(meta.agent).toBe("plan");
    for (const req of provider.requests) {
      expect((req.messages[0] as { content: string }).content).toContain("You are bai's plan agent");
    }
    const results = t.core.history(session.id).flatMap((m) => m.parts).filter((p) => p.kind === "tool_result");
    expect(results.some((p) => (p.payload as { content: string }).content.includes("declined"))).toBe(true);
  });

  test("built-in plan and chat agents exist with the right tool lists", () => {
    const list = t.core.listAgents().map((a) => ({ name: a.name, tools: a.tools }));
    const plan = list.find((a) => a.name === "plan");
    const chat = list.find((a) => a.name === "chat");
    expect(plan?.tools).toEqual(["fs.read", "fs.list", "fs.glob", "fs.grep", "plan.write", "question", "todo", "plan.exit"]);
    expect(chat?.tools).toEqual(["web.search", "web.fetch", "question"]);
  });
});
