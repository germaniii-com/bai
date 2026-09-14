import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId, type Event, type SessionId } from "@bai/shared";
import {
  deletePlan,
  listPlans,
  readNotes,
  readPlan,
  writeNotes,
  writePlan,
} from "../src/session-files";
import { makeCore, waitForEvent, type TestCore } from "./harness";

describe("session files (plans & notes)", () => {
  let dir: string;
  const sessionId = newId.session();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bai-sessfiles-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("plans round-trip: write, list, read, replace, delete", () => {
    expect(listPlans(dir, sessionId)).toEqual([]);

    writePlan(dir, sessionId, "refactor", "# Refactor");
    writePlan(dir, sessionId, "research", "# Research");

    const plans = listPlans(dir, sessionId);
    expect(plans.map((p) => p.name)).toEqual(["refactor", "research"]);
    expect(plans[0]?.bytes).toBeGreaterThan(0);
    expect(plans[0]?.updatedAt).toMatch(/T/);

    expect(readPlan(dir, sessionId, "refactor")).toBe("# Refactor");
    writePlan(dir, sessionId, "refactor", "# Refactor v2");
    expect(readPlan(dir, sessionId, "refactor")).toBe("# Refactor v2");

    expect(deletePlan(dir, sessionId, "research")).toBe(true);
    expect(deletePlan(dir, sessionId, "research")).toBe(false);
    expect(readPlan(dir, sessionId, "research")).toBeUndefined();
  });

  test("rejects invalid session ids and plan names (no traversal)", () => {
    expect(() => listPlans(dir, "not-a-session")).toThrow(/Invalid session id/);
    expect(() => readPlan(dir, sessionId, "../escape")).toThrow(/Plan names/);
    expect(() => writePlan(dir, sessionId, "bad name", "x")).toThrow(/Plan names/);
    expect(() => writePlan(dir, sessionId, "..", "x")).toThrow(/Plan names/);
    expect(existsSync(join(dir, "escape.md"))).toBe(false);
  });

  test("notes round-trip and clear", () => {
    expect(readNotes(dir, sessionId)).toBeNull();
    writeNotes(dir, sessionId, "# Notes\nhello");
    expect(readNotes(dir, sessionId)).toContain("hello");
    writeNotes(dir, sessionId, "");
    expect(readNotes(dir, sessionId)).toBe("");
    expect(existsSync(join(dir, sessionId, "notes.md"))).toBe(true);
  });
});

describe("Service session files + editable todos", () => {
  let t: TestCore;

  beforeEach(() => {
    t = makeCore();
  });
  afterEach(() => {
    t.core.questions.stop();
    t.store.close();
    rmSync(t.dir, { recursive: true, force: true });
  });

  test("writePlan/writeNotes broadcast durable events and read back", async () => {
    const session = t.core.createSession({ workbench: "code" });

    const planEvent = waitForEvent(t.bus, "plans.updated");
    t.core.writePlan(session.id, "p1", "# P1");
    const plans = (await planEvent) as Event<"plans.updated">;
    expect(plans.payload.plans.map((p) => p.name)).toEqual(["p1"]);
    expect(t.core.readPlan(session.id, "p1")).toBe("# P1");

    const deleteEvent = waitForEvent(t.bus, "plans.updated");
    expect(t.core.deletePlan(session.id, "p1")).toBe(true);
    expect(((await deleteEvent) as Event<"plans.updated">).payload.plans).toEqual([]);

    const notesEvent = waitForEvent(t.bus, "notes.updated");
    t.core.writeNotes(session.id, "hello notes");
    expect(((await notesEvent) as Event<"notes.updated">).payload.notes).toBe("hello notes");
    expect(t.core.readNotes(session.id)).toBe("hello notes");

    expect(() => t.core.listPlans(newId.session())).toThrow(/Unknown session/);
    expect(() => t.core.writeNotes(newId.session(), "x")).toThrow(/Unknown session/);
  });

  test("setTodos persists to session.meta and emits todos.updated (the web editor path)", async () => {
    const session = t.core.createSession({ workbench: "code" });
    const list = [
      { content: "first", status: "completed" as const, priority: "high" as const },
      { content: "second", status: "pending" as const, priority: "medium" as const },
    ];
    const event = waitForEvent(t.bus, "todos.updated");
    t.core.setTodos(session.id as SessionId, list);
    expect(((await event) as Event<"todos.updated">).payload.todos).toEqual(list);
    expect(t.core.readTodos(session.id)).toEqual(list);
    const meta = t.core.getSession(session.id)?.meta as { todos?: unknown };
    expect(meta.todos).toEqual(list);
  });
});
