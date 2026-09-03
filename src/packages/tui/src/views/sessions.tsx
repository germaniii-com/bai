import type { Session } from "@bai/shared";
import { SelectDialog } from "../components/dialog";

/**
 * Session picker dialog (ctrl+s) — a SelectDialog over the session list, so
 * it behaves exactly like the provider/model pickers:
 *
 *   - type-to-filter SEARCH (matches title or id)
 *   - ctrl+j/ctrl+k (or ↑/↓) navigate, enter opens, esc closes
 *   - n starts a new draft session (when the filter is empty)
 *   - long lists scroll in a sliding window around the cursor
 *   - the cursor seeds on the active session, marked with a green ✓
 */
export function SessionsView({
  sessions,
  activeId,
  onPick,
  onNew,
  onDone,
}: {
  sessions: Session[];
  /** Currently open session — marked and pre-selected in the list. */
  activeId?: string;
  onPick: (session: Session) => void;
  /** "n": draft state — no session exists until the first message is sent. */
  onNew: () => void;
  /** esc — close the dialog. */
  onDone: () => void;
}) {
  const options = sessions.map((s) => ({
    value: s.id,
    label: s.title.length > 0 ? s.title : "(untitled)",
    hint: `${s.meta.parent !== undefined ? "subagent · " : ""}${s.workbench} · ${s.id}`,
    ...(s.id === activeId ? { gutter: "✓" } : {}),
  }));
  // Seed the cursor on the active session (findIndex → -1 with no active
  // session clamps to the top).
  const initialIndex = Math.max(
    0,
    sessions.findIndex((s) => s.id === activeId),
  );

  return (
    <SelectDialog
      title="sessions"
      options={options}
      initialIndex={initialIndex}
      emptyHint="none yet — ctrl+n to start one"
      actions={[{ key: "n", label: "new", onAction: () => onNew() }]}
      onPick={(id) => {
        const picked = sessions.find((s) => s.id === id);
        if (picked !== undefined) onPick(picked);
      }}
      onClose={onDone}
    />
  );
}
