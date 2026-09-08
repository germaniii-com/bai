import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import type { Event, ModelInfo } from "@bai/shared";
import { makeCore, sleep, waitForEvent, type TestCore } from "./harness";
import { RETRY_DELAYS_MS } from "../src/provider/retry";
import type { LlmRequest, Provider, ProviderStream, StreamEvent } from "../src/provider/types";

/**
 * Auto-retry on transient pre-stream API failures (run.ts turn loop):
 * scripted provider failures → retry with backoff → run.retry events;
 * exhaustion → one D26 error row + run.finished {error}; non-transient
 * errors and aborts never retry.
 */

/** One scripted behavior per provider call (title calls answered inline). */
type Behavior = { throw: Error } | { events: StreamEvent[] };

class FlakyProvider implements Provider {
  readonly calls: LlmRequest[] = [];

  constructor(private readonly script: Behavior[]) {}

  name(): string {
    return "flaky";
  }

  async models(): Promise<ModelInfo[]> {
    return [{ id: "flaky/main", provider: "flaky", label: "Flaky", supportsTools: true }];
  }

  async stream(req: LlmRequest): Promise<ProviderStream> {
    const first = req.messages[0];
    const isTitleCall = first?.role === "system" && (first as { content: string }).content.startsWith("You are a title generator");
    if (isTitleCall) {
      return this.streamOf([{ type: "text_delta", delta: "Title" }, { type: "done", stopReason: "end_turn" }]);
    }
    const behavior = this.script[this.calls.length];
    this.calls.push(req);
    if (behavior && "throw" in behavior) throw behavior.throw;
    return this.streamOf(behavior?.events ?? [{ type: "done", stopReason: "end_turn" }]);
  }

  private streamOf(events: StreamEvent[]): ProviderStream {
    async function* generate(): AsyncGenerator<StreamEvent> {
      for (const evt of events) yield evt;
    }
    return { [Symbol.asyncIterator]: () => generate(), close: async () => {} };
  }
}

/** SDK APIError shape: an Error with `.status` and optional `.headers`. */
function apiError(status: number, headers?: Record<string, string>): Error {
  const err = new Error(`HTTP ${status}`);
  (err as { status?: number }).status = status;
  if (headers !== undefined) (err as { headers?: Record<string, string> }).headers = headers;
  return err;
}

const finalText = (delta: string): StreamEvent[] => [{ type: "text_delta", delta }, { type: "done", stopReason: "end_turn" }];

