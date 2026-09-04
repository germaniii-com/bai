import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createApp } from "../src";
import { makeStack, type TestStack } from "./harness";

describe("revert / unrevert / fork routes", () => {
  let stack: TestStack;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    stack = makeStack();
    app = createApp(stack.deps);
  });

  afterEach(() => stack.cleanup());

  test("revert: 200 marks the boundary; 404 unknown session/message; 400 non-user message", async () => {
    // Build a two-turn transcript via the core API directly (the echo
    // provider drains synchronously through submitPrompt).
    const session = stack.core.createSession({ workbench: "chat" });
    stack.core.submitPrompt(session.id, { text: "one" });
    await stack.core.drainNow(session.id);
    stack.core.submitPrompt(session.id, { text: "two" });
    await stack.core.drainNow(session.id);
    const messages = stack.core.history(session.id);
    const secondUser = messages[2]!;
    const assistant = messages[1]!;

    const ok = await app.request(`/api/session/${session.id}/revert`, {
      method: "POST",
      body: JSON.stringify({ messageId: secondUser.id }),
      headers: { "Content-Type": "application/json" },
    });
    expect(ok.status).toBe(200);
    const { session: reverted } = (await ok.json()) as { session: { meta: Record<string, unknown> } };
    expect((reverted.meta.revert as { messageId: string }).messageId).toBe(secondUser.id);

    const notFound = await app.request(`/api/session/${session.id}/revert`, {
      method: "POST",
      body: JSON.stringify({ messageId: "msg_nope" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(notFound.status).toBe(404);

    const unknownSession = await app.request("/api/session/ses_nope/revert", {
      method: "POST",
      body: JSON.stringify({ messageId: secondUser.id }),
      headers: { "Content-Type": "application/json" },
    });
    expect(unknownSession.status).toBe(404);

    const notUser = await app.request(`/api/session/${session.id}/revert`, {
      method: "POST",
      body: JSON.stringify({ messageId: assistant.id }),
      headers: { "Content-Type": "application/json" },
    });
    expect(notUser.status).toBe(400);
  });

  test("unrevert: 200 clears the marker; no pending revert → still 200", async () => {
    const session = stack.core.createSession({ workbench: "chat" });
    stack.core.submitPrompt(session.id, { text: "one" });
    await stack.core.drainNow(session.id);
    const user = stack.core.history(session.id)[0]!;

    const reverted = await app.request(`/api/session/${session.id}/revert`, {
      method: "POST",
      body: JSON.stringify({ messageId: user.id }),
      headers: { "Content-Type": "application/json" },
    });
    expect(reverted.status).toBe(200);

    const restored = await app.request(`/api/session/${session.id}/unrevert`, { method: "POST" });
    expect(restored.status).toBe(200);
    const { session: cleared } = (await restored.json()) as { session: { meta: Record<string, unknown> } };
    expect(cleared.meta.revert).toBeUndefined();

    // Idempotent: unreverting with nothing pending is a no-op, not an error.
    const again = await app.request(`/api/session/${session.id}/unrevert`, { method: "POST" });
    expect(again.status).toBe(200);
  });

  test("fork: 201 new session with earlier history; 404 unknown session", async () => {
    const session = stack.core.createSession({ title: "Src", workbench: "chat" });
    stack.core.submitPrompt(session.id, { text: "one" });
    await stack.core.drainNow(session.id);
    stack.core.submitPrompt(session.id, { text: "two" });
    await stack.core.drainNow(session.id);
    const secondUser = stack.core.history(session.id)[2]!;

    const forked = await app.request(`/api/session/${session.id}/fork`, {
      method: "POST",
      body: JSON.stringify({ messageId: secondUser.id }),
      headers: { "Content-Type": "application/json" },
    });
    expect(forked.status).toBe(201);
    const { session: fork } = (await forked.json()) as { session: { id: string; title: string; meta: Record<string, unknown> } };
    expect(fork.title).toBe("Src (fork #1)");
    expect(fork.meta.forkedFrom).toBe(session.id);
    expect(stack.core.history(fork.id as never)).toHaveLength(2);

    const missing = await app.request("/api/session/ses_nope/fork", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    });
    expect(missing.status).toBe(404);
  });
});
