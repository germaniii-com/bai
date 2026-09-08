import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createApp } from "../src";
import { makeStack, type TestStack } from "./harness";

describe("skill API", () => {
  let stack: TestStack;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    stack = makeStack();
    app = createApp(stack.deps);
  });

  afterEach(() => stack.cleanup());

  test("GET /skill lists skills (empty at boot)", async () => {
    const res = await app.request("/api/skill");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { skills: unknown[] }).skills).toEqual([]);
  });

  test("skill CRUD: put → get (with usage) → list → delete → 404", async () => {
    const put = await app.request("/api/skill/arxiv", {
      method: "PUT",
      body: JSON.stringify({
        description: "Search arXiv papers by keyword or ID.",
        version: "1.0.0",
        tags: ["research", "papers"],
        body: "# arXiv Research\n\nSearch papers.",
      }),
      headers: { "Content-Type": "application/json" },
    });
    expect(put.status).toBe(201);
    const { skill } = (await put.json()) as { skill: { name: string; description: string; body: string; tags: string[]; source: string } };
    expect(skill.name).toBe("arxiv");
    expect(skill.description).toBe("Search arXiv papers by keyword or ID.");
    expect(skill.tags).toEqual(["research", "papers"]);
    expect(skill.source).toBe("file");

    const got = await app.request("/api/skill/arxiv");
    expect(got.status).toBe(200);
    const detail = (await got.json()) as { skill: { name: string }; usage: { views: number; sessions: number } };
    expect(detail.skill.name).toBe("arxiv");
    expect(detail.usage.views).toBe(0);

    const list = await app.request("/api/skill");
    const names = ((await list.json()) as { skills: { name: string }[] }).skills.map((s) => s.name);
    expect(names).toContain("arxiv");

    const del = await app.request("/api/skill/arxiv", { method: "DELETE" });
    expect(del.status).toBe(200);
    expect((await app.request("/api/skill/arxiv")).status).toBe(404);
    // deleting again → 404
    expect((await app.request("/api/skill/arxiv", { method: "DELETE" })).status).toBe(404);
  });

  test("PUT /skill validates the body (description + body required)", async () => {
    const res = await app.request("/api/skill/nobody", {
      method: "PUT",
      body: JSON.stringify({ description: "no body here" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
    const res2 = await app.request("/api/skill/9bad", {
      method: "PUT",
      body: JSON.stringify({ description: "d", body: "b" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res2.status).toBe(400);
  });

  test("GET /skill/usage aggregates recorded views (and never collides with /skill/:name)", async () => {
    // Record two views through the service (the tool's recording path).
    stack.core.putSkill("arxiv", { description: "d", body: "b" });
    stack.store.skillUsage.insert({ sessionId: undefined, skill: "arxiv", agent: "chat", ok: true, bytes: 10, now: "2026-09-08T10:00:00.000Z" });
    stack.store.skillUsage.insert({ sessionId: undefined, skill: "arxiv", agent: "chat", ok: true, bytes: 10, now: "2026-09-08T11:00:00.000Z" });

    const res = await app.request("/api/skill/usage");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      kpis: { views: number; errors: number; sessions: number };
      bySkill: { skill: string; views: number }[];
      series: { bucket: string; views: number }[];
    };
    expect(body.kpis.views).toBe(2);
    expect(body.bySkill[0]?.skill).toBe("arxiv");
    expect(body.series).toEqual([{ bucket: "2026-09-08", views: 2 }]);

    // The detail endpoint's usage totals ride the same store.
    const detail = await app.request("/api/skill/arxiv");
    const detailBody = (await detail.json()) as { usage: { views: number } };
    expect(detailBody.usage.views).toBe(2);
  });

  test("GET /skill/usage honors window filters", async () => {
    stack.store.skillUsage.insert({ skill: "a", ok: true, now: "2026-09-07T10:00:00.000Z" });
    stack.store.skillUsage.insert({ skill: "a", ok: true, now: "2026-09-08T10:00:00.000Z" });
    const res = await app.request("/api/skill/usage?from=2026-09-08T00:00:00.000Z&to=2026-09-09T00:00:00.000Z");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { kpis: { views: number } }).kpis.views).toBe(1);
  });

  test("POST /skill/learn spawns a visible learn session with the request as its first turn", async () => {
    const res = await app.request("/api/skill/learn", {
      method: "POST",
      body: JSON.stringify({ request: "the arXiv API at https://export.arxiv.org/api/query, focus on search" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(201);
    const { session } = (await res.json()) as { session: { id: string; title: string; meta: Record<string, unknown> } };
    // A real, visible session on the learn agent.
    expect(session.title.startsWith("Learn: ")).toBe(true);
    expect(session.meta.agent).toBe("learn");

    // The standards-guided learn request is the session's first user turn.
    const history = stack.core.history(session.id as never);
    const firstUser = history.find((m) => m.role === "user");
    const text = (firstUser?.parts ?? [])
      .filter((p) => p.kind === "text")
      .map((p) => (p.payload as { text?: string }).text ?? "")
      .join("");
    expect(text).toContain("[learn] The user wants you to learn a reusable skill");
    expect(text).toContain("focus on search");
  });

  test("POST /skill/learn pins the model when given; validates the body", async () => {
    const res = await app.request("/api/skill/learn", {
      method: "POST",
      body: JSON.stringify({ request: "learn x", model: "stub/echo" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(201);
    const { session } = (await res.json()) as { session: { meta: Record<string, unknown> } };
    expect(session.meta.model).toBe("stub/echo");

    // Empty request → 400 (the schema requires a non-empty request).
    const bad = await app.request("/api/skill/learn", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    });
    expect(bad.status).toBe(400);
  });

  test("linked-file endpoints: read, write, delete — with guards", async () => {
    stack.core.putSkill("book", { description: "A book skill.", body: "# Book" });

    // Write → read round-trip.
    const put = await app.request("/api/skill/book/file?path=references/ch01.md", {
      method: "PUT",
      body: JSON.stringify({ content: "# Chapter 1\n\nDistilled." }),
      headers: { "Content-Type": "application/json" },
    });
    expect(put.status).toBe(201);
    const get = await app.request("/api/skill/book/file?path=references/ch01.md");
    expect(get.status).toBe(200);
    expect(((await get.json()) as { content: string }).content).toBe("# Chapter 1\n\nDistilled.");
    // The registry's linkedFiles refreshed.
    expect(stack.core.getSkill("book")?.linkedFiles).toContain("references/ch01.md");

    // Delete → gone.
    const del = await app.request("/api/skill/book/file?path=references/ch01.md", { method: "DELETE" });
    expect(del.status).toBe(200);
    expect((await app.request("/api/skill/book/file?path=references/ch01.md")).status).toBe(400);

    // Guards: unknown skill → 404; traversal → 400.
    expect(
      (await app.request("/api/skill/ghost/file?path=references/x.md")).status,
    ).toBe(404);
    expect(
      (await app.request("/api/skill/book/file?path=../escape.md")).status,
    ).toBe(400);
    expect(
      (await app.request("/api/skill/book/file?path=notices/x.md")).status,
    ).toBe(400);
    // Missing path param → 400 (schema requires it).
    expect((await app.request("/api/skill/book/file")).status).toBe(400);
  });
});
