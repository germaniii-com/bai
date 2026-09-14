import type { SessionId, TodoItem } from "@bai/shared";
import type { Tool, ToolContext, ToolResult } from "./registry";

/**
 * todo — maintain the session task list (opencode's todowrite). The list
 * replaces the previous one each call and persists in `session.meta.todos`
 * via `setTodos`; every change emits a durable `todos.updated` event so
 * surfaces (the web Checklist panel included) render progress live.
 * Statuses: pending → in_progress → completed (or cancelled).
 *
 * Omitting `todos` READS the current list without changing it — the agent's
 * read half of the checklist (the durable web editor can change the list
 * under it, so the tool call history alone is not authoritative).
 */
export function todoTool(deps: {
  readTodos: (sessionId: SessionId) => TodoItem[];
  setTodos: (sessionId: SessionId, todos: TodoItem[]) => TodoItem[];
}): Tool {
  return {
    name: "todo",
    origin: "builtin",
    description:
      "Write the session task list. Use for multi-step work: plan the steps first, keep exactly ONE item in_progress " +
      "while working, and mark items completed as you finish them. The list REPLACES the previous one each call, so " +
      "always send the full list. Omit `todos` to READ the current list without changing it " +
      "(the user can edit it from the UI). Items: {content, status: pending|in_progress|completed|cancelled, priority: high|medium|low}.",
    schema: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          description: "The complete task list (replaces the previous list); omit to read the current list",
          maxItems: 50,
          items: {
            type: "object",
            properties: {
              content: { type: "string", description: "What needs to be done (imperative, specific)" },
              status: { type: "string", enum: ["pending", "in_progress", "completed", "cancelled"], description: "Item state" },
              priority: { type: "string", enum: ["high", "medium", "low"], description: "Relative importance" },
            },
            required: ["content", "status", "priority"],
          },
        },
      },
      required: [],
    },
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const sessionId = ctx.sessionId as SessionId;
      const { todos } = (args ?? {}) as { todos?: unknown };
      if (todos === undefined) {
        const current = deps.readTodos(sessionId);
        return {
          content:
            current.length === 0
              ? "The session task list is empty."
              : `Current task list (${current.length} item${current.length === 1 ? "" : "s"}):\n` +
                current.map((t) => `- [${t.status}] ${t.content} (${t.priority})`).join("\n"),
          meta: { todos: current, title: "Read todo list" },
        };
      }
      if (!Array.isArray(todos)) throw new Error("todos must be an array");

      const list: TodoItem[] = todos.slice(0, 50).map((t, i) => {
        if (typeof t?.content !== "string" || t.content.trim().length === 0) {
          throw new Error(`todos[${i}].content must be a non-empty string`);
        }
        const status = ["pending", "in_progress", "completed", "cancelled"].includes(t.status) ? t.status : "pending";
        const priority = ["high", "medium", "low"].includes(t.priority) ? t.priority : "medium";
        return { content: t.content.trim(), status, priority } as TodoItem;
      });

      deps.setTodos(sessionId, list);

      const counts = {
        completed: list.filter((t) => t.status === "completed").length,
        in_progress: list.filter((t) => t.status === "in_progress").length,
        pending: list.filter((t) => t.status === "pending").length,
        cancelled: list.filter((t) => t.status === "cancelled").length,
      };
      return {
        content:
          `Todo list updated (${list.length} item${list.length === 1 ? "" : "s"}: ` +
          `${counts.completed} completed, ${counts.in_progress} in progress, ${counts.pending} pending` +
          `${counts.cancelled > 0 ? `, ${counts.cancelled} cancelled` : ""}).`,
        meta: { todos: list, title: "Updated todo list" },
      };
    },
  };
}
