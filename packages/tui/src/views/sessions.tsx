import type { Session } from "@bai/shared";
import { SelectDialog } from "../components/dialog";
import type { AskIndex } from "../state/asks";

/**
 * Session picker dialog — a SelectDialog over the session list, so
 * it behaves exactly like the provider/model pickers:
 *
 *   - type-to-filter SEARCH (matches title or id)
 *   - ctrl+j/ctrl+k (or ↑/↓) navigate, enter opens, esc closes
 *   - n starts a new draft session (when the filter is empty)
 *   - long lists scroll in a sliding window around the cursor
 *   - the cursor seeds on the active session, marked with a green ✓
 *   - sessions with pending asks carry a yellow `△ N` badge (the run is
 *     blocked until someone answers — visible before you even open it)
 */
export function SessionsView({
  sessions,
  activeId,
  askIndex,
  onPick,
  onNew,
  onDone,
  windowSize,
  onQueryChange,
  onLoadMore,
  hasMore = false,
  loadingMore = false,
  total,
}: {
  sessions: Session[];
  /** Currently open session — marked and pre-selected in the list. */
  activeId?: string;
  /** Global pending-ask counts (session id → count; state/asks.ts). */
  askIndex?: AskIndex;
  onPick: (session: Session) => void;
  /** "n": draft state — no session exists until the first message is sent. */
  onNew: () => void;
  /** esc — close the dialog. */
  onDone: () => void;
  /** Sliding-window size (overlay height cap). */
  windowSize?: number;
  /** Server-side filter (paged list: matches sessions beyond the page). */
  onQueryChange?: (query: string) => void;
  /** Fetch the next page (fires as the highlight nears the loaded end). */
  onLoadMore?: () => void;
  /** Older pages exist after the loaded window. */
  hasMore?: boolean;
  /** A page fetch is in flight. */
  loadingMore?: boolean;
  /** Total sessions matching the filter across all pages (server `total`). */
  total?: number;
}) {
  const options = sessions.map((s) => {
    const asks = askIndex?.get(s.id) ?? 0;
    return {
      value: s.id,
      label: s.title.length > 0 ? s.title : "(untitled)",
      hint: `${s.workbench} · ${s.id}`,
      ...(s.id === activeId ? { gutter: "✓" } : {}),
      ...(asks > 0 ? { badge: `△ ${asks}` } : {}),
    };
  });
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
      windowSize={windowSize}
      {...(onQueryChange !== undefined ? { onQueryChange } : {})}
      {...(onLoadMore !== undefined ? { onLoadMore } : {})}
      hasMore={hasMore}
      loadingMore={loadingMore}
      {...(total !== undefined ? { total } : {})}
      actions={[{ key: "n", label: "new", onAction: () => onNew() }]}
      onPick={(id) => {
        const picked = sessions.find((s) => s.id === id);
        if (picked !== undefined) onPick(picked);
      }}
      onClose={onDone}
    />
  );
}
