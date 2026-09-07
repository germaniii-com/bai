import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Event, ModelInfo, SessionId } from "@bai/shared";
import { makeCore, sleep, type TestCore } from "./harness";
import type { LlmRequest, Provider, ProviderStream, StreamEvent } from "../src/provider/types";

/**
 * Scripted provider with per-turn gates: `hold(n)` parks turn n at stream
 * entry until `release(n)` — the harness for mid-run submissions (the drain
 * blocks inside the provider call, exactly like a slow real provider).
 * Detached title-refine calls are answered inline WITHOUT consuming script
 * indices, so `script[n]` reliably maps to main turn n.
 */
class GatedScriptedProvider implements Provider {
  readonly requests: LlmRequest[] = [];
  private gates = new Map<number, { promise: Promise<void>; release: () => void }>();

  constructor(private readonly script: StreamEvent[][]) {}

  /** Block turn `index` at stream entry until release(index). */
  hold(index: number): void {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => (release = resolve));
    this.gates.set(index, { promise, release });
  }

  release(index: number): void {
    this.gates.get(index)?.release();
  }

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
    const gate = this.gates.get(index);
    if (gate !== undefined) await gate.promise;
    const events = this.script[index] ?? [{ type: "done", stopReason: "end_turn" } as StreamEvent];
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

const finalText = (delta: string): StreamEvent[] => [{ type: "text_delta", delta }, { type: "done", stopReason: "end_turn" }];

/** An unknown tool call: the gate errors it, the run continues (error-as-result). */
const unknownToolCall = (): StreamEvent[] => [
  { type: "tool_call_delta", id: "c1", name: "nonexistent_tool", argsDelta: "{}" },
  { type: "done", stopReason: "tool_use" },
];

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

