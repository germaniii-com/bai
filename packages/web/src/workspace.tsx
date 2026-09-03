import { useState } from "react";
import type { BaiClient } from "@bai/api/client";
import { AddWorkspaceModal } from "./add-workspace-modal";

/**
 * Workspace nested-sidebar list: registered workspace folder paths (from
 * config) + a "+ Add a Workspace" button that opens the add modal (path
 * input, two-column folder explorer, create-if-missing — see
 * add-workspace-modal.tsx). Display name is the path's basename; the full
 * path rides as the dim subtitle.
 */
export function WorkspaceNav({
  client,
  workspaces,
  selected,
  onSelect,
  onAdd,
}: {
  client: BaiClient;
  workspaces: string[];
  /** Resolved selection: null = nothing selected. */
  selected: string | null;
  onSelect: (path: string | null) => void;
  /** Persist a validated workspace path (throws on failure). */
  onAdd: (path: string) => Promise<void>;
}) {
  const [modalOpen, setModalOpen] = useState(false);

  return (
    <div className="workspace-nav">
      <button
        type="button"
        className="new-session add-workspace-btn"
        onClick={() => setModalOpen(true)}
      >
        + Add a Workspace
      </button>
      {workspaces.length === 0 && <p className="dim">No workspaces yet.</p>}
      {workspaces.map((w) => (
        <button
          key={w}
          type="button"
          className={selected === w ? "workspace-item active" : "workspace-item"}
          onClick={() => onSelect(w)}
          title={w}
        >
          <span className="ws-item-head">
            <FolderGlyph />
            <span className="title">{basename(w)}</span>
          </span>
          <span className="dim path">{w}</span>
        </button>
      ))}
      {modalOpen && (
        <AddWorkspaceModal
          client={client}
          onAdd={onAdd}
          onClose={() => setModalOpen(false)}
        />
      )}
    </div>
  );
}

function basename(p: string): string {
  const parts = p.split("/").filter((s) => s.length > 0);
  return parts[parts.length - 1] ?? p;
}

/** Folder glyph on workspace items — same stroke convention as the tree. */
export function FolderGlyph() {
  return (
    <svg
      className="ws-item-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}
