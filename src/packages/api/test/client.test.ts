import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createApp, dialListener, followSession, type BaiClient } from "../src";
import type { Event } from "@bai/shared";
import { makeStack, type TestStack } from "./harness";

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