describe("message queue (steer vs queue)", () => {
  let t: TestCore;
  let dir: string;

  beforeEach(() => {
    t = makeCore();
    dir = mkdtempSync(join(tmpdir(), "bai-queue-"));
  });

  afterEach(() => {
    t.store.close();
    rmSync(t.dir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  /** User-message texts in transcript order. */
  const historyTexts = (sessionId: SessionId): string[] =>
    t.core
      .history(sessionId)
      .filter((m) => m.role === "user")
      .map((m) => m.parts.map((p) => (p.kind === "text" ? ((p.payload as { text?: string } | null)?.text ?? "") : "")).join(""));

  const requestContains = (req: LlmRequest | undefined, text: string): boolean =>
    req !== undefined && JSON.stringify(req.messages).includes(text);

  test("queued input waits for idle; promotes at the would-be-idle boundary", async () => {
    t.config.models.default = "scripted/main";
    const provider = new GatedScriptedProvider([finalText("first reply"), finalText("second reply")]);
    t.providers.register(provider);
    const session = t.core.createSession({ workbench: "chat" });

    const events = collector(t.bus);
    provider.hold(0);
    t.core.submitPrompt(session.id, { text: "hi" });
    const drain = t.core.drainNow(session.id); // parks inside turn 0

    // Mid-run queued submit: admitted, NOT promoted.
    const queued = t.core.submitPrompt(session.id, { text: "queued msg", queue: true });
    expect(queued.queued).toBe(true);
    await sleep(20);
    expect(historyTexts(session.id)).not.toContain("queued msg");
    expect(t.store.inputs.pendingBySession(session.id).map((i) => i.id)).toContain(queued.id);
    // The snapshot seeds surfaces' queued lists from the same rows.
    expect(t.core.sessionSnapshot(session.id).pendingInputs.map((i) => i.id)).toContain(queued.id);

    // Release: turn 0 ends → the queued input promotes → turn 1 answers it.
    provider.release(0);
    await drain;
    await sleep(20);
    events.stop();

    expect(historyTexts(session.id)).toContain("queued msg");
    expect(provider.requests).toHaveLength(2);
    expect(requestContains(provider.requests[1], "queued msg")).toBe(true);
    // Promotion dropped the node (surfaces remove it on this event).
    expect(events.seen.some((e) => e.type === "input.promoted" && (e.payload as { inputId: string }).inputId === queued.id)).toBe(true);
    expect(t.core.sessionSnapshot(session.id).pendingInputs).toHaveLength(0);
  });

  test("send-now promotes at the next provider-turn boundary (mid-generation)", async () => {
    t.config.models.default = "scripted/main";
    const provider = new GatedScriptedProvider([unknownToolCall(), finalText("done")]);
    t.providers.register(provider);
    const session = t.core.createSession({ workbench: "chat" });

    const events = collector(t.bus);
    provider.hold(0);
    t.core.submitPrompt(session.id, { text: "hi" });
    const drain = t.core.drainNow(session.id);

    // Queue mid-run, then send-now: the input flips to steer semantics.
    const queued = t.core.submitPrompt(session.id, { text: "urgent msg", queue: true });
    await sleep(20);
    expect(historyTexts(session.id)).not.toContain("urgent msg");
    t.core.sendInputNow(session.id, queued.id);
    await sleep(20);
    // The flip emitted input.updated {queued: false} (surfaces drop the node)
    // but the input is still admitted — the drain is parked in turn 0.
    expect(events.seen.some((e) => e.type === "input.updated" && (e.payload as { inputId: string; queued: boolean }).inputId === queued.id && (e.payload as { queued: boolean }).queued === false)).toBe(true);
    expect(t.store.inputs.pendingBySession(session.id).map((i) => i.id)).toContain(queued.id);
    expect(historyTexts(session.id)).not.toContain("urgent msg");

    // Release: turn 0's tool call executes → boundary promotion → turn 1
    // carries the message mid-generation.
    provider.release(0);
    await drain;
    await sleep(20);
    events.stop();

    expect(historyTexts(session.id)).toContain("urgent msg");
    expect(provider.requests).toHaveLength(2);
    expect(requestContains(provider.requests[1], "urgent msg")).toBe(true);
  });

  test("cancel drops the queued input — it never runs", async () => {
    t.config.models.default = "scripted/main";
    const provider = new GatedScriptedProvider([finalText("only reply")]);
    t.providers.register(provider);
    const session = t.core.createSession({ workbench: "chat" });

    const events = collector(t.bus);
    provider.hold(0);
    t.core.submitPrompt(session.id, { text: "hi" });
    const drain = t.core.drainNow(session.id);

    const queued = t.core.submitPrompt(session.id, { text: "queued msg", queue: true });
    await sleep(20);
    t.core.cancelInput(session.id, queued.id);
    await sleep(20);
    expect(t.store.inputs.pendingBySession(session.id)).toHaveLength(0);

    provider.release(0);
    await drain;
    await sleep(20);
    events.stop();

    expect(historyTexts(session.id)).not.toContain("queued msg");
    expect(provider.requests).toHaveLength(1);
    expect(events.seen.some((e) => e.type === "input.cancelled" && (e.payload as { inputId: string }).inputId === queued.id)).toBe(true);
  });

  test("multiple queued drain one at a time in order; steers beat queued", async () => {
    t.config.models.default = "scripted/main";
    const provider = new GatedScriptedProvider([
      finalText("r0"),
      finalText("r1"),
      finalText("r2"),
      finalText("r3"),
    ]);
    t.providers.register(provider);
    const session = t.core.createSession({ workbench: "chat" });

    provider.hold(0);
    t.core.submitPrompt(session.id, { text: "hi" });
    const drain = t.core.drainNow(session.id);

    t.core.submitPrompt(session.id, { text: "q1", queue: true });
    t.core.submitPrompt(session.id, { text: "q2", queue: true });
    t.core.submitPrompt(session.id, { text: "steer msg" }); // no queue — steer
    await sleep(20);

    provider.release(0);
    await drain;
    await sleep(20);

    // Turn 1 = the steer (boundary promotion beats the queue).
    expect(requestContains(provider.requests[1], "steer msg")).toBe(true);
    expect(requestContains(provider.requests[1], "q1")).toBe(false);
    // Turn 2 = q1 (ONE queued at the idle boundary).
    expect(requestContains(provider.requests[2], "q1")).toBe(true);
    expect(requestContains(provider.requests[2], "q2")).toBe(false);
    // Turn 3 = q2.
    expect(requestContains(provider.requests[3], "q2")).toBe(true);
    expect(provider.requests).toHaveLength(4);
    expect(t.store.inputs.pendingBySession(session.id)).toHaveLength(0);
  });

  test("interrupt leaves queued inputs pending", async () => {
    t.config.models.default = "scripted/main";
    const provider = new GatedScriptedProvider([finalText("never fully streams")]);
    t.providers.register(provider);
    const session = t.core.createSession({ workbench: "chat" });

    provider.hold(0);
    t.core.submitPrompt(session.id, { text: "hi" });
    const drain = t.core.drainNow(session.id);

    const queued = t.core.submitPrompt(session.id, { text: "queued msg", queue: true });
    await sleep(20);
    t.core.interrupt(session.id);
    provider.release(0);
    await drain;
    await sleep(20);

    // The queued input is still admitted — it never promoted, and the user
    // can cancel or send-now it (surfaces keep the node).
    expect(t.store.inputs.pendingBySession(session.id).map((i) => i.id)).toContain(queued.id);
    expect(historyTexts(session.id)).not.toContain("queued msg");
  });

  test("send-now / cancel on a non-pending input throw (mapped to 409 upstream)", async () => {
    t.config.models.default = "scripted/main";
    const provider = new GatedScriptedProvider([finalText("reply")]);
    t.providers.register(provider);
    const session = t.core.createSession({ workbench: "chat" });

    const input = t.core.submitPrompt(session.id, { text: "hi" });
    await t.core.drainNow(session.id);
    await sleep(20);
    // The input promoted — it is no longer pending.
    expect(() => t.core.sendInputNow(session.id, input.id)).toThrow(/non-pending/);
    expect(() => t.core.cancelInput(session.id, input.id)).toThrow(/non-pending/);
    expect(() => t.core.sendInputNow(session.id, "inp_unknown" as never)).toThrow(/non-pending/);
    void provider;
  });
});
