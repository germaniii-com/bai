import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { makeCore, type TestCore } from "./harness";
import type { SessionId } from "@bai/shared";

describe("automation agent tools", () => {
  let t: TestCore;
  const ctx = {
    sessionId: "ses_test" as SessionId,
    signal: new AbortController().signal,
    emitLive: () => {},
  };

  beforeEach(() => {
    t = makeCore();
  });

  afterEach(() => {
    t.store.close();
    rmSync(t.dir, { recursive: true, force: true });
  });

  test("automation.save creates, then automation.list reads it back", async () => {
    const save = t.tools.get("automation.save");
    const list = t.tools.get("automation.list");
    expect(save).toBeDefined();
    expect(list).toBeDefined();

    await save!.execute(
      { name: "Inbox triage", prompt: "Summarize unread mail", schedule: "every 30m" },
      ctx,
    );
    const result = await list!.execute({}, ctx);
    expect(result.content).toContain("Inbox triage");
    expect(t.automations.list()).toHaveLength(1);
    expect(t.automations.list()[0]?.scheduleDisplay).toBe("Every 30 minutes");
  });

  test("saving an existing name updates in place", async () => {
    const save = t.tools.get("automation.save")!;
    await save.execute({ name: "Daily", prompt: "A", schedule: "every day at 9am" }, ctx);
    await save.execute(
      { name: "Daily", prompt: "B", schedule: "every day at 10am", enabled: false },
      ctx,
    );
    const automations = t.automations.list();
    expect(automations).toHaveLength(1);
    expect(automations[0]?.prompt).toBe("B");
    expect(automations[0]?.scheduleDisplay).toBe("Every day at 10:00 AM");
    expect(automations[0]?.enabled).toBe(false);
  });

  test("invalid schedule and unknown agent are rejected", async () => {
    const save = t.tools.get("automation.save")!;
    await expect(
      save.execute({ name: "Bad", prompt: "x", schedule: "nonsense" }, ctx),
    ).rejects.toThrow(/Invalid schedule/);
    await expect(
      save.execute({ name: "Bad agent", prompt: "x", schedule: "30m", agent: "ghost" }, ctx),
    ).rejects.toThrow(/Unknown agent/);
    expect(t.automations.list()).toHaveLength(0);
  });
});
