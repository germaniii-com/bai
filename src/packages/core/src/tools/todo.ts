import type { TodoItem } from "@bai/shared";
import type { Tool, ToolContext, ToolResult } from "./registry";
import type { Store } from "../store/store";
import type { Bus } from "../event/bus";
import type { EventLog } from "../event/log";
import type { Clock } from "@bai/shared";

/**
 * todo — maintain the session task list for multi-step work (opencode's
 * todowrite). The list replaces the previous one each call and persists in
 * `session.meta.todos`; every change emits a durable `todos.updated` event
 * so surfaces can render progress live. Statuses: pending → in_progress →
 * completed (or cancelled).
 */
export function todoTool(deps: { store: Store; bus: Bus; log: EventLog; clock: Clock }): Tool {
  return {
    name: "todo",
    origin: "builtin",
    description:
      "Write the session task list. Use for multi-step work: plan the steps first, keep exactly ONE item in_progress " +
      "while working, and mark items completed as you finish them. The list REPLACES the previous one each call, so " +
      "always send the full list. Items: {content, status: pending|in_progress|completed|cancelled, priority: high|medium|low}.",
    schema: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          description: "The complete task list (replaces the previous list)",
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
      required: ["todos"],
    },
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const { todos } = args as { todos?: TodoItem[] };
      if (!Array.isArray(todos)) throw new Error("todos must be an array");
      const session = deps.store.sessions.get(ctx.sessionId);
      if (session === undefined) throw new Error(`Unknown session: ${ctx.sessionId}`);

      const list: TodoItem[] = todos.slice(0, 50).map((t, i) => {
        if (typeof t?.content !== "string" || t.content.trim().length === 0) {
          throw new Error(`todos[${i}].content must be a non-empty string`);
        }
        const status = ["pending", "in_progress", "completed", "cancelled"].includes(t.status) ? t.status : "pending";
        const priority = ["high", "medium", "low"].includes(t.priority) ? t.priority : "medium";
        return { content: t.content.trim(), status, priority } as TodoItem;
      });

      const meta = { ...(session.meta as Record<string, unknown>), todos: list };
      deps.store.sessions.update(ctx.sessionId, { meta, now: deps.clock.iso() });
      const evt = deps.log.append(ctx.sessionId, "todos.updated", { todos: list }, deps.clock.iso());
      deps.bus.publish(evt);

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
