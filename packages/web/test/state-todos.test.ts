import { describe, expect, test } from "bun:test";
import type { Event, Session, TodoItem } from "@bai/shared";
import { applyTodosEvent, todosFromSession } from "../src/state";

/** Build a minimal typed event without the discriminated-union ceremony. */
const evt = (type: string, payload: unknown, sessionId?: string): Event =>
  ({ seq: 1, type, ts: "t", payload, ...(sessionId !== undefined ? { sessionId } : {}) }) as unknown as Event;

describe("todos reducer (applyTodosEvent)", () => {
  test("todos.updated replaces the list wholesale (the tool always sends all items)", () => {
    const first: TodoItem[] = [{ content: "one", status: "pending", priority: "high" }];
    const next: TodoItem[] = [
      { content: "one", status: "completed", priority: "high" },
      { content: "two", status: "in_progress", priority: "medium" },
    ];
    expect(applyTodosEvent(first, evt("todos.updated", { todos: next }, "ses_1"))).toEqual(next);
  });

  test("other events pass the list through by reference", () => {
    const list: TodoItem[] = [{ content: "one", status: "pending", priority: "low" }];
    expect(applyTodosEvent(list, evt("run.started", {}))).toBe(list);
  });
});

describe("todosFromSession", () => {
  test("reads meta.todos safely across shapes", () => {
    const todos: TodoItem[] = [{ content: "x", status: "pending", priority: "low" }];
    expect(todosFromSession({ meta: { todos } } as unknown as Session)).toEqual(todos);
    expect(todosFromSession({ meta: {} } as unknown as Session)).toEqual([]);
    expect(todosFromSession({ meta: { todos: "nope" } } as unknown as Session)).toEqual([]);
    expect(todosFromSession(null)).toEqual([]);
  });
});
