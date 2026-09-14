import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { SessionsCursor } from "@bai/shared";
import { decodeCursor } from "../src";
import { makeCore, sleep, type TestCore } from "./harness";

/**
 * Keyset-paged session lists (UI paging): newest-first, stable under live
 * reordering, with a cursor that walks back without gaps or duplicates.
 * Filtering (`q`, `roots`, workbench/cwd) applies on every page.
 */
describe("SessionsRepo.listPage", () => {
  let t: TestCore;

  beforeEach(() => {
    t = makeCore();
  });

  afterEach(() => {
    t.store.close();
  });

  test("pages newest-first with a stable cursor and no gaps or duplicates", async () => {
    const made = [];
    for (let i = 0; i < 5; i++) {
      made.push(t.core.createSession({ title: `Chat ${i}` }));
      // Distinct updated_at values so the ordering is deterministic (the
      // cursor tiebreak on id only kicks in within the same millisecond).
      await sleep(3);
    }

    const first = t.core.listSessionsPage(2);
    expect(first.sessions.map((s) => s.id)).toEqual([made[4]!.id, made[3]!.id]);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBeDefined();
    expect(first.total).toBe(5);

    const cursor1 = decodeCursor<SessionsCursor>(first.nextCursor!)!;
    const second = t.core.listSessionsPage(2, cursor1);
    expect(second.sessions.map((s) => s.id)).toEqual([made[2]!.id, made[1]!.id]);
    expect(second.hasMore).toBe(true);

    const cursor2 = decodeCursor<SessionsCursor>(second.nextCursor!)!;
    const third = t.core.listSessionsPage(2, cursor2);
    expect(third.sessions.map((s) => s.id)).toEqual([made[0]!.id]);
    expect(third.hasMore).toBe(false);
    expect(third.nextCursor).toBeUndefined();

    // No duplicates / no dropped rows across the whole walk.
    const seen = [...first.sessions, ...second.sessions, ...third.sessions].map((s) => s.id);
    expect(new Set(seen).size).toBe(5);
  });

  test("filters: roots excludes children, q matches title/id, workbench/cwd scope", () => {
    const parent = t.core.createSession({ title: "Parent chat", workbench: "chat" });
    const child = t.core.createSession({ title: "Child run", workbench: "chat", parent: parent.id });
    t.core.createSession({ title: "Code thing", workbench: "code", cwd: "/tmp/ws" });

    // roots=1 drops the child session.
    const roots = t.core.listSessionsPage(10, undefined, { roots: true });
    expect(roots.sessions.map((s) => s.id)).not.toContain(child.id);
    expect(roots.sessions).toHaveLength(2);

    // q is a case-insensitive substring over title.
    const byTitle = t.core.listSessionsPage(10, undefined, { q: "code thing" });
    expect(byTitle.sessions.map((s) => s.title)).toEqual(["Code thing"]);

    // q matches the id too.
    const byId = t.core.listSessionsPage(10, undefined, { q: parent.id });
    expect(byId.sessions.map((s) => s.id)).toEqual([parent.id]);

    // workbench + cwd equality filters.
    expect(t.core.listSessionsPage(10, undefined, { workbench: "code" }).sessions).toHaveLength(1);
    expect(t.core.listSessionsPage(10, undefined, { cwd: "/tmp/ws" }).sessions).toHaveLength(1);
    expect(t.core.listSessionsPage(10, undefined, { cwd: "/tmp/none" }).sessions).toHaveLength(0);
  });

  test("archived sessions stay hidden from paged lists", () => {
    const s = t.core.createSession({ title: "Archive me" });
    t.core.archiveSession(s.id);
    expect(t.core.listSessionsPage(10).sessions).toHaveLength(0);
  });
});
