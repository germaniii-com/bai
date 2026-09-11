import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { makeCore, sleep, type TestCore } from "./harness";

describe("automation end-to-end (real core + stub provider)", () => {
  let t: TestCore;

  beforeEach(() => {
    t = makeCore();
  });

  afterEach(() => {
    t.automations.stop();
    t.store.close();
    rmSync(t.dir, { recursive: true, force: true });
  });

  test("a due automation runs its prompt in a new auto-approved Chat session", async () => {
    const automation = t.automations.create({
      name: "Smoke",
      prompt: "say hello",
      schedule: { kind: "interval", minutes: 1 },
      agent: "build",
    });
    // Force due.
    t.store.automations.update(automation.id, { nextRunAt: "2000-01-01T00:00:00.000Z" }, "2000-01-01T00:00:00.000Z");

    await t.automations.tick();

    // Wait for the drain to settle.
    let runs = t.automations.runs(automation.id);
    for (let i = 0; i < 200 && runs[0]?.status === "running"; i++) {
      await sleep(10);
      runs = t.automations.runs(automation.id);
    }

    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("ok");
    expect(runs[0]?.sessionId).toBeDefined();

    const session = t.store.sessions.get(runs[0]?.sessionId ?? "");
    expect(session?.workbench).toBe("chat");
    expect(session?.meta.autoApprove).toBe(true);
    expect(session?.meta.automationId).toBe(automation.id);
    expect(session?.title).toContain("Smoke");

    // The transcript has the user prompt + the stub's reply.
    const history = t.core.history(session!.id);
    expect(history.length).toBeGreaterThanOrEqual(2);
    expect(t.store.automations.get(automation.id)?.lastStatus).toBe("ok");
  });
});
