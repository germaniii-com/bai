import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createApp } from "../src";
import { makeStack, type TestStack } from "./harness";

/**
 * UI pagination routes: sessions (keyset cursor), skills (offset), the flat
 * model catalog, and the slim provider payload. Legacy no-limit reads stay
 * full so agent-adjacent callers are unaffected.
 */
describe("pagination routes", () => {
  let stack: TestStack;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    stack = makeStack();
    app = createApp(stack.deps);
  });

  afterEach(() => stack.cleanup());

  async function json<T>(path: string): Promise<T> {
    const res = await app.request(path);
    expect(res.status).toBe(200);
    return (await res.json()) as T;
  }

  test("GET /api/session pages with a cursor and returns hasMore", async () => {
    stack.core.createSession({ title: "One", workbench: "chat" });
    await new Promise((r) => setTimeout(r, 3));
    stack.core.createSession({ title: "Two", workbench: "chat" });
    await new Promise((r) => setTimeout(r, 3));
    const child = stack.core.createSession({ title: "Child", workbench: "chat", parent: stack.core.listSessions(1, 0)[0]!.id });

    const first = await json<{ sessions: { id: string; title: string }[]; hasMore: boolean; nextCursor?: string }>(
      "/api/session?limit=1&roots=1",
    );
    expect(first.sessions).toHaveLength(1);
    expect(first.sessions[0]!.title).toBe("Two");
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBeDefined();

    const second = await json<{ sessions: { id: string; title: string }[]; hasMore: boolean; nextCursor?: string }>(
      `/api/session?limit=1&roots=1&before=${encodeURIComponent(first.nextCursor!)}`,
    );
    expect(second.sessions.map((s) => s.title)).toEqual(["One"]);
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeUndefined();
    // Child sessions are excluded by roots=1.
    expect([...first.sessions, ...second.sessions].map((s) => s.id)).not.toContain(child.id);
  });

  test("GET /api/session rejects a malformed cursor", async () => {
    const res = await app.request("/api/session?before=not-a-cursor");
    expect(res.status).toBe(400);
  });

  test("GET /api/skill is full without limit and paged with one", async () => {
    stack.core.putSkill("alpha", { description: "A", body: "# a\n\nb" });
    stack.core.putSkill("bravo", { description: "B", body: "# b\n\nb" });

    const full = await json<{ skills: { name: string }[]; hasMore: boolean }>("/api/skill");
    expect(full.skills.map((s) => s.name)).toEqual(["alpha", "bravo"]);
    expect(full.hasMore).toBe(false);

    const page = await json<{ skills: { name: string }[]; hasMore: boolean; nextOffset?: number }>(
      "/api/skill?limit=1",
    );
    expect(page.skills.map((s) => s.name)).toEqual(["alpha"]);
    expect(page.hasMore).toBe(true);
    expect(page.nextOffset).toBe(1);
  });

  test("GET /api/model pages a scoped provider and supports q/id", async () => {
    // The built-in stub provider has two models even without an account.
    const all = await json<{ models: { id: string; providerName: string }[]; hasMore: boolean; nextOffset?: number }>(
      "/api/model?provider=stub&limit=1",
    );
    expect(all.models).toHaveLength(1);
    expect(all.models[0]!.providerName).toBe("stub");
    expect(all.hasMore).toBe(true);

    const rest = await json<{ models: { id: string }[] }>("/api/model?provider=stub&limit=1&offset=1");
    expect(rest.models).toHaveLength(1);
    expect(rest.models[0]!.id).not.toBe(all.models[0]!.id);

    const exact = await json<{ models: { id: string }[] }>("/api/model?id=stub/echo");
    expect(exact.models.map((m) => m.id)).toEqual(["stub/echo"]);

    const filtered = await json<{ models: { id: string }[] }>("/api/model?provider=stub&q=demo");
    expect(filtered.models.map((m) => m.id)).toEqual(["stub/fs-demo"]);
  });

  test("GET /api/provider?models=0 drops model arrays and reports modelCount", async () => {
    const slim = await json<{
      providers: { id: string; models: unknown[]; modelCount?: number }[];
    }>("/api/provider?models=0");
    const stub = slim.providers.find((p) => p.id === "stub");
    expect(stub).toBeDefined();
    expect(stub!.models).toEqual([]);
    expect(stub!.modelCount).toBe(2);
  });
});
