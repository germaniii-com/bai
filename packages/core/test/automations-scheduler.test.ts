import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Store } from "../src/store/store";
import { Bus } from "../src/event/bus";
import { AutomationScheduler } from "../src/automations/scheduler";
import type { Automation } from "@bai/shared";

const sleep = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("automation scheduler", () => {
  let store: Store;
  let bus: Bus;
  let launches: string[];
  let doneResolvers: Array<() => void>;
  let scheduler: AutomationScheduler;

  beforeEach(() => {
    store = new Store(":memory:");
    bus = new Bus();
    launches = [];
    doneResolvers = [];
    scheduler = new AutomationScheduler({
      store,
      bus,
      tickMs: 60_000,
      agentExists: (name) => name === "build",
      workspaceRoots: () => ["/tmp/ws"],
      launch: (automation: Automation) => {
        launches.push(automation.id);
        // Runs link to a real session (FK); create one per fire.
        const session = store.sessions.insert({ workbench: "chat", now: new Date().toISOString() });
        const done = new Promise<void>((resolve) => doneResolvers.push(resolve));
        return Promise.resolve({ sessionId: session.id, done });
      },
    });
  });

  afterEach(() => {
    scheduler.stop();
    store.close();
  });

  test("create arms next_run_at and broadcasts", () => {
    const automation = scheduler.create({
      name: "Morning",
      prompt: "do it",
      schedule: { kind: "interval", minutes: 30 },
    });
    expect(automation.enabled).toBe(true);
    expect(automation.scheduleDisplay).toBe("Every 30 minutes");
    expect(automation.nextRunAt).not.toBeNull();
    expect(store.automations.get(automation.id)?.name).toBe("Morning");
  });

  test("a due automation fires, records an ok run, and re-arms", async () => {
    const automation = scheduler.create({
      name: "Firer",
      prompt: "go",
      schedule: { kind: "interval", minutes: 1 },
    });
    // Force it due.
    store.automations.update(automation.id, { nextRunAt: "2000-01-01T00:00:00.000Z" }, "2000-01-01T00:00:00.000Z");

    await scheduler.tick();
    expect(launches).toEqual([automation.id]);
    expect(store.automations.get(automation.id)?.lastStatus).toBe("running");

    doneResolvers[0]?.();
    await sleep(5);

    const updated = store.automations.get(automation.id);
    expect(updated?.lastStatus).toBe("ok");
    expect(updated?.lastRunAt).not.toBeNull();
    const runs = scheduler.runs(automation.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("ok");
    // Re-armed into the future.
    expect(new Date(updated?.nextRunAt ?? 0).getTime()).toBeGreaterThan(Date.now());
  });

  test("skips a due fire while the previous run is still in flight", async () => {
    const automation = scheduler.create({
      name: "Slow",
      prompt: "go",
      schedule: { kind: "interval", minutes: 1 },
    });
    store.automations.update(automation.id, { nextRunAt: "2000-01-01T00:00:00.000Z" }, "2000-01-01T00:00:00.000Z");
    await scheduler.tick();
    expect(launches).toHaveLength(1);
    expect(scheduler.isRunning(automation.id)).toBe(true);

    // Due again while still running → skipped, count unchanged, next advanced.
    store.automations.update(automation.id, { nextRunAt: "2000-01-01T00:00:00.000Z" }, "2000-01-01T00:00:00.000Z");
    await scheduler.tick();
    expect(launches).toHaveLength(1);
    expect(new Date(store.automations.get(automation.id)?.nextRunAt ?? 0).getTime()).toBeGreaterThan(Date.now());
  });

  test("runNow works while paused and refuses a concurrent run", () => {
    const automation = scheduler.create({
      name: "Manual",
      prompt: "go",
      schedule: { kind: "daily", hour: 9, minute: 0 },
      enabled: false,
    });
    expect(automation.nextRunAt).toBeNull();
    const run = scheduler.runNow(automation.id);
    expect(run?.status).toBe("running");
    expect(() => scheduler.runNow(automation.id)).toThrow(/already running/);
    doneResolvers[0]?.();
  });

  test("validates names, agents, and workspaces", () => {
    expect(() =>
      scheduler.create({ name: "bad/name", prompt: "x", schedule: { kind: "interval", minutes: 5 } }),
    ).toThrow(/Names start/);
    expect(() =>
      scheduler.create({ name: "AgentCheck", prompt: "x", schedule: { kind: "interval", minutes: 5 }, agent: "nope" }),
    ).toThrow(/Unknown agent/);
    expect(() =>
      scheduler.create({
        name: "WsCheck",
        prompt: "x",
        schedule: { kind: "interval", minutes: 5 },
        workspace: "/nope",
      }),
    ).toThrow(/not registered/);

    scheduler.create({ name: "Unique", prompt: "x", schedule: { kind: "interval", minutes: 5 } });
    expect(() =>
      scheduler.create({ name: "Unique", prompt: "y", schedule: { kind: "interval", minutes: 5 } }),
    ).toThrow(/already exists/);
  });

  test("update recomputes display + next run and can clear fields", () => {
    const automation = scheduler.create({
      name: "Editable",
      prompt: "x",
      schedule: { kind: "interval", minutes: 5 },
      agent: "build",
      workspace: "/tmp/ws",
    });
    const updated = scheduler.update(automation.id, {
      schedule: { kind: "daily", hour: 8, minute: 30 },
      agent: null,
      workspace: null,
    });
    expect(updated?.scheduleDisplay).toBe("Every day at 8:30 AM");
    expect(updated?.agent).toBeUndefined();
    expect(updated?.workspace).toBeUndefined();
  });

  test("recoverInterrupted marks runs left running by a dead process", () => {
    const automation = scheduler.create({
      name: "Crashy",
      prompt: "x",
      schedule: { kind: "interval", minutes: 5 },
    });
    store.automationRuns.insert({ automationId: automation.id, now: "2000-01-01T00:00:00.000Z" });
    scheduler.start();
    scheduler.stop();
    const runs = scheduler.runs(automation.id);
    expect(runs[0]?.status).toBe("error");
    expect(runs[0]?.error).toMatch(/interrupted/);
    expect(store.automations.get(automation.id)?.lastStatus).toBe("error");
  });
});
