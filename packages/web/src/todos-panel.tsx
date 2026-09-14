import { useState } from "react";
import { ChevronDown, ChevronRight, Circle, CircleCheck, CircleDot, CircleX, ListTodo } from "lucide-react";
import type { TodoItem } from "@bai/shared";

/** Status → icon (lucide 1.x names). */
const STATUS_ICON = {
  completed: CircleCheck,
  in_progress: CircleDot,
  cancelled: CircleX,
  pending: Circle,
} as const;

/**
 * The workspace right-rail todo panel: the active session's agent-maintained
 * task list (the `todo` tool, `session.meta.todos`, kept live by durable
 * `todos.updated` events). Read-only — the agent owns the list. Rendered
 * below the file tree in the workspace section only (never in chat).
 */
export function TodosPanel({ todos }: { todos: TodoItem[] }) {
  const [collapsed, setCollapsed] = useState(false);
  const done = todos.filter((item) => item.status === "completed").length;
  return (
    <aside className="todos-panel" role="region" aria-label="Session todos">
      <button
        type="button"
        className="todos-head"
        aria-expanded={!collapsed}
        aria-controls="todos-body"
        onClick={() => setCollapsed((c) => !c)}
      >
        <ListTodo size={14} aria-hidden="true" />
        <span>Todos</span>
        {todos.length > 0 && (
          <span className="todos-count" aria-label={`${done} of ${todos.length} done`}>
            {done}/{todos.length}
          </span>
        )}
        <span className="todos-chevron" aria-hidden="true">
          {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        </span>
      </button>
      {!collapsed && (
        <div id="todos-body">
          {todos.length === 0 ? (
            <p className="dim todos-empty">No todos yet.</p>
          ) : (
            <ul className="todos-list">
              {todos.map((item, index) => {
                const Icon = STATUS_ICON[item.status] ?? Circle;
                return (
                  <li
                    key={`${index}-${item.content}`}
                    className={`todo-item status-${item.status}${item.priority === "high" ? " prio-high" : ""}`}
                  >
                    <Icon className="todo-icon" size={14} aria-hidden="true" />
                    <span className="todo-content">{item.content}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </aside>
  );
}
