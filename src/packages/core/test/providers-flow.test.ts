import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeCore, waitForEvent, type TestCore } from "./harness";
import type { LlmRequest, Provider, ProviderStream, StreamEvent } from "../src";
import type { ModelInfo } from "@bai/shared";

/** Records every stream request — proves per-session model/account wiring. */
class RecordingProvider implements Provider {
  requests: LlmRequest[] = [];

  name(): string {
    return "fakeprov";
  }

  async models(): Promise<ModelInfo[]> {
    return [{ id: "fakeprov/m1", provider: "fakeprov", label: "Fake M1" }];
  }

  async stream(req: LlmRequest): Promise<ProviderStream> {
    this.requests.push(structuredClone(req));
    async function* generate(): AsyncGenerator<StreamEvent> {
      yield { type: "text_delta", delta: "ok" };
      yield { type: "done", stopReason: "end_turn" };
    }
    const iterator = generate();
    return {
      [Symbol.asyncIterator]: () => iterator,
      close: async () => {},
    };
  }
}

describe("per-session model/account + accounts API", () => {
  let t: TestCore;
  let fake: RecordingProvider;

  beforeEach(() => {
    t = makeCore();
    fake = new RecordingProvider();
    t.providers.register(fake);
  });

  afterEach(() => {
    t.store.close();
    rmSync(t.dir, { recursive: true, force: true });
  });

  test("session meta model/account drives the drain; credentials injected", async () => {
    t.core.setAccount("fakeprov", "work", { label: "Work", key: "key-123" });
    const session = t.core.createSession({ workbench: "chat" });
    t.core.setSessionModel(session.id, { model: "fakeprov/m1", account: "work" });

    const finished = waitForEvent(t.bus, "run.finished");
    t.core.submitPrompt(session.id, { text: "hi" });
    await finished;

    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.model).toBe("m1");
    expect(fake.requests[0]?.auth?.apiKey).toBe("key-123");
    // reply streamed from the fake provider into history
    const history = t.core.history(session.id);
    expect((history[1]?.parts[0]?.payload as { text: string }).text).toBe("ok");
  });

  test("clearing session model falls back to the global default", async () => {
    const session = t.core.createSession({ workbench: "chat" });
    t.core.setSessionModel(session.id, { model: "fakeprov/m1" });
    t.core.setSessionModel(session.id, { clear: true });
    expect(t.core.getSession(session.id)?.meta.model).toBeUndefined();

    const finished = waitForEvent(t.bus, "run.finished");
    t.core.submitPrompt(session.id, { text: "hi" });
    await finished;
    expect(fake.requests).toHaveLength(0); // default stub/echo ran, not fake
  });

  test("setSessionModel persists meta and emits session.updated", async () => {
    const session = t.core.createSession({ workbench: "chat" });
    const updated = waitForEvent(t.bus, "session.updated");
    const result = t.core.setSessionModel(session.id, { model: "stub/echo", account: "env" });
    await updated;
    expect(result?.meta.model).toBe("stub/echo");
    expect(result?.meta.account).toBe("env");
  });

  test("setAccount/removeAccount emit provider.updated", async () => {
    const updated = waitForEvent(t.bus, "provider.updated");
    t.core.setAccount("openai", "personal", { key: "sk-x" });
    await updated;

    const removed = waitForEvent(t.bus, "provider.updated");
    expect(t.core.removeAccount("openai", "personal")).toBe(true);
    await removed;
    expect(t.core.removeAccount("openai", "personal")).toBe(false);
  });

  test("providers() returns the merged list response", async () => {
    const list = await t.core.providers();
    expect(list.default.model).toBe("stub/echo");
    expect(list.providers.map((p) => p.id)).toContain("stub");
    const stub = list.providers.find((p) => p.id === "stub");
    expect(stub?.models[0]?.id).toBe("stub/echo");
  });
});
