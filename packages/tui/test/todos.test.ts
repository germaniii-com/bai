import { describe, expect, test } from "bun:test";
import type { Event, Session, TodoItem } from "@bai/shared";
import { applyTodoEvent, todosFromMeta } from "../src/state/sync";

/** Build a minimal typed event without the discriminated-union ceremony. */
const evt = (type: string, payload: unknown): Event => ({ seq: 1, ts: "t", type, payload }) as unknown as Event;

describe("todosFromMeta", () => {
  test("reads meta.todos safely across shapes", () => {
    const todos: TodoItem[] = [{ content: "x", status: "pending", priority: "low" }];
    expect(todosFromMeta({ meta: { todos } } as unknown as Session)).toEqual(todos);
    expect(todosFromMeta({ meta: {} } as unknown as Session)).toEqual([]);
    expect(todosFromMeta({ meta: { todos: "nope" } } as unknown as Session)).toEqual([]);
    expect(todosFromMeta(null)).toEqual([]);
  });
});

describe("applyTodoEvent", () => {
  test("todos.updated replaces the list wholesale", () => {
    const next: TodoItem[] = [
      { content: "a", status: "in_progress", priority: "high" },
      { content: "b", status: "pending", priority: "low" },
    ];
    expect(applyTodoEvent([], evt("todos.updated", { todos: next }))).toEqual(next);
  });

  test("other events pass the list through by reference", () => {
    const list: TodoItem[] = [{ content: "a", status: "pending", priority: "low" }];
    expect(applyTodoEvent(list, evt("run.started", {}))).toBe(list);
  });
});
