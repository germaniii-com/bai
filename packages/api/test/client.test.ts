import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createApp, dialListener, followSession, type BaiClient } from "../src";
import type { Event, ModelInfo } from "@bai/shared";
import { makeStack, type TestStack } from "./harness";
import type { LlmRequest, Provider, ProviderStream, StreamEvent } from "@bai/core";

/**
 * A provider whose first main turn parks at stream entry until released —
 * the harness for mid-run submissions over the wire (title calls answered
 * inline without consuming turn indices).
 */
class GatedProvider implements Provider {
  readonly requests: LlmRequest[] = [];
  private gates = new Map<number, { promise: Promise<void>; release: () => void }>();

  hold(index: number): void {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => (release = resolve));
    this.gates.set(index, { promise, release });
  }

  release(index: number): void {
    this.gates.get(index)?.release();
  }

  name(): string {
    return "gated";
  }

  async models(): Promise<ModelInfo[]> {
    return [{ id: "gated/main", provider: "gated", label: "Gated", supportsTools: true }];
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
    return this.streamOf([{ type: "text_delta", delta: "reply" }, { type: "done", stopReason: "end_turn" }]);
  }

  private streamOf(events: StreamEvent[]): ProviderStream {
    async function* generate(): AsyncGenerator<StreamEvent> {
      for (const evt of events) yield evt;
    }
    const iterator = generate();
    return { [Symbol.asyncIterator]: () => iterator, close: async () => {} };
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * End-to-end integration tests: a real server on an ephemeral loopback port,
 * exercised through the typed client — no API mocks.
 */
describe("client ↔ server (integration)", () => {
  let stack: TestStack;
  let client: BaiClient;
  let server: ReturnType<typeof Bun.serve>;

  beforeEach(() => {
    stack = makeStack();
    server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: createApp(stack.deps).fetch });
    client = dialListener(server.port ?? 0);
  });

  afterEach(async () => {
    await Promise.race([server.stop(true), new Promise((r) => setTimeout(r, 1000))]);
    stack.cleanup();
  });

  test("health", async () => {
    expect(await client.health()).toEqual({ ok: true, version: "test" });
  });

  test("createSession pins an agent (the webui chat orchestrator pin)", async () => {
    const pinned = await client.createSession({ workbench: "chat", agent: "chat" });
    expect((pinned.meta as { agent?: string }).agent).toBe("chat");
    // Omitted → no pin (the TUI's default resolution is untouched).
    const plain = await client.createSession({ workbench: "chat" });
    expect((plain.meta as { agent?: string }).agent).toBeUndefined();
  });

  test("full chat round trip over the typed client", async () => {
    const session = await client.createSession({ title: "e2e", workbench: "chat" });
    expect(session.id.startsWith("ses_")).toBe(true);

    const events: string[] = [];
    const done = followSession(client, session.id, {
      onEvent: (e) => events.push(e.type),
      until: (e) => e.type === "run.finished",
    });
    await client.submitPrompt(session.id, { text: "round trip" });
    await done;

    expect(events).toContain("input.admitted");
    expect(events).toContain("run.started");
    expect(events).toContain("message.part.updated"); // user text rides the stream
    expect(events).toContain("message.part.delta");
    expect(events[events.length - 1]).toBe("run.finished");

    const history = await client.history(session.id);
    expect(history).toHaveLength(2);
    expect(history[1]?.role).toBe("assistant");

    // Snapshot + cursor: user text present, cursor past the events just
    // streamed, so a stream opened at afterSeq replays nothing (only the
    // stream-level server.hello greeting arrives).
    const snap = await client.historySnapshot(session.id);
    expect(snap.messages).toHaveLength(2);
    expect(snap.messages[0]?.parts.some((p) => p.kind === "text")).toBe(true);
    expect(snap.afterSeq).toBeGreaterThan(0);
    const ctrl = new AbortController();
    const replayed: Event[] = [];
    const drained = (async () => {
      for await (const evt of client.sessionEvents(session.id, {
        after: snap.afterSeq,
        signal: ctrl.signal,
      })) {
        replayed.push(evt);
      }
    })();
    await new Promise((r) => setTimeout(r, 200));
    ctrl.abort();
    await drained.catch(() => {});
    expect(replayed.filter((e) => e.type !== "server.hello")).toHaveLength(0);
  });

  test("message queue over the wire: queue mid-run → snapshot → cancel → 409s", async () => {
    const gated = new GatedProvider();
    stack.deps.providers.register(gated);
    await client.putConfig({ models: { default: "gated/main" } });
    const session = await client.createSession({ workbench: "chat" });

    gated.hold(0);
    await client.submitPrompt(session.id, { text: "hi" });
    await sleep(80); // let the drain park inside turn 0

    // Mid-run queued submit → the snapshot carries it (surfaces seed here).
    await client.submitPrompt(session.id, { text: "queued msg", queue: true });
    await sleep(50);
    let snap = await client.historySnapshot(session.id);
    const queuedId = snap.pendingInputs.find((i) => i.queued)?.id;
    expect(queuedId).toBeDefined();

    // Cancel over the wire → the snapshot clears.
    await client.cancelInput(session.id, queuedId!);
    snap = await client.historySnapshot(session.id);
    expect(snap.pendingInputs).toHaveLength(0);

    // Non-pending / unknown ids → 409 through the typed client (the store
    // matches on session AND id, so an unknown session is also "non-pending").
    await expect(client.cancelInput(session.id, queuedId!)).rejects.toThrow("409");
    await expect(client.sendInputNow(session.id, "inp_unknown")).rejects.toThrow("409");
    await expect(client.sendInputNow("ses_unknown", "inp_unknown")).rejects.toThrow("409");

    // Send-now over the wire on a fresh queued input: flips delivery, the
    // drain promotes it at the would-be-idle boundary after release.
    await client.submitPrompt(session.id, { text: "queued two", queue: true });
    await sleep(50);
    snap = await client.historySnapshot(session.id);
    const secondId = snap.pendingInputs.find((i) => i.queued)?.id;
    expect(secondId).toBeDefined();
    await client.sendInputNow(session.id, secondId!);
    gated.release(0);
    await sleep(100);
    snap = await client.historySnapshot(session.id);
    expect(snap.pendingInputs).toHaveLength(0);
    const texts = snap.messages
      .filter((m) => m.role === "user")
      .map((m) => m.parts.map((p) => (p.kind === "text" ? ((p.payload as { text?: string } | null)?.text ?? "") : "")).join(""));
    expect(texts).toContain("queued two");
  });

  test("config get/put through the typed client", async () => {
    const config = await client.getConfig();
    expect(config.models.default).toBe("stub/echo");
    const updated = await client.putConfig({ models: { default: "stub/echo" } });
    expect(updated.models.default).toBe("stub/echo");
  });

  test("renameSession round trip through the typed client", async () => {
    const session = await client.createSession({ workbench: "chat" });
    const renamed = await client.renameSession(session.id, "my title");
    expect(renamed.title).toBe("my title");
    expect((await client.getSession(session.id))?.title).toBe("my title");
  });

  test("job enqueue → poll → asset content", async () => {
    const job = await client.enqueueJob({ kind: "image.generate", input: { prompt: "e2e" } });
    let current = await client.getJob(job.id);
    for (let i = 0; i < 100 && current?.status !== "done"; i++) {
      await new Promise((r) => setTimeout(r, 10));
      current = await client.getJob(job.id);
    }
    expect(current?.status).toBe("done");

    const assets = (await (await fetch(`${client.opts.baseURL}/api/asset`)).json()) as {
      assets: Array<{ id: string; mime: string }>;
    };
    expect(assets.assets.length).toBeGreaterThan(0);
    const content = await fetch(`${client.opts.baseURL}/api/asset/${assets.assets[0]?.id}/content`);
    expect(content.status).toBe(200);
    expect(content.headers.get("Content-Type")).toBe("image/png");
    const bytes = new Uint8Array(await content.arrayBuffer());
    expect(bytes[0]).toBe(0x89);
  });

  test("bearer token required when server enforces it", async () => {
    stack.cleanup();
    stack = makeStack({ token: "tok-1234567890abcdef", loopbackBind: false });
    server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: createApp(stack.deps).fetch });

    const anonymous = dialListener(server.port ?? 0);
    await anonymous.health().catch((err: Error) => expect(err.message).toContain("401"));

    const authorized = dialListener(server.port ?? 0, "tok-1234567890abcdef");
    expect((await authorized.health()).ok).toBe(true);
  });
});