describe("run-loop auto-retry (transient pre-stream failures)", () => {
  let t: TestCore;

  beforeEach(() => {
    t = makeCore();
    // Shrink the fixed backoff so tests stay fast; restored after each.
    RETRY_DELAYS_MS.splice(0, RETRY_DELAYS_MS.length, 10, 10, 10);
  });

  afterEach(() => {
    RETRY_DELAYS_MS.splice(0, RETRY_DELAYS_MS.length, 1000, 2000, 4000);
    t.store.close();
    rmSync(t.dir, { recursive: true, force: true });
  });

  test("two transient failures then success: run completes, two run.retry events", async () => {
    t.config.models.default = "flaky/main";
    const provider = new FlakyProvider([
      { throw: apiError(429) },
      { throw: apiError(503) },
      { events: finalText("recovered") },
    ]);
    t.providers.register(provider);
    const session = t.core.createSession({ workbench: "chat" });

    t.core.submitPrompt(session.id, { text: "hi" });
    await t.core.drainNow(session.id);
    await sleep(20);

    expect(provider.calls).toHaveLength(3);
    const history = t.core.history(session.id);
    const assistant = history.find((m) => m.role === "assistant");
    const textPart = assistant?.parts.find((p) => p.kind === "text");
    expect((textPart?.payload as { text?: string }).text).toBe("recovered");

    // Retry events ride the durable log with attempt/maxAttempts.
    const log = t.store.events.replay(session.id, 0);
    const retries = log.filter((e) => e.type === "run.retry");
    expect(retries).toHaveLength(2);
    expect(retries[0]?.payload).toMatchObject({ attempt: 2, maxAttempts: 3 });
    expect(retries[1]?.payload).toMatchObject({ attempt: 3, maxAttempts: 3 });
  });

  test("Retry-After header wins over the fixed delay", async () => {
    t.config.models.default = "flaky/main";
    const provider = new FlakyProvider([
      { throw: Object.assign(apiError(429), { headers: { "retry-after": "1" } }) },
      { events: finalText("ok") },
    ]);
    t.providers.register(provider);
    const session = t.core.createSession({ workbench: "chat" });

    const start = Date.now();
    t.core.submitPrompt(session.id, { text: "hi" });
    await t.core.drainNow(session.id);
    // The 10ms fixed delays were replaced by a 1s Retry-After wait.
    expect(Date.now() - start).toBeGreaterThanOrEqual(1000);
    expect(provider.calls).toHaveLength(2);
  });

  test("three transient failures: run.finished {error}, one D26 error row, two retry events", async () => {
    t.config.models.default = "flaky/main";
    const provider = new FlakyProvider([
      { throw: apiError(429) },
      { throw: apiError(429) },
      { throw: apiError(500) },
    ]);
    t.providers.register(provider);
    const session = t.core.createSession({ workbench: "chat" });

    t.core.submitPrompt(session.id, { text: "hi" });
    await t.core.drainNow(session.id); // resolves — the error rides run.finished
    await sleep(20);

    expect(provider.calls).toHaveLength(3);
    const log = t.store.events.replay(session.id, 0);
    expect(log.filter((e) => e.type === "run.retry")).toHaveLength(2);
    const finishes = log.filter((e) => e.type === "run.finished");
    const errored = finishes.find((e) => (e.payload as { error?: string }).error !== undefined);
    expect((errored?.payload as { error?: string }).error).toContain("HTTP 500");

    // One D26 row for the whole failed turn (not one per attempt).
    const rows = t.store.usage.list().filter((r) => r.kind === "run");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: "flaky", model: "main", error: "HTTP 500" });
  });

  test("non-transient 401 fails immediately: no retry, no delay, no retry events", async () => {
    t.config.models.default = "flaky/main";
    const provider = new FlakyProvider([{ throw: apiError(401) }]);
    t.providers.register(provider);
    const session = t.core.createSession({ workbench: "chat" });

    const start = Date.now();
    t.core.submitPrompt(session.id, { text: "hi" });
    await t.core.drainNow(session.id);
    await sleep(20);

    expect(Date.now() - start).toBeLessThan(500);
    expect(provider.calls).toHaveLength(1);
    const log = t.store.events.replay(session.id, 0);
    expect(log.filter((e) => e.type === "run.retry")).toHaveLength(0);
    const finishes = log.filter((e) => e.type === "run.finished");
    expect((finishes[1]?.payload as { error?: string }).error).toContain("HTTP 401");
  });

  test("interrupt during the backoff wait: clean aborted run, no further attempt", async () => {
    t.config.models.default = "flaky/main";
    const provider = new FlakyProvider([
      { throw: apiError(429) },
      { events: finalText("should never run") },
    ]);
    t.providers.register(provider);
    const session = t.core.createSession({ workbench: "chat" });

    t.core.submitPrompt(session.id, { text: "hi" });
    // The first failure emits run.retry, then sleeps (shrunk to 10ms —
    // race the interrupt against the retry by aborting as soon as it lands).
    await waitForEvent(t.bus, "run.retry", { timeoutMs: 2000 });
    t.core.interrupt(session.id);
    await t.core.drainNow(session.id);
    await sleep(20);

    expect(provider.calls).toHaveLength(1);
    const log = t.store.events.replay(session.id, 0);
    const finishes = log.filter((e) => e.type === "run.finished");
    const aborted = finishes.find((e) => (e.payload as { aborted?: boolean }).aborted === true);
    expect(aborted).toBeDefined();
    // No assistant content from the second attempt.
    const history = t.core.history(session.id);
    expect(history.find((m) => m.role === "assistant")).toBeUndefined();
  });
});
