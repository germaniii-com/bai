import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Event, SessionId, ModelInfo } from "@bai/shared";
import { makeCore, sleep, type TestCore } from "./harness";
import type { LlmRequest, Provider, ProviderStream, StreamEvent } from "../src/provider/types";

/**
 * A provider that replays a per-turn script (same pattern as
 * run-tools.test.ts — title calls answered inline without consuming script
 * indices).
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

/** A provider whose stream always throws — exercises the drain error path. */
class FailingProvider implements Provider {
  name(): string {
    return "failing";
  }

  async models(): Promise<ModelInfo[]> {
    return [{ id: "failing/main", provider: "failing", label: "Failing", supportsTools: true }];
  }

  async stream(_req: LlmRequest): Promise<ProviderStream> {
    // Non-transient 400 shape: the auto-retry loop (provider/retry.ts) must
    // not delay this drain-error path with backoff.
    throw Object.assign(new Error("provider exploded"), { status: 400 });
  }
}

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

const finalText = (delta: string): StreamEvent[] => [{ type: "text_delta", delta }, { type: "done", stopReason: "end_turn" }];

describe("awaitable drains (drainNow)", () => {
  let t: TestCore;
  let dir: string;

  beforeEach(() => {
    t = makeCore();
    dir = mkdtempSync(join(tmpdir(), "bai-drain-"));
  });

  afterEach(() => {
    t.store.close();
    rmSync(t.dir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  test("drainNow resolves after the session runs to idle; exactly one run.started/finished", async () => {
    t.config.models.default = "scripted/main";
    const provider = new ScriptedToolProvider([finalText("hello from the drain")]);
    t.providers.register(provider);
    const session = t.core.createSession({ workbench: "chat" });

    const events = collector(t.bus);
    t.core.submitPrompt(session.id, { text: "hi" });
    await t.core.drainNow(session.id);
    await sleep(10);
    events.stop();

    const history = t.core.history(session.id);
    const assistant = history.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    const textPart = assistant?.parts.find((p) => p.kind === "text");
    expect((textPart?.payload as { text?: string }).text).toBe("hello from the drain");

    const types = events.seen.map((e) => e.type);
    expect(types.filter((x) => x === "run.started")).toHaveLength(1);
    expect(types.filter((x) => x === "run.finished")).toHaveLength(1);
  });

  test("drainNow on an already-active session awaits the same drain (no double-drain)", async () => {
    t.config.models.default = "scripted/main";
    const provider = new ScriptedToolProvider([finalText("once")]);
    t.providers.register(provider);
    const session = t.core.createSession({ workbench: "chat" });

    const events = collector(t.bus);
    t.core.submitPrompt(session.id, { text: "hi" });
    // Synchronous call right after submitPrompt: the wake's drain is active,
    // so drainNow must return its done promise, not start a second drain.
    await t.core.drainNow(session.id);
    await sleep(10);
    events.stop();

    expect(events.seen.filter((e) => e.type === "run.started")).toHaveLength(1);
    expect(events.seen.filter((e) => e.type === "run.finished")).toHaveLength(1);
    expect(provider.requests).toHaveLength(1);
  });

  test("drain errors: {aborted:false} then {error} run.finished both emitted; drainNow still resolves", async () => {
    t.config.models.default = "failing/main";
    t.providers.register(new FailingProvider());
    const session = t.core.createSession({ workbench: "chat" });

    const events = collector(t.bus);
    t.core.submitPrompt(session.id, { text: "hi" });
    // Must not reject — the error rides the durable run.finished events.
    await t.core.drainNow(session.id);
    await sleep(10);
    events.stop();

    const finishes = events.seen.filter((e) => e.type === "run.finished");
    expect(finishes).toHaveLength(2);
    expect((finishes[0]?.payload as { aborted?: boolean }).aborted).toBe(false);
    expect((finishes[1]?.payload as { error?: string }).error).toContain("provider exploded");
  });

  test("createSession parent/agent/model meta; unknown parent rejected", () => {
    const root = t.core.createSession({ workbench: "code", cwd: dir });
    expect(() => t.core.createSession({ parent: "ses_doesnotexist" as SessionId })).toThrow(/Unknown parent/);

    const child = t.core.createSession({
      parent: root.id,
      agent: "build",
      model: "stub/echo",
      workbench: "code",
      cwd: dir,
      title: "child (@build subagent)",
    });
    expect(child.meta).toMatchObject({ parent: root.id, agent: "build", model: "stub/echo" });
    expect(child.workbench).toBe("code");
    expect(child.cwd).toBe(dir);

    // Plain sessions still get an empty meta bag.
    const plain = t.core.createSession({ workbench: "chat" });
    expect(plain.meta).toEqual({});
  });
});
