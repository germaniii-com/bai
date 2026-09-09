import { useEffect, useState } from "react";
import { Archive, Folder, RotateCcw, Trash2 } from "lucide-react";
import type { BaiClient } from "@bai/api/client";
import { AddWorkspaceModal } from "./add-workspace-modal";
import { ListItem, SubNavCreate } from "./components";
import { Button, Modal } from "./components";

/**
 * Workspace nested-sidebar list with an Active | Archived selector:
 *
 * - ACTIVE: registered workspace folder paths (from config.workspaces) +
 *   the "+ Add a Workspace" button (path input, two-column folder explorer,
 *   create-if-missing — see add-workspace-modal.tsx). Each row carries a
 *   trailing ✕ → confirm modal → archive the workspace (unregister + hide
 *   its sessions; the folder on disk is never touched).
 * - ARCHIVED: removed workspaces (config.archivedWorkspaces), no add
 *   button, each row with a trailing ↩ Restore (non-destructive — the
 *   workspace AND its sessions come back).
 *
 * Display name is the path's basename; the full path rides as the dim
 * subtitle.
 */
export function WorkspaceNav({
  client,
  workspaces,
  archivedWorkspaces,
  selected,
  onSelect,
  onAdd,
  onRemove,
  onRestore,
}: {
  client: BaiClient;
  workspaces: string[];
  archivedWorkspaces: string[];
  /** Resolved selection: null = nothing selected. */
  selected: string | null;
  onSelect: (path: string | null) => void;
  /** Persist a validated workspace path (throws on failure). */
  onAdd: (path: string) => Promise<void>;
  /** Archive a workspace (unregister + hide its sessions) — confirmed first. */
  onRemove: (path: string) => Promise<void>;
  /** Restore an archived workspace (re-register + unarchive its sessions). */
  onRestore: (path: string) => Promise<void>;
}) {
  const [tab, setTab] = useState<"active" | "archived">("active");
  const [modalOpen, setModalOpen] = useState(false);
  // The row pending removal (the confirm modal's subject); null = closed.
  const [removing, setRemoving] = useState<string | null>(null);
  // Live count of still-active sessions rooted at the pending path — the
  // confirm copy's "N sessions will be hidden".
  const [removeCount, setRemoveCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (removing === null) {
      setRemoveCount(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const sessions = await client.listSessions(1000, 0, { cwd: removing });
        if (!cancelled) setRemoveCount(sessions.length);
      } catch {
        if (!cancelled) setRemoveCount(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [removing, client]);

  const confirmRemove = async (): Promise<void> => {
    if (removing === null || busy) return;
    setBusy(true);
    try {
      await onRemove(removing);
      setRemoving(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="workspace-nav">
      {/* Active | Archived selector — archived hides the add button. */}
      <div className="ws-tabs" role="tablist" aria-label="Workspace list filter">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "active"}
          className={tab === "active" ? "ws-tab active" : "ws-tab"}
          onClick={() => setTab("active")}
        >
          Active
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "archived"}
          className={tab === "archived" ? "ws-tab active" : "ws-tab"}
          onClick={() => setTab("archived")}
        >
          Archived{archivedWorkspaces.length > 0 ? ` (${archivedWorkspaces.length})` : ""}
        </button>
      </div>
      {tab === "active" ? (
        <>
          <SubNavCreate className="add-workspace-btn" label="+ Add a Workspace" onClick={() => setModalOpen(true)} />
          {workspaces.length === 0 && <p className="dim">No workspaces yet.</p>}
          {workspaces.map((w) => (
            <ListItem
              key={w}
              accentBar
              icon={<FolderGlyph />}
              title={basename(w)}
              subtitle={w}
              selected={selected === w}
              onClick={() => onSelect(w)}
              hint={w}
              ariaCurrent={selected === w ? "page" : undefined}
              trailing={
                <button
                  type="button"
                  className="ws-row-action"
                  title={`Archive ${basename(w)} (its sessions are hidden)`}
                  aria-label={`Archive workspace ${basename(w)}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setRemoving(w);
                  }}
                >
                  <Trash2 size={13} aria-hidden="true" />
                </button>
              }
            />
          ))}
        </>
      ) : (
        <>
          {archivedWorkspaces.length === 0 && <p className="dim">No archived workspaces.</p>}
          {archivedWorkspaces.map((w) => (
            <ListItem
              key={w}
              icon={<ArchiveGlyph />}
              title={basename(w)}
              subtitle={w}
              selected={false}
              hint={`${w} — archived; restore to bring it and its sessions back`}
              trailing={
                <button
                  type="button"
                  className="ws-row-action"
                  title={`Restore ${basename(w)} (and its sessions)`}
                  aria-label={`Restore workspace ${basename(w)}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    void onRestore(w);
                  }}
                >
                  <RotateCcw size={13} aria-hidden="true" />
                </button>
              }
            />
          ))}
        </>
      )}
      {modalOpen && (
        <AddWorkspaceModal
          client={client}
          onAdd={onAdd}
          onClose={() => setModalOpen(false)}
        />
      )}
      {removing !== null && (
        <Modal
          open
          onClose={() => setRemoving(null)}
          title="Archive workspace"
          ariaLabel="Archive workspace"
          size="sm"
          footer={
            <>
              <Button variant="ghost" disabled={busy} onClick={() => setRemoving(null)}>
                Cancel
              </Button>
              <span className="modal-foot-spacer" />
              <Button variant="danger" loading={busy} onClick={() => void confirmRemove()}>
                <Archive size={14} aria-hidden="true" />
                Archive
              </Button>
            </>
          }
        >
          <p>
            Archive <strong>{basename(removing)}</strong>?
          </p>
          <p className="dim">{removing}</p>
          <p className="dim">
            {removeCount === null
              ? "Its sessions will be hidden (archived)."
              : removeCount === 0
                ? "It has no sessions."
                : `${removeCount} session${removeCount === 1 ? "" : "s"} will be hidden (archived).`}{" "}
            The folder on disk is not touched — restore any time from the Archived tab.
          </p>
        </Modal>
      )}
    </div>
  );
}

function basename(p: string): string {
  const parts = p.split("/").filter((s) => s.length > 0);
  return parts[parts.length - 1] ?? p;
}

/** Folder glyph on workspace items — lucide's Folder, sized by CSS. */
export function FolderGlyph() {
  return <Folder className="ws-item-icon" aria-hidden="true" />;
}

/** Glyph on archived workspace items — lucide's Archive, dimmed by CSS. */
function ArchiveGlyph() {
  return <Archive className="ws-item-icon ws-item-icon-archived" aria-hidden="true" />;
}
