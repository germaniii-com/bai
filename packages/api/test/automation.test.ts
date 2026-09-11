import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createApp } from "../src";
import { makeStack, type TestStack } from "./harness";

describe("automation API", () => {
  let stack: TestStack;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    stack = makeStack();
    app = createApp(stack.deps);
  });

  afterEach(() => stack.cleanup());

  const create = (body: Record<string, unknown>): Promise<Response> =>
    Promise.resolve(
      app.request("/api/automation", {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      }),
    );

  test("create → list → get → update → delete", async () => {
    const created = await create({
      name: "Morning report",
      prompt: "Summarize the inbox",
      schedule: { kind: "interval", minutes: 30 },
    });
    expect(created.status).toBe(201);
    const { automation } = (await created.json()) as { automation: { id: string; scheduleDisplay: string } };
    expect(automation.scheduleDisplay).toBe("Every 30 minutes");

    const list = await app.request("/api/automation");
    const listBody = (await list.json()) as { automations: { id: string }[] };
    expect(listBody.automations.map((a) => a.id)).toContain(automation.id);

    const got = await app.request(`/api/automation/${automation.id}`);
    expect(got.status).toBe(200);
    const gotBody = (await got.json()) as { automation: { name: string }; runs: unknown[] };
    expect(gotBody.automation.name).toBe("Morning report");
    expect(gotBody.runs).toEqual([]);

    const updated = await app.request(`/api/automation/${automation.id}`, {
      method: "PUT",
      body: JSON.stringify({ schedule: { kind: "daily", hour: 9, minute: 0 }, enabled: false }),
      headers: { "Content-Type": "application/json" },
    });
    expect(updated.status).toBe(200);
    const updatedBody = (await updated.json()) as {
      automation: { scheduleDisplay: string; enabled: boolean };
    };
    expect(updatedBody.automation.scheduleDisplay).toBe("Every day at 9:00 AM");
    expect(updatedBody.automation.enabled).toBe(false);

    const del = await app.request(`/api/automation/${automation.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect((await app.request(`/api/automation/${automation.id}`)).status).toBe(404);
  });

  test("run-now creates a Chat session carrying automation identity", async () => {
    const created = await create({
      name: "Runner",
      prompt: "go",
      schedule: { kind: "interval", minutes: 5 },
    });
    const { automation } = (await created.json()) as { automation: { id: string } };

    const run = await app.request(`/api/automation/${automation.id}/run`, { method: "POST" });
    expect(run.status).toBe(202);
    const runBody = (await run.json()) as { run: { id: string; status: string } };
    expect(runBody.run.id.startsWith("arun_")).toBe(true);

    // The run's session exists immediately and is a chat session with meta.
    const sessions = stack.store.sessions.list();
    const runSession = sessions.find((s) => s.meta.automationId === automation.id);
    expect(runSession).toBeDefined();
    expect(runSession?.workbench).toBe("chat");
    expect(runSession?.meta.autoApprove).toBe(true);
  });

  test("validation: duplicate name, bad schedule, unknown agent", async () => {
    await create({ name: "Dup", prompt: "x", schedule: { kind: "interval", minutes: 5 } });
    const dup = await create({ name: "Dup", prompt: "y", schedule: { kind: "interval", minutes: 5 } });
    expect(dup.status).toBe(400);
    expect(((await dup.json()) as { error: string }).error).toMatch(/already exists/);

    const bad = await create({ name: "Bad", prompt: "x", schedule: { kind: "interval", minutes: 0 } });
    expect(bad.status).toBe(400);

    const agent = await create({
      name: "Agent",
      prompt: "x",
      schedule: { kind: "interval", minutes: 5 },
      agent: "ghost",
    });
    expect(agent.status).toBe(400);
    expect(((await agent.json()) as { error: string }).error).toMatch(/Unknown agent/);
  });

  test("unknown ids → 404; run while running → 409", async () => {
    expect((await app.request("/api/automation/nope")).status).toBe(404);
    expect((await app.request("/api/automation/nope", { method: "DELETE" })).status).toBe(404);
    expect((await app.request("/api/automation/nope/run", { method: "POST" })).status).toBe(404);
  });
});
