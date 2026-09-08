import { useState } from "react";
import { Folder } from "lucide-react";
import type { BaiClient } from "@bai/api/client";
import { AddWorkspaceModal } from "./add-workspace-modal";
import { ListItem, SubNavCreate } from "./components";

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
        />
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

/** Folder glyph on workspace items — lucide's Folder, sized by CSS. */
export function FolderGlyph() {
  return <Folder className="ws-item-icon" aria-hidden="true" />;
}
