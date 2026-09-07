import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isDefaultTitle,
  TITLE_SYSTEM_PROMPT,
  type LlmRequest,
  type Provider,
  type ProviderStream,
  type StreamEvent,
} from "../src";
import type { ModelInfo } from "@bai/shared";
import { makeCore, sleep, waitForEvent, type TestCore } from "./harness";

/**
 * Scripted provider for title tests: every stream call answers with a fixed
 * title. The title call is distinguishable from the main reply by its leading
 * system message (bai history is user/assistant only); an optional gate parks
 * the title call so tests can rename the session mid-refine.
 */
class ScriptedTitleProvider implements Provider {
  readonly requests: LlmRequest[] = [];

  constructor(
    private readonly title: string,
    private readonly gate?: Promise<void>,
  ) {}

  name(): string {
    return "fake";
  }

  async models(): Promise<ModelInfo[]> {
    // A reasoning "big" model (the session's model) plus two small ones —
    // exercises the title-call's small-model selection chain.
    return [
      { id: "fake/title", provider: "fake", label: "Fake Big", reasoning: true },
      { id: "fake/title-mini", provider: "fake", label: "Fake Mini" },
      { id: "fake/title-nano", provider: "fake", label: "Fake Nano" },
    ];
  }

  async stream(req: LlmRequest): Promise<ProviderStream> {
    this.requests.push(req);
    // The title call leads with the title-generator persona (drain calls
    // may also carry a system prompt — the agent persona — so matching on
    // "any system role" would misfire).
    const isTitleCall = req.messages[0]?.role === "system" && (req.messages[0] as { content: string }).content.startsWith("You are a title generator");
    const title = this.title;
    const gate = this.gate;
    async function* generate(): AsyncGenerator<StreamEvent> {
      if (isTitleCall && gate !== undefined) await gate;
      yield { type: "text_delta", delta: title };
      yield { type: "done", stopReason: "end_turn" };
    }
    const iterator = generate();
    return {
      [Symbol.asyncIterator]: () => iterator,
      close: async () => {},
    };
  }
}

