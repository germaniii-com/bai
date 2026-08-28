import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createApp } from "../src";
import { makeStack, type TestStack } from "./harness";

describe("api contract", () => {
  let stack: TestStack;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    stack = makeStack();
    app = createApp(stack.deps);
  });

  afterEach(() => stack.cleanup());

  test("GET /api/health", async () => {
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: "test" });
  });

  test("session lifecycle: create → get → list → 404", async () => {
    const created = await app.request("/api/session", {
      method: "POST",
      body: JSON.stringify({ title: "t", workbench: "chat" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(created.status).toBe(201);
    const { session } = (await created.json()) as { session: { id: string } };

    const got = await app.request(`/api/session/${session.id}`);
    expect(got.status).toBe(200);

    const listed = await app.request("/api/session");
    expect(((await listed.json()) as { sessions: unknown[] }).sessions).toHaveLength(1);

    const missing = await app.request("/api/session/ses_nope");
    expect(missing.status).toBe(404);
  });

  test("submit validates body (zod)", async () => {
    const session = stack.core.createSession({ workbench: "chat" });
    const bad = await app.request(`/api/session/${session.id}/message`, {
      method: "POST",
      body: JSON.stringify({ text: "" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(bad.status).toBe(400);

    const ok = await app.request(`/api/session/${session.id}/message`, {
      method: "POST",
      body: JSON.stringify({ text: "hello" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(ok.status).toBe(202);
  });

  test("submit to unknown session → 404", async () => {
    const res = await app.request("/api/session/ses_nope/message", {
      method: "POST",
      body: JSON.stringify({ text: "x" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(404);
  });

  test("static hosting: hint page when dist is missing", async () => {
    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("not built");
  });

  test("static hosting never shadows /api/*", async () => {
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
  });

  test("bearer auth enforced when bound beyond loopback", async () => {
    stack.cleanup();
    stack = makeStack({ token: "secret-token-123", loopbackBind: false });
    app = createApp(stack.deps);

    const denied = await app.request("/api/health");
    expect(denied.status).toBe(401);

    const allowed = await app.request("/api/health", {
      headers: { Authorization: "Bearer secret-token-123" },
    });
    expect(allowed.status).toBe(200);
  });

  test("durable SSE stream: hello first, replay after cursor, run.finished", async () => {
    // Run a prompt to completion first so there are durable rows.
    const session = stack.core.createSession({ workbench: "chat" });
    stack.core.submitPrompt(session.id, { text: "stream me" });
    for (let i = 0; i < 100; i++) {
      if (!stack.core.coordinator.isActive(session.id)) break;
      await new Promise((r) => setTimeout(r, 10));
    }

    const res = await app.request(`/api/session/${session.id}/event?after=0`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");

    const reader = res.body?.getReader();
    if (reader === undefined) throw new Error("SSE response has no body");
    const decoder = new TextDecoder();
    let buffer = "";
    const frames: string[] = [];
    let sawHello = false;
    let sawFinished = false;

    const timeout = setTimeout(() => {
      void reader?.cancel();
    }, 3000);

    try {
      while (!sawFinished) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          frames.push(frame);
          if (frame.startsWith("event: server.hello")) sawHello = true;
          const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
          if (dataLine !== undefined && dataLine.includes("run.finished")) sawFinished = true;
        }
      }
    } finally {
      clearTimeout(timeout);
      void reader.cancel();
    }

    expect(sawHello).toBe(true);
    expect(sawFinished).toBe(true);
    // replay is ascending by seq (id: lines carry the cursor)
    const ids = frames
      .map((f) => f.split("\n").find((l) => l.startsWith("id: "))?.slice(4))
      .filter((x) => x !== undefined)
      .map(Number);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });

  test("config GET/PUT roundtrip", async () => {
    const got = await app.request("/api/config");
    expect(got.status).toBe(200);

    const put = await app.request("/api/config", {
      method: "PUT",
      body: JSON.stringify({ models: { default: "stub/echo" } }),
      headers: { "Content-Type": "application/json" },
    });
    expect(put.status).toBe(200);

    const bad = await app.request("/api/config", {
      method: "PUT",
      body: JSON.stringify({ server: { port: -5 } }),
      headers: { "Content-Type": "application/json" },
    });
    expect(bad.status).toBe(400);
  });
});
