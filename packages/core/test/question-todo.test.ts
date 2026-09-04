import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QuestionRejectedError } from "../src/question/service";
import { makeCore, waitForEvent, type TestCore } from "./harness";
import type { Event, TodoItem } from "@bai/shared";
import type { Provider, ProviderStream, StreamEvent, LlmRequest } from "../src/provider/types";
import type { ModelInfo } from "@bai/shared";

/** Scripted provider answering title calls inline (see run-tools.test.ts). */
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

describe("question service", () => {
  test("ask → reply resolves with answers and emits both events", async () => {
    const t = makeCore();
    try {
      // Subscribe BEFORE raising the ask — ask() emits synchronously.
      const askedPromise = waitForEvent(t.bus, "question.asked");
      const askPromise = t.core.questions.ask({ questions: [{ question: "Which DB?", header: "db", options: [{ label: "Postgres", description: "pg" }, { label: "SQLite", description: "lite" }] }] });
      const asked = await askedPromise;
      const id = (asked.payload as { request: { id: string } }).request.id;
      const repliedPromise = waitForEvent(t.bus, "question.replied");
      expect(t.core.replyQuestion(id, [["Postgres"]])).toBe(true);
      await expect(askPromise).resolves.toEqual([["Postgres"]]);
      const replied = await repliedPromise;
      expect((replied.payload as { answers: string[][] }).answers).toEqual([["Postgres"]]);
      // Second reply is a no-op (first reply wins).
      expect(t.core.replyQuestion(id, [["SQLite"]])).toBe(false);
    } finally {
      t.core.questions.stop();
      t.store.close();
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  test("reject throws QuestionRejectedError into the awaiting tool", async () => {
    const t = makeCore();
    try {
      const askedPromise = waitForEvent(t.bus, "question.asked");
      const askPromise = t.core.questions.ask({ questions: [{ question: "q", header: "h", options: [{ label: "a", description: "d" }] }] });
      const asked = await askedPromise;
      const id = (asked.payload as { request: { id: string } }).request.id;
      t.core.rejectQuestion(id, "not now");
      await expect(askPromise).rejects.toBeInstanceOf(QuestionRejectedError);
    } finally {
      t.core.questions.stop();
      t.store.close();
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  test("stop() fails all pending (shutdown hygiene)", async () => {
    const t = makeCore();
    try {
      const askPromise = t.core.questions.ask({ questions: [{ question: "q", header: "h", options: [{ label: "a", description: "d" }] }] }).catch((err) => {
        if (!(err instanceof QuestionRejectedError)) throw err;
        return [];
      });
      t.core.questions.stop();
      await askPromise;
    } finally {
      t.store.close();
      rmSync(t.dir, { recursive: true, force: true });
    }
  });
});

describe("question + todo tools end-to-end", () => {
  let t: TestCore;
  let dir: string;

  beforeEach(() => {
    t = makeCore();
    dir = mkdtempSync(join(tmpdir(), "bai-question-"));
  });

  afterEach(() => {
    t.core.questions.stop();
    t.store.close();
    rmSync(t.dir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  test("agent asks via the question tool; answers feed the next turn", async () => {
    t.config.models.default = "scripted/main";
    t.agents.put("asker", { description: "asks", prompt: "ASKER", tools: ["question"] });
    const provider = new ScriptedToolProvider([
      [
        { type: "tool_call_delta", id: "q1", name: "question", argsDelta: JSON.stringify({ questions: [{ question: "Tabs or spaces?", header: "style", options: [{ label: "Tabs", description: "wide" }, { label: "Spaces", description: "narrow" }] }] }) },
        { type: "done", stopReason: "tool_use" },
      ],
      [{ type: "text_delta", delta: "great" }, { type: "done", stopReason: "end_turn" }],
    ]);
    t.providers.register(provider);
    const session = t.core.createSession({ workbench: "code" });
    await t.core.setSessionAgent(session.id, { agent: "asker" });

    // Answer when the ask arrives (the question tool is auto-allowed — no permission ask).
    const answerer = (async () => {
      const evt = await waitForEvent(t.bus, "question.asked", { timeoutMs: 3000 });
      const request = (evt.payload as { request: { id: string } }).request;
      // Snapshot exposes the pending question (surface opened mid-ask).
      expect(t.core.pendingQuestions(session.id).map((r) => r.id as string)).toContain(request.id);
      t.core.replyQuestion(request.id, [["Spaces"]]);
    })();
    const finished = waitForEvent(t.bus, "run.finished");
    t.core.submitPrompt(session.id, { text: "ask me" });
    await finished;
    await answerer.catch(() => {});

    const result = t.core.history(session.id).flatMap((m) => m.parts).find((p) => p.kind === "tool_result");
    expect((result?.payload as { content: string }).content).toContain('"Tabs or spaces?"="Spaces"');
    expect((result?.payload as { isError?: boolean }).isError).toBeUndefined();
  });

  test("dismissing the question block surfaces an error result", async () => {
    t.config.models.default = "scripted/main";
    t.agents.put("asker", { description: "asks", prompt: "ASKER", tools: ["question"] });
    const provider = new ScriptedToolProvider([
      [
        { type: "tool_call_delta", id: "q1", name: "question", argsDelta: JSON.stringify({ questions: [{ question: "Proceed?", header: "go", options: [{ label: "Yes", description: "y" }] }] }) },
        { type: "done", stopReason: "tool_use" },
      ],
    ]);
    t.providers.register(provider);
    const session = t.core.createSession({ workbench: "code" });
    await t.core.setSessionAgent(session.id, { agent: "asker" });

    const answerer = (async () => {
      const evt = await waitForEvent(t.bus, "question.asked", { timeoutMs: 3000 });
      const request = (evt.payload as { request: { id: string } }).request;
      t.core.rejectQuestion(request.id);
    })();
    const finished = waitForEvent(t.bus, "run.finished");
    t.core.submitPrompt(session.id, { text: "ask" });
    await finished;
    await answerer.catch(() => {});

    const result = t.core.history(session.id).flatMap((m) => m.parts).find((p) => p.kind === "tool_result");
    expect((result?.payload as { content: string }).content).toContain("dismissed");
    expect((result?.payload as { isError?: boolean }).isError).toBe(true);
  });

  test("todo tool persists session.meta.todos and emits todos.updated", async () => {
    t.config.models.default = "scripted/main";
    t.agents.put("planner", { description: "plans", prompt: "PLANNER", tools: ["todo"] });
    const todos: TodoItem[] = [
      { content: "Explore the repo", status: "completed", priority: "high" },
      { content: "Write the plan", status: "in_progress", priority: "high" },
    ];
    const provider = new ScriptedToolProvider([
      [
        { type: "tool_call_delta", id: "t1", name: "todo", argsDelta: JSON.stringify({ todos }) },
        { type: "done", stopReason: "tool_use" },
      ],
      [{ type: "text_delta", delta: "tracked" }, { type: "done", stopReason: "end_turn" }],
    ]);
    t.providers.register(provider);
    const session = t.core.createSession({ workbench: "code" });
    await t.core.setSessionAgent(session.id, { agent: "planner" });

    const eventPromise = waitForEvent(t.bus, "todos.updated");
    const finished = waitForEvent(t.bus, "run.finished");
    t.core.submitPrompt(session.id, { text: "track work" });
    await finished;
    const evt = (await eventPromise) as Event<"todos.updated">;
    expect(evt.payload.todos).toEqual(todos);

    const meta = t.core.getSession(session.id)?.meta as { todos?: TodoItem[] };
    expect(meta.todos).toEqual(todos);
  });
});

describe("question tool result retention", () => {
  test("the answered Q&A is stamped onto the tool_result payload (transcript review)", async () => {
    const t = makeCore();
    try {
      t.config.models.default = "scripted/main";
      const provider = new ScriptedToolProvider([
        [
          {
            type: "tool_call_delta",
            id: "q1",
            name: "question",
            argsDelta: JSON.stringify({
              questions: [
                { question: "Which database?", header: "db", options: [{ label: "Postgres", description: "pg" }, { label: "SQLite", description: "lite" }] },
                { question: "Proceed?", header: "confirm", options: [{ label: "yes", description: "go" }, { label: "no", description: "stop" }] },
              ],
            }),
          },
          { type: "done", stopReason: "tool_use" },
        ],
        [{ type: "text_delta", delta: "ok" }, { type: "done", stopReason: "end_turn" }],
      ]);
      t.providers.register(provider);
      const session = t.core.createSession({ workbench: "code" });
      await t.core.setSessionAgent(session.id, { agent: "build" });

      const askReader = (async () => {
        const evt = await waitForEvent(t.bus, "question.asked", { timeoutMs: 3000 });
        const id = (evt.payload as { request: { id: string } }).request.id;
        t.core.replyQuestion(id, [["Postgres"], []]); // second question left unanswered
      })();
      const finished = waitForEvent(t.bus, "run.finished");
      t.core.submitPrompt(session.id, { text: "ask me" });
      await finished;
      await askReader.catch(() => {});

      const assistant = t.core.history(session.id).find((m) => m.role === "assistant");
      const payload = (assistant?.parts.find((p) => p.kind === "tool_result")?.payload ?? {}) as {
        questions?: Array<{ header?: string; question: string; answers: string[] }>;
      };
      // The structured review rides the payload — surfaces render it as a
      // re-openable Q&A review instead of the model-facing sentence.
      expect(payload.questions).toEqual([
        { header: "db", question: "Which database?", answers: ["Postgres"] },
        { header: "confirm", question: "Proceed?", answers: [] },
      ]);
    } finally {
      t.core.questions.stop();
      t.store.close();
      rmSync(t.dir, { recursive: true, force: true });
    }
  });
});
