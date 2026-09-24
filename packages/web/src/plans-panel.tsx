import { useState } from "react";
import { FileText, Hammer, Plus, Trash2 } from "lucide-react";
import { isValidAgentName, type PlanFile } from "@bai/shared";
import { shouldAutoFocus } from "./pointer";
import { ConfirmDialog, Disclosure, IconButton, ListItem, SubNavCreate, TextInput, usePersistentDisclosure } from "./components";

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
  onBuild,
}: {
  plans: PlanFile[];
  activePlan: string | null;
  disabled?: boolean;
  onOpen: (name: string) => void;
  /** Persist a new plan (App validates + writes); resolves after the write. */
  onCreate: (name: string) => Promise<void>;
  onDelete: (name: string) => Promise<void>;
  /** Hand the plan to the build agent to implement (App switches + prompts). */
  onBuild: (name: string) => void;
}) {
  const [panelOpen, setPanelOpen] = usePersistentDisclosure("bai.wsPanel.plans");
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

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

  const confirmDelete = async (): Promise<void> => {
    const plan = pendingDelete;
    setPendingDelete(null);
    if (plan === null) return;
    setBusy(true);
    try {
      await onDelete(plan);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="todos-panel plans-panel" role="region" aria-label="Session plans">
      <Disclosure
        variant="panel"
        icon={<FileText size={14} />}
        title="Plans"
        id="plans-body"
        open={panelOpen}
        onOpenChange={setPanelOpen}
        count={plans.length > 0 ? plans.length : undefined}
      >
        {creating ? (
          <form
            className="plan-new-form"
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <TextInput
              className="todos-add"
              value={name}
              autoFocus={shouldAutoFocus()}
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
            <IconButton type="submit" className="todos-add-btn" disabled={busy} label="Create plan">
              <Plus size={14} aria-hidden="true" />
            </IconButton>
          </form>
        ) : (
          <SubNavCreate
            className="plan-new-btn"
            label="+ New plan"
            disabled={disabled}
            onClick={() => setCreating(true)}
          />
        )}
        {error !== null && <div className="error plan-error">{error}</div>}
        {plans.length === 0 ? (
          <p className="dim todos-empty">No plans yet.</p>
        ) : (
          <ul className="todos-list">
            {plans.map((plan) => (
              <li key={plan.name}>
                <ListItem
                  inline
                  icon={<FileText size={13} aria-hidden="true" />}
                  title={plan.name}
                  selected={activePlan === plan.name}
                  disabled={disabled}
                  onClick={() => onOpen(plan.name)}
                  hint={`Open ${plan.name}`}
                  className="plan-row"
                  trailing={
                    <>
                      <span className="plan-date">{shortDate(plan.updatedAt)}</span>
                      <IconButton
                        className="plan-build"
                        label={`Build ${plan.name}`}
                        hint={`Build "${plan.name}" with the build agent`}
                        disabled={disabled || busy}
                        onClick={(e) => {
                          e.stopPropagation();
                          onBuild(plan.name);
                        }}
                      >
                        <Hammer size={12} aria-hidden="true" />
                      </IconButton>
                      <IconButton
                        className="todo-remove"
                        label={`Delete ${plan.name}`}
                        hint={`Delete ${plan.name}`}
                        disabled={disabled || busy}
                        onClick={(e) => {
                          e.stopPropagation();
                          setPendingDelete(plan.name);
                        }}
                      >
                        <Trash2 size={12} aria-hidden="true" />
                      </IconButton>
                    </>
                  }
                />
              </li>
            ))}
          </ul>
        )}
      </Disclosure>
      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete plan?"
        body={
          pendingDelete !== null
            ? <>Delete "{pendingDelete}"? This cannot be undone.</>
            : "Delete this plan?"
        }
        confirmLabel="Delete"
        busy={busy}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => void confirmDelete()}
      />
    </aside>
  );
}

function shortDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
