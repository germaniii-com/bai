import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Event, ModelInfo, SessionUsage } from "@bai/shared";
import { makeCore, sleep, waitForEvent, type TestCore } from "./harness";
import type { LlmRequest, Provider, ProviderStream, StreamEvent } from "../src/provider/types";

/**
 * The `run.usage` event — the context tracker's live feed. One durable event
 * per provider turn carries the full token breakdown + model (+ context
 * window when the catalog knows it); `session.meta.lastUsage` mirrors it for
 * the snapshot seed; compaction emits a token-less event ("unknown until the
 * next turn", pi's `?` semantics).
 */

/** Subscribe first and accumulate every published event for later asserts. */
function collector(bus: TestCore["bus"]) {
  const seen: Event[] = [];
  const sub = bus.subscribe({
    onNotify: () => {
      for (const evt of sub.take()) seen.push(evt);
    },
  });
  return {
    seen,
    stop: () => bus.unsubscribe(sub.id),
  };
}

describe("run.usage events (context tracker feed)", () => {
  let t: TestCore;
  let dir: string;

  beforeEach(() => {
    t = makeCore();
    dir = mkdtempSync(join(tmpdir(), "bai-usage-evt-"));
  });

  afterEach(() => {
    t.store.close();
    rmSync(t.dir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  test("single-turn run: one event with usage + model; meta.lastUsage and snapshot seed match", async () => {
    const session = t.core.createSession({ workbench: "chat" });
    const events = collector(t.bus);
    t.core.submitPrompt(session.id, { text: "hi" });
    await t.core.drainNow(session.id);
    await sleep(10);
    events.stop();

    const usageEvents = events.seen.filter((e) => e.type === "run.usage");
    expect(usageEvents).toHaveLength(1);
    const payload = usageEvents[0]!.payload as { usage: SessionUsage };
    // The echo stub's fixed usage; no catalog entry → no contextWindow key.
    expect(payload.usage).toMatchObject({ inputTokens: 10, outputTokens: 5, model: "stub/echo" });
    expect(payload.usage.contextWindow).toBeUndefined();

    const meta = (t.core.getSession(session.id)?.meta ?? {}) as { lastUsage?: SessionUsage };
    expect(meta.lastUsage).toMatchObject({ inputTokens: 10, outputTokens: 5, model: "stub/echo" });

    const snap = t.core.sessionSnapshot(session.id);
    expect(snap.usage).toMatchObject({ inputTokens: 10, outputTokens: 5, model: "stub/echo" });
  });

  test("multi-turn tool run: the reporting turn's event lands; snapshot seeds from it", async () => {
    t.config.models.default = "stub/fs-demo";
    const session = t.core.createSession({ workbench: "code", cwd: dir });
    const events = collector(t.bus);
    t.core.submitPrompt(session.id, { text: JSON.stringify({ path: "notes.md", content: "agent was here\n" }) });
    await t.core.drainNow(session.id);
    await sleep(10);
    events.stop();

    // The stub's tool-call turn reports no usage; the final turn does — one
    // event, reflecting the last reporting turn (real providers report every
    // turn, so this is the per-turn feed's degenerate case).
    const usageEvents = events.seen.filter((e) => e.type === "run.usage");
    expect(usageEvents).toHaveLength(1);
    expect((usageEvents[0]!.payload as { usage: SessionUsage }).usage.model).toBe("stub/fs-demo");
    const snap = t.core.sessionSnapshot(session.id);
    expect(snap.usage).toMatchObject({ inputTokens: 10, outputTokens: 5, model: "stub/fs-demo" });
  });

  test("snapshot usage is null before the first turn", () => {
    const session = t.core.createSession({ workbench: "chat" });
    expect(t.core.sessionSnapshot(session.id).usage).toBeNull();
  });

  test("the event carries the estimated per-category breakdown (mirrored into the snapshot)", async () => {
    const session = t.core.createSession({ workbench: "chat" });
    const events = collector(t.bus);
    t.core.submitPrompt(session.id, { text: "hi" });
    await t.core.drainNow(session.id);
    await sleep(10);
    events.stop();

    const payload = events.seen.filter((e) => e.type === "run.usage")[0]!.payload as { usage: SessionUsage };
    const breakdown = payload.usage.breakdown;
    expect(breakdown).toBeDefined();
    // Every category is a non-negative integer estimate.
    for (const value of Object.values(breakdown!)) expect(value).toBeGreaterThanOrEqual(0);
    // The prompt always carries a system block, the non-task tool schemas,
    // the task tool's guidance, and the conversation.
    expect(breakdown!.system).toBeGreaterThan(0);
    expect(breakdown!.tools).toBeGreaterThan(0);
    expect(breakdown!.subagents).toBeGreaterThan(0);
    expect(breakdown!.conversation).toBeGreaterThan(0);
    // No MCP tools are loaded in v1 — the category is present but zero.
    expect(breakdown!.mcp).toBe(0);
    // The snapshot seed mirrors the event's breakdown.
    expect(t.core.sessionSnapshot(session.id).usage?.breakdown).toEqual(breakdown);
  });

  test("compaction emits a token-less event (unknown until the next turn)", async () => {
    const summarizer = new FakeSummarizer();
    t.providers.register(summarizer);
    t.config.models.default = "fake/main";

    const session = t.core.createSession({ workbench: "code", cwd: dir });
    // Seed over-threshold usage so the drain-end check trips (context.test.ts
    // pattern); the fake's run turn itself reports no usage.
    const existing = t.core.getSession(session.id);
    const meta = { ...(existing?.meta ?? {}), lastUsage: { inputTokens: 90_000 } };
    (t as unknown as { store: { sessions: { update(id: string, o: unknown): unknown } } }).store.sessions.update(session.id, {
      meta,
      now: new Date().toISOString(),
    });

    const events = collector(t.bus);
    const finished = waitForEvent(t.bus, "run.finished");
    t.core.submitPrompt(session.id, { text: "hello" });
    await finished;
    await sleep(10);
    events.stop();

    const afterMeta = t.core.getSession(session.id)?.meta as { compactionMessageId?: string };
    expect(afterMeta.compactionMessageId).toBeDefined();

    const usageEvents = events.seen.filter((e) => e.type === "run.usage");
    expect(usageEvents).toHaveLength(1);
    const payload = usageEvents[0]!.payload as { usage: SessionUsage };
    // Token-less: surfaces render `?` until the next turn re-reports. (No
    // catalog entry for fake/main → no contextWindow key either.)
    expect(payload.usage.inputTokens).toBeUndefined();
    expect(payload.usage.outputTokens).toBeUndefined();
    expect(t.core.sessionSnapshot(session.id).usage).toBeNull();
  });
});

/** Summarizer fake: echoes a canned summary when called with the summary prompt. */
class FakeSummarizer implements Provider {
  requests: LlmRequest[] = [];
  name(): string {
    return "fake";
  }
  async models(): Promise<ModelInfo[]> {
    return [
      { id: "fake/main", provider: "fake", label: "Big" },
      { id: "fake/mini", provider: "fake", label: "Mini" },
    ];
  }
  async stream(req: LlmRequest): Promise<ProviderStream> {
    this.requests.push(req);
    const isSummaryCall = (req.messages[0] as { content?: string })?.content?.startsWith("You are a conversation summarizer") ?? false;
    const events: StreamEvent[] = isSummaryCall
      ? [
          { type: "text_delta", delta: "Goal: fix the bug.\nProgress: edited src/a.ts.\nNext Steps: verify." },
          { type: "done", stopReason: "end_turn" },
        ]
      : [{ type: "text_delta", delta: "ok" }, { type: "done", stopReason: "end_turn" }];
    async function* g() {
      for (const e of events) yield e;
    }
    const it = g();
    return { [Symbol.asyncIterator]: () => it, close: async () => {} };
  }
}
