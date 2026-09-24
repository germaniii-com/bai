import { useState } from "react";
import { ListChecks, Plus, X } from "lucide-react";
import type { TodoItem } from "@bai/shared";
import { shouldAutoFocus } from "./pointer";
import { Checkbox, ConfirmDialog, Disclosure, IconButton, TextInput, usePersistentDisclosure } from "./components";

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
  const [panelOpen, setPanelOpen] = usePersistentDisclosure("bai.wsPanel.checklist");
  const [adding, setAdding] = useState("");
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [pendingRemove, setPendingRemove] = useState<number | null>(null);
  const done = todos.filter((item) => item.status === "completed").length;
  const pendingItem = pendingRemove !== null ? todos[pendingRemove] : undefined;

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
      <Disclosure
        variant="panel"
        icon={<ListChecks size={14} />}
        title="Checklist"
        id="checklist-body"
        open={panelOpen}
        onOpenChange={setPanelOpen}
        count={
          todos.length > 0 ? (
            <span aria-label={`${done} of ${todos.length} done`}>
              {done}/{todos.length}
            </span>
          ) : undefined
        }
      >
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
                  <Checkbox
                    checked={isDone}
                    aria-label={isDone ? `Mark "${item.content}" not done` : `Mark "${item.content}" done`}
                    disabled={disabled}
                    onChange={() => toggle(index)}
                  />
                  {editing === index ? (
                    <TextInput
                      className="todo-edit"
                      value={draft}
                      autoFocus={shouldAutoFocus()}
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
                    // @ui-raw: click-to-edit inline text control; a Button centers
                    // and pads the row, which breaks the checklist layout.
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
                  <IconButton
                    label={`Remove "${item.content}"`}
                    className="todo-remove"
                    disabled={disabled}
                    onClick={() => setPendingRemove(index)}
                  >
                    <X size={12} aria-hidden="true" />
                  </IconButton>
                </li>
              );
            })}
          </ul>
        )}
        <div className="todos-add-row">
          <TextInput
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
          <IconButton
            label="Add item"
            className="todos-add-btn"
            disabled={disabled || adding.trim().length === 0}
            onClick={add}
          >
            <Plus size={14} aria-hidden="true" />
          </IconButton>
        </div>
      </Disclosure>
      <ConfirmDialog
        open={pendingRemove !== null}
        title="Remove item?"
        body={
          pendingItem !== undefined
            ? <>Remove "{pendingItem.content}" from the checklist?</>
            : "Remove this item from the checklist?"
        }
        confirmLabel="Remove"
        onCancel={() => setPendingRemove(null)}
        onConfirm={() => {
          const index = pendingRemove;
          setPendingRemove(null);
          if (index !== null) remove(index);
        }}
      />
    </aside>
  );
}
