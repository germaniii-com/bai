import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Store } from "../src/store/store";
import type { AutomationSchedule } from "@bai/shared";

const INTERVAL: AutomationSchedule = { kind: "interval", minutes: 30 };

describe("automations store", () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  test("insert/get/list/getByName", () => {
    const now = "2026-09-11T10:00:00.000Z";
    const a = store.automations.insert({
      name: "Morning report",
      prompt: "Summarize the inbox",
      schedule: INTERVAL,
      scheduleDisplay: "Every 30 minutes",
      enabled: true,
      nextRunAt: "2026-09-11T10:30:00.000Z",
      now,
    });
    expect(a.id.startsWith("auto_")).toBe(true);
    expect(a.enabled).toBe(true);
    expect(a.lastStatus).toBe("idle");
    expect(store.automations.get(a.id)?.name).toBe("Morning report");
    expect(store.automations.getByName("Morning report")?.id).toBe(a.id);
    expect(store.automations.list()).toHaveLength(1);
  });

  test("due returns only enabled automations at/over their time", () => {
    const now = "2026-09-11T10:00:00.000Z";
    const future = store.automations.insert({
      name: "Later",
      prompt: "x",
      schedule: INTERVAL,
      scheduleDisplay: "Every 30 minutes",
      enabled: true,
      nextRunAt: "2026-09-11T11:00:00.000Z",
      now,
    });
    const due = store.automations.insert({
      name: "Due",
      prompt: "y",
      schedule: INTERVAL,
      scheduleDisplay: "Every 30 minutes",
      enabled: true,
      nextRunAt: "2026-09-11T09:59:00.000Z",
      now,
    });
    const paused = store.automations.insert({
      name: "Paused",
      prompt: "z",
      schedule: INTERVAL,
      scheduleDisplay: "Every 30 minutes",
      enabled: false,
      nextRunAt: "2026-09-11T09:00:00.000Z",
      now,
    });
    const ids = store.automations.due("2026-09-11T10:00:00.000Z").map((a) => a.id);
    expect(ids).toContain(due.id);
    expect(ids).not.toContain(future.id);
    expect(ids).not.toContain(paused.id);
  });

  test("update changes fields and clears optional ones with null", () => {
    const now = "2026-09-11T10:00:00.000Z";
    const a = store.automations.insert({
      name: "Runner",
      prompt: "x",
      schedule: INTERVAL,
      scheduleDisplay: "Every 30 minutes",
      agent: "build",
      workspace: "/tmp/ws",
      enabled: true,
      nextRunAt: "2026-09-11T10:30:00.000Z",
      now,
    });
    const updated = store.automations.update(
      a.id,
      { name: "Renamed", workspace: null, enabled: false, lastStatus: "ok" },
      "2026-09-11T10:05:00.000Z",
    );
    expect(updated?.name).toBe("Renamed");
    expect(updated?.workspace).toBeUndefined();
    expect(updated?.agent).toBe("build");
    expect(updated?.enabled).toBe(false);
    expect(updated?.lastStatus).toBe("ok");
  });

  test("runs ledger and remove cascades", () => {
    const now = "2026-09-11T10:00:00.000Z";
    const a = store.automations.insert({
      name: "Ledger",
      prompt: "x",
      schedule: INTERVAL,
      scheduleDisplay: "Every 30 minutes",
      enabled: true,
      nextRunAt: now,
      now,
    });
    const run = store.automationRuns.insert({ automationId: a.id, now });
    expect(run.status).toBe("running");
    const finished = store.automationRuns.finish(run.id, {
      status: "ok",
      output: "done",
      now: "2026-09-11T10:00:05.000Z",
    });
    expect(finished?.status).toBe("ok");
    expect(finished?.output).toBe("done");
    expect(store.automationRuns.listByAutomation(a.id)).toHaveLength(1);

    expect(store.automations.remove(a.id)).toBe(true);
    expect(store.automations.get(a.id)).toBeUndefined();
    expect(store.automationRuns.listByAutomation(a.id)).toHaveLength(0);
  });

  test("recoverRunning marks interrupted runs as errors", () => {
    const now = "2026-09-11T10:00:00.000Z";
    const a = store.automations.insert({
      name: "Crashy",
      prompt: "x",
      schedule: INTERVAL,
      scheduleDisplay: "Every 30 minutes",
      enabled: true,
      nextRunAt: now,
      now,
    });
    store.automationRuns.insert({ automationId: a.id, now });
    const recovered = store.automationRuns.recoverRunning("2026-09-11T10:10:00.000Z");
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.status).toBe("error");
    expect(recovered[0]?.error).toMatch(/interrupted/);
    expect(store.automationRuns.listByAutomation(a.id)[0]?.status).toBe("error");
  });
});
