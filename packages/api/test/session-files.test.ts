import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { newId } from "@bai/shared";
import { createApp } from "../src";
import { makeStack, type TestStack } from "./harness";

describe("session files API (plans & notes & checklist)", () => {
  let stack: TestStack;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    stack = makeStack();
    app = createApp(stack.deps);
  });
  afterEach(() => stack.cleanup());

  test("notes: GET (null) → PUT → GET", async () => {
    const session = stack.core.createSession({ workbench: "chat" });

    const before = await app.request(`/api/session/${session.id}/notes`);
    expect(before.status).toBe(200);
    expect(await before.json()).toEqual({ notes: null });

    const put = await app.request(`/api/session/${session.id}/notes`, {
      method: "PUT",
      body: JSON.stringify({ content: "# Notes" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ notes: "# Notes" });

    const after = await app.request(`/api/session/${session.id}/notes`);
    expect(await after.json()).toEqual({ notes: "# Notes" });
  });

  test("plans: list → put → get → list → delete → 404", async () => {
    const session = stack.core.createSession({ workbench: "code" });

    const empty = await app.request(`/api/session/${session.id}/plan`);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ plans: [] });

    const put = await app.request(`/api/session/${session.id}/plan/refactor`, {
      method: "PUT",
      body: JSON.stringify({ content: "# Refactor" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(put.status).toBe(201);
    const saved = (await put.json()) as { plan: { name: string; bytes: number } };
    expect(saved.plan.name).toBe("refactor");
    expect(saved.plan.bytes).toBeGreaterThan(0);

    const list = await app.request(`/api/session/${session.id}/plan`);
    const listed = (await list.json()) as { plans: { name: string }[] };
    expect(listed.plans.map((p) => p.name)).toEqual(["refactor"]);

    const one = await app.request(`/api/session/${session.id}/plan/refactor`);
    expect(one.status).toBe(200);
    expect(((await one.json()) as { plan: { content: string } }).plan.content).toBe("# Refactor");

    const del = await app.request(`/api/session/${session.id}/plan/refactor`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect((await app.request(`/api/session/${session.id}/plan/refactor`)).status).toBe(404);
  });

  test("rejects invalid names, unknown sessions, and oversized bodies", async () => {
    const session = stack.core.createSession({ workbench: "code" });

    const badName = await app.request(`/api/session/${session.id}/plan/bad.name`, {
      method: "PUT",
      body: JSON.stringify({ content: "x" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(badName.status).toBe(400);

    const unknown = newId.session();
    expect((await app.request(`/api/session/${unknown}/notes`)).status).toBe(404);
    expect((await app.request(`/api/session/${unknown}/plan`)).status).toBe(404);

    const tooLong = await app.request(`/api/session/${session.id}/notes`, {
      method: "PUT",
      body: JSON.stringify({ content: "x".repeat(200_001) }),
      headers: { "Content-Type": "application/json" },
    });
    expect(tooLong.status).toBe(400);
  });

  test("checklist: PUT /session/:id/todo replaces session.meta.todos", async () => {
    const session = stack.core.createSession({ workbench: "code" });
    const todos = [{ content: "a", status: "pending" as const, priority: "high" as const }];

    const res = await app.request(`/api/session/${session.id}/todo`, {
      method: "PUT",
      body: JSON.stringify({ todos }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ todos });
    expect(stack.core.readTodos(session.id)).toEqual(todos);
  });
});
