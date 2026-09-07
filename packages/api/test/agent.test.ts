import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createApp } from "../src";
import { makeStack, type TestStack } from "./harness";

describe("agent API", () => {
  let stack: TestStack;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    stack = makeStack();
    app = createApp(stack.deps);
  });

  afterEach(() => stack.cleanup());

  test("GET /agent lists the built-in build agent", async () => {
    const res = await app.request("/api/agent");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agents: { name: string; source: string; tools: string[] }[] };
    const build = body.agents.find((a) => a.name === "build");
    expect(build?.source).toBe("builtin");
    expect(build?.tools).toContain("fs.read");
  });

  test("agent CRUD: put → get → list → delete → 404", async () => {
    const put = await app.request("/api/agent/reviewer", {
      method: "PUT",
      body: JSON.stringify({
        description: "Reviews code.",
        tools: ["fs.read", "fs.glob"],
        prompt: "You are a code reviewer.",
      }),
      headers: { "Content-Type": "application/json" },
    });
    expect(put.status).toBe(201);
    const { agent } = (await put.json()) as { agent: { name: string; prompt: string; source: string } };
    expect(agent.name).toBe("reviewer");
    expect(agent.source).toBe("file");
    expect(agent.prompt).toBe("You are a code reviewer.");

    const got = await app.request("/api/agent/reviewer");
    expect(got.status).toBe(200);

    const list = await app.request("/api/agent");
    const names = ((await list.json()) as { agents: { name: string }[] }).agents.map((a) => a.name);
    expect(names).toContain("reviewer");

    const del = await app.request("/api/agent/reviewer", { method: "DELETE" });
    expect(del.status).toBe(200);
    expect((await app.request("/api/agent/reviewer")).status).toBe(404);
    // deleting again → 404
    expect((await app.request("/api/agent/reviewer", { method: "DELETE" })).status).toBe(404);
  });

  test("PUT /agent/build is rejected as built-in", async () => {
    const res = await app.request("/api/agent/build", {
      method: "PUT",
      body: JSON.stringify({ prompt: "overwrite" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
  });

  test("PUT /agent/9bad is rejected (invalid name)", async () => {
    const res = await app.request("/api/agent/9bad", {
      method: "PUT",
      body: JSON.stringify({ prompt: "x" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
  });

  test("PUT /agent validates the body (prompt required)", async () => {
    const res = await app.request("/api/agent/noprompt", {
      method: "PUT",
      body: JSON.stringify({ description: "no prompt here" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
  });

  test("PUT /session/:id/agent persists meta; unknown agent → 400; clear works", async () => {
    const session = stack.core.createSession({ workbench: "code" });
    const put = await app.request(`/api/session/${session.id}/agent`, {
      method: "PUT",
      body: JSON.stringify({ agent: "build" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(put.status).toBe(200);
    const { session: updated } = (await put.json()) as { session: { meta: Record<string, unknown> } };
    expect(updated.meta.agent).toBe("build");

    const bad = await app.request(`/api/session/${session.id}/agent`, {
      method: "PUT",
      body: JSON.stringify({ agent: "ghost" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(bad.status).toBe(400);

    const clear = await app.request(`/api/session/${session.id}/agent`, {
      method: "PUT",
      body: JSON.stringify({ clear: true }),
      headers: { "Content-Type": "application/json" },
    });
    expect(clear.status).toBe(200);
    const { session: cleared } = (await clear.json()) as { session: { meta: Record<string, unknown> } };
    expect(cleared.meta.agent).toBeUndefined();
  });
});

describe("tool API", () => {
  let stack: TestStack;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    stack = makeStack();
    app = createApp(stack.deps);
  });

  afterEach(() => stack.cleanup());

  test("GET /tool lists built-in fs tools", async () => {
    const res = await app.request("/api/tool");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tools: { name: string; origin: string }[] };
    const names = body.tools.map((t) => t.name);
    expect(names).toContain("fs.read");
    expect(names).toContain("fs.edit");
    expect(body.tools.find((t) => t.name === "fs.read")?.origin).toBe("builtin");
  });

  test("custom tool CRUD: put → listed (file origin) → delete", async () => {
    const code = `export default {
      description: "Echoes input.",
      schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      execute(args) { return { content: "echo: " + (args as { text: string }).text }; },
    };
`;
    const put = await app.request("/api/tool/echo", {
      method: "PUT",
      body: JSON.stringify({ code }),
      headers: { "Content-Type": "application/json" },
    });
    expect(put.status).toBe(201);
    const { registered } = (await put.json()) as { registered: boolean };
    expect(registered).toBe(true);

    const list = await app.request("/api/tool");
    const body = (await list.json()) as { tools: { name: string; origin: string }[] };
    expect(body.tools.find((t) => t.name === "echo")?.origin).toBe("file");

    const del = await app.request("/api/tool/echo", { method: "DELETE" });
    expect(del.status).toBe(200);
    expect((await app.request("/api/tool/echo", { method: "DELETE" })).status).toBe(404);
  });

  test("PUT /tool overrides a built-in; delete restores it; invalid names refused", async () => {
    const code = `export default {
      description: "Custom fs.read override.",
      schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      execute(args) { return { content: "override read: " + (args as { path: string }).path }; },
    };
`;
    const put = await app.request("/api/tool/fs.read", {
      method: "PUT",
      body: JSON.stringify({ code }),
      headers: { "Content-Type": "application/json" },
    });
    expect(put.status).toBe(201);
    const { registered } = (await put.json()) as { registered: boolean };
    expect(registered).toBe(true);

    // The override file is listed (origin flips) and readable.
    const list = await app.request("/api/tool");
    const body = (await list.json()) as { tools: { name: string; origin: string; builtin?: boolean }[] };
    const entry = body.tools.find((t) => t.name === "fs.read");
    expect(entry?.origin).toBe("file");
    expect(entry?.builtin).toBe(true); // marks the override (reset-to-default UX)
    const get = await app.request("/api/tool/fs.read");
    expect(get.status).toBe(200);
    expect(((await get.json()) as { code: string }).code).toContain("Custom fs.read override.");

    // Deleting the override restores the built-in registration.
    const del = await app.request("/api/tool/fs.read", { method: "DELETE" });
    expect(del.status).toBe(200);
    const relist = await app.request("/api/tool");
    const relistBody = (await relist.json()) as { tools: { name: string; origin: string; builtin?: boolean }[] };
    const restored = relistBody.tools.find((t) => t.name === "fs.read");
    expect(restored?.origin).toBe("builtin");
    expect(restored?.builtin).toBe(true);

    // Unknown dotted names and invalid names are still refused.
    const res2 = await app.request("/api/tool/9bad", {
      method: "PUT",
      body: JSON.stringify({ code: "export default {};" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res2.status).toBe(400);
    const res3 = await app.request("/api/tool/foo.bar", {
      method: "PUT",
      body: JSON.stringify({ code: "export default {};" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res3.status).toBe(400);
  });

  test("GET /tool/:name returns an override template for a built-in", async () => {
    const res = await app.request("/api/tool/bash");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { code: string };
    expect(body.code).toContain("Override of the built-in tool");
    expect(body.code).toContain("export default");
  });

  test("PUT /tool with broken code returns registered: false", async () => {
    const res = await app.request("/api/tool/broken", {
      method: "PUT",
      body: JSON.stringify({ code: "export default { oops" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { registered: boolean };
    expect(body.registered).toBe(false);
  });
});
