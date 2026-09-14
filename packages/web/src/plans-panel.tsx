import { useState } from "react";
import { ChevronDown, ChevronRight, FileText, Plus, Trash2 } from "lucide-react";
import { isValidAgentName, type PlanFile } from "@bai/shared";

/**
 * The workspace right-rail Plans panel: the active session's plan files
 * (written by the `plan` agent's `plan.write` tool or here). Clicking a plan
 * opens it in the center Files view as an editable editor; the panel also
 * creates (`+ New plan`) and deletes plans. Metadata rides the durable
 * `plans.updated` event; the file content is fetched by the editor. Collapsible.
 */
export function PlansPanel({
  plans,
  activePlan,
  disabled = false,
  onOpen,
  onCreate,
  onDelete,
}: {
  plans: PlanFile[];
  activePlan: string | null;
  disabled?: boolean;
  onOpen: (name: string) => void;
  /** Persist a new plan (App validates + writes); resolves after the write. */
  onCreate: (name: string) => Promise<void>;
  onDelete: (name: string) => Promise<void>;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);

  const existing = new Set(plans.map((p) => p.name));

  const create = async (): Promise<void> => {
    const trimmed = name.trim();
    if (!isValidAgentName(trimmed)) {
      setError("Use a letter first, then letters/digits/-/_ (max 64).");
      return;
    }
    if (existing.has(trimmed)) {
      setError(`"${trimmed}" already exists.`);
      return;
    }
    setBusy(true);
    try {
      await onCreate(trimmed);
      setName("");
      setCreating(false);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (plan: string): Promise<void> => {
    if (confirming !== plan) {
      setConfirming(plan);
      return;
    }
    setBusy(true);
    try {
      await onDelete(plan);
      setConfirming(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="todos-panel plans-panel" role="region" aria-label="Session plans">
      <button
        type="button"
        className="todos-head"
        aria-expanded={!collapsed}
        aria-controls="plans-body"
        onClick={() => setCollapsed((c) => !c)}
      >
        <FileText size={14} aria-hidden="true" />
        <span>Plans</span>
        {plans.length > 0 && <span className="todos-count">{plans.length}</span>}
        <span className="todos-chevron" aria-hidden="true">
          {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        </span>
      </button>
      {!collapsed && (
        <div id="plans-body">
          {creating ? (
            <form
              className="plan-new-form"
              onSubmit={(e) => {
                e.preventDefault();
                void create();
              }}
            >
              <input
                className="todos-add"
                value={name}
                autoFocus
                disabled={busy}
                placeholder="plan-name"
                aria-label="New plan name"
                maxLength={64}
                spellCheck={false}
                onChange={(e) => {
                  setName(e.target.value);
                  setError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setCreating(false);
                    setError(null);
                  }
                }}
              />
              <button type="submit" className="todos-add-btn" disabled={busy} aria-label="Create plan">
                <Plus size={14} aria-hidden="true" />
              </button>
            </form>
          ) : (
            <button type="button" className="new-session plan-new-btn" disabled={disabled} onClick={() => setCreating(true)}>
              + New plan
            </button>
          )}
          {error !== null && <div className="error plan-error">{error}</div>}
          {plans.length === 0 ? (
            <p className="dim todos-empty">No plans yet.</p>
          ) : (
            <ul className="todos-list">
              {plans.map((plan) => (
                <li key={plan.name} className={activePlan === plan.name ? "plan-row active" : "plan-row"}>
                  <button
                    type="button"
                    className="plan-open"
                    disabled={disabled}
                    title={`Open ${plan.name}`}
                    onClick={() => onOpen(plan.name)}
                  >
                    <FileText size={13} aria-hidden="true" />
                    <span className="plan-name">{plan.name}</span>
                    <span className="plan-date">{shortDate(plan.updatedAt)}</span>
                  </button>
                  <button
                    type="button"
                    className={confirming === plan.name ? "todo-remove confirming" : "todo-remove"}
                    aria-label={confirming === plan.name ? `Confirm delete ${plan.name}` : `Delete ${plan.name}`}
                    disabled={disabled || busy}
                    onClick={() => void remove(plan.name)}
                    onBlur={() => setConfirming((c) => (c === plan.name ? null : c))}
                  >
                    <Trash2 size={12} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </aside>
  );
}

function shortDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