describe("service + run coordinator", () => {
  let t: TestCore;

  beforeEach(() => {
    t = makeCore();
  });

  afterEach(() => {
    t.store.close();
    rmSync(t.dir, { recursive: true, force: true });
  });

  test("create → submit → drain → history (echo provider)", async () => {
    const finished = waitForEvent(t.bus, "run.finished");
    const session = t.core.createSession({ title: "test", workbench: "chat" });
    t.core.submitPrompt(session.id, { text: "hello world" });
    await finished;

    const history = t.core.history(session.id);
    expect(history).toHaveLength(2);
    expect(history[0]?.role).toBe("user");
    expect((history[0]?.parts[0]?.payload as { text: string }).text).toBe("hello world");
    expect(history[1]?.role).toBe("assistant");
    expect((history[1]?.parts[0]?.payload as { text: string }).text).toContain("Echo: hello world");
  });

  test("durable event log records the full run", async () => {
    const finished = waitForEvent(t.bus, "run.finished");
    const session = t.core.createSession({ workbench: "chat" });
    t.core.submitPrompt(session.id, { text: "hi" });
    await finished;

    const replay = t.log.replay(session.id, 0);
    const types = replay.map((e) => e.type);
    expect(types).toContain("session.created");
    expect(types).toContain("input.admitted");
    expect(types).toContain("run.started");
    expect(types.filter((x) => x === "message.created")).toHaveLength(2);
    expect(types.filter((x) => x === "message.part.delta").length).toBeGreaterThan(0);
    expect(types[types.length - 1]).toBe("run.finished");
    // seq is monotonic per session
    const seqs = replay.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  test("cursor replay: events after N only", async () => {
    const finished = waitForEvent(t.bus, "run.finished");
    const session = t.core.createSession({ workbench: "chat" });
    t.core.submitPrompt(session.id, { text: "hi" });
    await finished;

    const all = t.log.replay(session.id, 0);
    const mid = all[Math.floor(all.length / 2)]?.seq ?? 0;
    const after = t.log.replay(session.id, mid);
    expect(after[0]?.seq).toBe(mid + 1);
  });

  test("interrupt on idle session is safe", () => {
    const session = t.core.createSession({ workbench: "chat" });
    expect(() => t.core.interrupt(session.id)).not.toThrow();
  });

  test("unknown session submit throws", () => {
    expect(() => t.core.submitPrompt("ses_nope" as never, { text: "x" })).toThrow(/Unknown session/);
  });

  test("rename + archive emit session.updated", async () => {
    const session = t.core.createSession({ workbench: "chat" });
    const updated = waitForEvent(t.bus, "session.updated");
    t.core.renameSession(session.id, "new name");
    await updated;
    expect(t.core.getSession(session.id)?.title).toBe("new name");

    const archived = waitForEvent(t.bus, "session.updated");
    t.core.archiveSession(session.id);
    await archived;
    expect(t.core.getSession(session.id)?.meta.archived).toBe(true);
  });

  test("steering: second prompt during a drain still lands", async () => {
    const finished = waitForEvent(t.bus, "run.finished", { timeoutMs: 5000 });
    const session = t.core.createSession({ workbench: "chat" });
    t.core.submitPrompt(session.id, { text: "first" });
    await sleep(20); // let the drain start
    t.core.submitPrompt(session.id, { text: "second" }); // steer
    await finished;
    await sleep(50); // allow the coalesced wake to drain too

    const history = t.core.history(session.id);
    const userTexts = history
      .filter((m) => m.role === "user")
      .map((m) => (m.parts[0]?.payload as { text: string }).text);
    expect(userTexts).toContain("first");
    expect(userTexts).toContain("second");
  });

  // NOTE: queued-input lifecycle tests (send-now / cancel / events /
  // snapshot pendingInputs) live in run-queue.test.ts — they need a held
  // drain to be deterministic (an idle-session queued submit promotes
  // synchronously inside submitPrompt's wake).

  test("sessions created without a title get the default title", () => {
    const session = t.core.createSession({ workbench: "chat" });
    expect(isDefaultTitle(session.title)).toBe(true);
    // An explicit title is preserved verbatim.
    const named = t.core.createSession({ title: "custom", workbench: "chat" });
    expect(named.title).toBe("custom");
  });

  test("LLM refine replaces the default title via the provider's small model", async () => {
    const provider = new ScriptedTitleProvider("Crafted Title");
    t.providers.register(provider);
    const session = t.core.createSession({ workbench: "chat" });
    // The session runs on the reasoning "big" model; the title call must
    // pick the provider's small non-thinking model instead.
    t.core.setSessionModel(session.id, { model: "fake/title" });
    const finished = waitForEvent(t.bus, "run.finished");
    t.core.submitPrompt(session.id, { text: "hello world" });
    await finished;

    // The refine is detached — poll until it lands.
    let title = "";
    for (let i = 0; i < 200; i++) {
      title = t.core.getSession(session.id)?.title ?? "";
      if (title === "Crafted Title") break;
      await sleep(10);
    }
    expect(title).toBe("Crafted Title");

    // The title call rode the small model with the shared system prompt.
    const titleCall = provider.requests.find((r) => r.messages[0]?.role === "system" && (r.messages[0] as { content: string }).content.startsWith("You are a title generator"));
    expect(titleCall).toBeDefined();
    expect(titleCall?.model).toBe("title-mini");
    expect(titleCall?.messages[0]?.content).toBe(TITLE_SYSTEM_PROMPT);
  });

  test("config models.title overrides the small-model heuristic", async () => {
    const provider = new ScriptedTitleProvider("Configured Title");
    t.providers.register(provider);
    t.config.models.title = "fake/title-nano";
    const session = t.core.createSession({ workbench: "chat" });
    t.core.setSessionModel(session.id, { model: "fake/title" });
    const finished = waitForEvent(t.bus, "run.finished");
    t.core.submitPrompt(session.id, { text: "hello world" });
    await finished;

    let title = "";
    for (let i = 0; i < 200; i++) {
      title = t.core.getSession(session.id)?.title ?? "";
      if (title === "Configured Title") break;
      await sleep(10);
    }
    expect(title).toBe("Configured Title");
    const titleCall = provider.requests.find((r) => r.messages[0]?.role === "system" && (r.messages[0] as { content: string }).content.startsWith("You are a title generator"));
    expect(titleCall?.model).toBe("title-nano");
  });

  test("a concurrent rename wins over the generated title", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const provider = new ScriptedTitleProvider("Crafted Title", gate);
    t.providers.register(provider);
    const session = t.core.createSession({ workbench: "chat" });
    t.core.setSessionModel(session.id, { model: "fake/title" });
    const finished = waitForEvent(t.bus, "run.finished");
    t.core.submitPrompt(session.id, { text: "hello world" });
    await finished;

    // The title call is parked on the gate; rename meanwhile, then let the
    // refine land — the guard must keep the user's title.
    t.core.renameSession(session.id, "User Rename");
    release();
    await sleep(100);
    expect(t.core.getSession(session.id)?.title).toBe("User Rename");
  });

  test("one-shot sessions skip title generation entirely", async () => {
    const provider = new ScriptedTitleProvider("Crafted Title");
    t.providers.register(provider);
    const session = t.core.createSession({ workbench: "chat", oneshot: true });
    t.core.setSessionModel(session.id, { model: "fake/title" });
    const finished = waitForEvent(t.bus, "run.finished");
    t.core.submitPrompt(session.id, { text: "hello world" });
    await finished;
    await sleep(100); // a (wrongly) detached refine would have landed by now
    // No refine, no rename: the creation-time default title stands.
    expect(t.core.getSession(session.id)?.title).toBe(session.title);
  });

  test("titled sessions keep their title", async () => {
    const session = t.core.createSession({ title: "manual", workbench: "chat" });
    const finished = waitForEvent(t.bus, "run.finished");
    t.core.submitPrompt(session.id, { text: "hello" });
    await finished;
    await sleep(50);
    expect(t.core.getSession(session.id)?.title).toBe("manual");
  });

  test("stub provider never refines the title (default stands)", async () => {
    const session = t.core.createSession({ workbench: "chat" });
    const finished = waitForEvent(t.bus, "run.finished");
    t.core.submitPrompt(session.id, { text: "just a prompt" });
    await finished;
    await sleep(100);
    // Echo would "generate" "Echo: just a prompt" — the stub skip keeps the default.
    expect(t.core.getSession(session.id)?.title).toBe(session.title);
  });
});
