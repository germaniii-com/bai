import { useState } from "react";
import { Check, ChevronDown, ChevronRight, ListChecks, Plus, X } from "lucide-react";
import type { TodoItem } from "@bai/shared";

/**
 * The workspace right-rail checklist: the active session's task list (the
 * `todo` tool's `session.meta.todos`), now USER-EDITABLE — add, complete,
 * rename, and remove items. The whole list is sent on every change through
 * `onChange`; the server persists it and broadcasts a durable
 * `todos.updated` event, so the panel stays in sync with the agent and every
 * other surface. Collapsible, like the other rail panels.
 */
export function TodosPanel({
  todos,
  onChange,
  disabled = false,
}: {
  todos: TodoItem[];
  /** Replace the whole list (the caller persists + broadcasts). */
  onChange: (todos: TodoItem[]) => void;
  disabled?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [adding, setAdding] = useState("");
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const done = todos.filter((item) => item.status === "completed").length;

  const replace = (index: number, next: TodoItem): void => {
    onChange(todos.map((item, i) => (i === index ? next : item)));
  };

  const toggle = (index: number): void => {
    const item = todos[index];
    if (item === undefined) return;
    replace(index, { ...item, status: item.status === "completed" ? "pending" : "completed" });
  };

  const remove = (index: number): void => {
    onChange(todos.filter((_, i) => i !== index));
    if (editing === index) setEditing(null);
  };

  const commitEdit = (index: number): void => {
    const text = draft.trim();
    const item = todos[index];
    if (item !== undefined && text.length > 0 && text !== item.content) {
      replace(index, { ...item, content: text });
    }
    setEditing(null);
  };

  const add = (): void => {
    const text = adding.trim();
    if (text.length === 0) return;
    onChange([...todos, { content: text, status: "pending", priority: "medium" }]);
    setAdding("");
  };

  return (
    <aside className="todos-panel" role="region" aria-label="Session checklist">
      <button
        type="button"
        className="todos-head"
        aria-expanded={!collapsed}
        aria-controls="checklist-body"
        onClick={() => setCollapsed((c) => !c)}
      >
        <ListChecks size={14} aria-hidden="true" />
        <span>Checklist</span>
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
        <div id="checklist-body">
          {todos.length === 0 ? (
            <p className="dim todos-empty">No items yet.</p>
          ) : (
            <ul className="todos-list">
              {todos.map((item, index) => {
                const isDone = item.status === "completed";
                return (
                  <li
                    key={index}
                    className={`todo-item status-${item.status}${item.priority === "high" ? " prio-high" : ""}`}
                  >
                    <button
                      type="button"
                      className={isDone ? "todo-check checked" : "todo-check"}
                      role="checkbox"
                      aria-checked={isDone}
                      aria-label={isDone ? `Mark "${item.content}" not done` : `Mark "${item.content}" done`}
                      disabled={disabled}
                      onClick={() => toggle(index)}
                    >
                      {isDone && <Check size={12} aria-hidden="true" />}
                    </button>
                    {editing === index ? (
                      <input
                        className="todo-edit"
                        value={draft}
                        autoFocus
                        disabled={disabled}
                        onChange={(e) => setDraft(e.target.value)}
                        onBlur={() => commitEdit(index)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitEdit(index);
                          if (e.key === "Escape") setEditing(null);
                        }}
                        aria-label="Edit item"
                      />
                    ) : (
                      <button
                        type="button"
                        className="todo-content"
                        disabled={disabled}
                        title="Click to edit"
                        onClick={() => {
                          setEditing(index);
                          setDraft(item.content);
                        }}
                      >
                        {item.content}
                      </button>
                    )}
                    <button
                      type="button"
                      className="todo-remove"
                      aria-label={`Remove "${item.content}"`}
                      disabled={disabled}
                      onClick={() => remove(index)}
                    >
                      <X size={12} aria-hidden="true" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="todos-add-row">
            <input
              className="todos-add"
              value={adding}
              disabled={disabled}
              placeholder="Add item…"
              aria-label="Add checklist item"
              onChange={(e) => setAdding(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  add();
                }
              }}
            />
            <button
              type="button"
              className="todos-add-btn"
              aria-label="Add item"
              disabled={disabled || adding.trim().length === 0}
              onClick={add}
            >
              <Plus size={14} aria-hidden="true" />
            </button>
          </div>
        </div>
      )}
    </aside>
  );
}
