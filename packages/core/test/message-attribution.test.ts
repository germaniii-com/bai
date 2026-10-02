import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Event } from "@bai/shared";
import { makeCore, sleep, type TestCore } from "./harness";

/**
 * Per-assistant-message attribution: the engine stamps the resolved turn
 * wiring (agent, provider, model) on the assistant message row AND on the
 * `message.created` event, so a transcript can name what produced a reply even
 * after the session's model/agent changes, and can label a turn that was cut
 * off or cancelled before its first token.
 */
describe("assistant message attribution", () => {
  let t: TestCore;
  let dir: string;

  beforeEach(() => {
    t = makeCore();
    dir = mkdtempSync(join(tmpdir(), "bai-attribution-"));
  });

  afterEach(() => {
    t.store.close();
    rmSync(t.dir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  /** Subscribe first and accumulate every published event for later asserts. */
  function collector(bus: TestCore["bus"]) {
    const seen: Event[] = [];
    const sub = bus.subscribe({
      onNotify: () => {
        for (const evt of sub.take()) seen.push(evt);
      },
    });
    return { seen, stop: () => bus.unsubscribe(sub.id) };
  }

  test("the assistant row is stamped with the turn's agent/provider/model", async () => {
    const session = t.core.createSession({ workbench: "chat" });
    t.core.submitPrompt(session.id, { text: "hi" });
    await t.core.drainNow(session.id);
    await sleep(10);

    const assistant = t.core.history(session.id).find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    // The stub stack: default agent `build`, provider id `stub`, model `echo`.
    // `provider` + `model` compose back into the catalog's `stub/echo`.
    expect(assistant?.agent).toBe("build");
    expect(assistant?.provider).toBe("stub");
    expect(assistant?.model).toBe("echo");
  });

  test("user messages carry no attribution", async () => {
    const session = t.core.createSession({ workbench: "chat" });
    t.core.submitPrompt(session.id, { text: "hi" });
    await t.core.drainNow(session.id);
    await sleep(10);

    const user = t.core.history(session.id).find((m) => m.role === "user");
    expect(user).toBeDefined();
    expect(user?.agent).toBeUndefined();
    expect(user?.provider).toBeUndefined();
    expect(user?.model).toBeUndefined();
  });

  test("the message.created event carries the attribution (live surfaces label while streaming)", async () => {
    const session = t.core.createSession({ workbench: "chat" });
    const events = collector(t.bus);
    t.core.submitPrompt(session.id, { text: "hi" });
    await t.core.drainNow(session.id);
    await sleep(10);
    events.stop();

    const created = events.seen.filter((e) => e.type === "message.created" && e.payload.role === "assistant");
    expect(created).toHaveLength(1);
    expect(created[0]?.payload).toMatchObject({ agent: "build", provider: "stub", model: "echo" });

    // The user turn's event stays bare — no attribution keys invented.
    const userCreated = events.seen.filter((e) => e.type === "message.created" && e.payload.role === "user");
    expect(userCreated.length).toBeGreaterThan(0);
    const payload = userCreated[0]?.payload as { agent?: string; provider?: string; model?: string };
    expect(payload.agent).toBeUndefined();
    expect(payload.provider).toBeUndefined();
    expect(payload.model).toBeUndefined();
  });

  test("attribution follows the session's model choice, and switching mid-session keeps history truthful", async () => {
    // A different stub model for the second turn.
    t.config.models.default = "stub/echo";
    const session = t.core.createSession({ workbench: "chat" });

    t.core.submitPrompt(session.id, { text: "first" });
    await t.core.drainNow(session.id);
    await sleep(10);
    // Pin a different model on the session (what the model picker does).
    t.core.setSessionModel(session.id, { model: "stub/fs-demo" });

    t.core.submitPrompt(session.id, { text: "second" });
    await t.core.drainNow(session.id);
    await sleep(10);

    const assistants = t.core.history(session.id).filter((m) => m.role === "assistant");
    // The first turn keeps its own model; the second carries the new one.
    expect(assistants[0]?.model).toBe("echo");
    expect(assistants[1]?.model).toBe("fs-demo");
    // Both share the provider and agent in this stack.
    expect(assistants.every((m) => m.provider === "stub")).toBe(true);
    expect(assistants.every((m) => m.agent === "build")).toBe(true);
  });
});