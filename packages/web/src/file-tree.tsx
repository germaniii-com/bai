import { useCallback, useEffect, useRef, useState } from "react";
import { File, Folder, FolderOpen } from "lucide-react";
import type { BaiClient } from "@bai/api/client";
import { ListItem } from "./components";

interface FsEntry {
  name: string;
  type: "dir" | "file";
}

interface DirState {
  status: "loading" | "ok" | "error";
  entries: FsEntry[];
  /** Server-side hint when the listing was capped. */
  truncated: boolean;
  error?: string;
}

/**
 * Read-only file tree for the workspace right sidebar. Lazy per-directory
 * listing (VS Code style): the root loads on mount/workspace change, every
 * expansion fetches exactly one directory — huge trees (node_modules) cost
 * nothing until opened. File rows open the workspace file viewer (the
 * Files view's tabbed Monaco/media preview); directories expand inline.
 */
export function FileTree({
  client,
  root,
  onOpenFile,
  activePath = null,
  refreshToken = 0,
}: {
  client: BaiClient;
  root: string;
  /** File-row click → open (or focus) the file in the viewer. */
  onOpenFile?: (path: string) => void;
  /** The viewer's active file — highlighted in the tree when in Files view. */
  activePath?: string | null;
  /** Bumped when the agent (or a revert) changes files — expanded dirs re-list. */
  refreshToken?: number;
}) {
  const [dirs, setDirs] = useState<Map<string, DirState>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showDotfiles, setShowDotfiles] = useState(false);

  const load = useCallback(
    async (dir: string) => {
      setDirs((prev) => {
        if (prev.get(dir)?.status === "loading" || prev.get(dir)?.status === "ok") return prev;
        const next = new Map(prev);
        next.set(dir, { status: "loading", entries: [], truncated: false });
        return next;
      });
      try {
        const listing = await client.listDir(root, dir);
        setDirs((prev) => {
          const next = new Map(prev);
          next.set(dir, {
            status: "ok",
            entries: listing.entries,
            truncated: listing.truncated,
          });
          return next;
        });
      } catch (err) {
        setDirs((prev) => {
          const next = new Map(prev);
          next.set(dir, {
            status: "error",
            entries: [],
            truncated: false,
            error: err instanceof Error ? err.message : String(err),
          });
          return next;
        });
      }
    },
    [client, root],
  );

  // Workspace switch: drop all state, load the new root.
  useEffect(() => {
    setDirs(new Map());
    setExpanded(new Set());
    void load(root);
  }, [root, load]);

  // External refresh (agent file changes, reverts): re-list the root and
  // every EXPANDED directory so created/deleted entries appear. Collapsed
  // directories fetch fresh whenever they're expanded later (their cache
  // entry is dropped too).
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const prevTokenRef = useRef(refreshToken);
  useEffect(() => {
    if (prevTokenRef.current === refreshToken) return;
    prevTokenRef.current = refreshToken;
    const targets = [root, ...expandedRef.current];
    setDirs((prev) => {
      const next = new Map(prev);
      for (const dir of targets) next.delete(dir);
      return next;
    });
    for (const dir of targets) void load(dir);
  }, [refreshToken, root, load]);

  const toggle = (dir: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(dir)) {
        next.delete(dir);
      } else {
        next.add(dir);
        void load(dir);
      }
      return next;
    });
  };

  const rootState = dirs.get(root);

  return (
    <aside className="file-tree" aria-label={`files in ${root}`}>
      <div className="file-tree-head" title={root}>
        {basename(root)}
      </div>
      <div className="file-tree-bar">
        <label className="ws-dotfiles-toggle">
          <input
            type="checkbox"
            checked={showDotfiles}
            onChange={(e) => setShowDotfiles(e.target.checked)}
          />
          dotfiles
        </label>
      </div>
      <div className="file-tree-body">
        {rootState === undefined || rootState.status === "loading" ? (
          <p className="dim">Loading…</p>
        ) : rootState.status === "error" ? (
          <p className="dim">Cannot read folder: {rootState.error}</p>
        ) : rootState.entries.length === 0 ? (
          <p className="dim">Empty folder.</p>
        ) : (
          <DirEntries
            dir={root}
            depth={0}
            dirs={dirs}
            expanded={expanded}
            onToggle={toggle}
            showDotfiles={showDotfiles}
            onOpenFile={onOpenFile}
            activePath={activePath}
          />
        )}
        {rootState?.truncated === true && <p className="dim">listing truncated</p>}
      </div>
    </aside>
  );
}

function DirEntries({
  dir,
  depth,
  dirs,
  expanded,
  onToggle,
  showDotfiles,
  onOpenFile,
  activePath,
}: {
  dir: string;
  depth: number;
  dirs: Map<string, DirState>;
  expanded: Set<string>;
  onToggle: (dir: string) => void;
  showDotfiles: boolean;
  onOpenFile?: (path: string) => void;
  activePath?: string | null;
}) {
  const state = dirs.get(dir);
  if (state === undefined) return null;
  // Unreadable directory (permission denied, vanished, …): show the reason
  // inline instead of silently rendering nothing.
  if (state.status === "error") {
    return (
      <p className="dim tree-error" style={{ paddingLeft: `${16 + depth * 14}px` }}>
        {state.error}
      </p>
    );
  }
  if (state.status !== "ok") return null;
  // Dotfile filtering is render-side — listings are cached per directory,
  // so toggling is instant with no refetch.
  const visible = showDotfiles
    ? state.entries
    : state.entries.filter((entry) => !entry.name.startsWith("."));
  return (
    <ul className="tree-entries">
      {visible.map((entry) => {
        const path = joinPath(dir, entry.name);
        if (entry.type === "dir") {
          const isOpen = expanded.has(path);
          return (
            <li key={path}>
              {/* No caret — the folder icon carries the state: FolderOpen
                  when expanded, Folder when closed (shape swap only, no
                  tint; aria-expanded keeps it programmatically). */}
              <ListItem
                inline
                icon={<FolderIcon open={isOpen} />}
                title={entry.name}
                onClick={() => onToggle(path)}
                style={{ paddingLeft: `${8 + depth * 14}px` }}
                aria-expanded={isOpen}
                aria-controls={`tree-${path.replace(/[^a-zA-Z0-9_-]/g, "-")}`}
              />
              {isOpen && (
                  <div id={`tree-${path.replace(/[^a-zA-Z0-9_-]/g, "-")}`}>
                  <DirEntries
                  dir={path}
                  depth={depth + 1}
                  dirs={dirs}
                  expanded={expanded}
                  onToggle={onToggle}
                  showDotfiles={showDotfiles}
                  onOpenFile={onOpenFile}
                  activePath={activePath}
                  />
                  </div>
              )}
            </li>
          );
        }
        // File rows open the viewer when onOpenFile is wired (the workspace
        // section); plain spans keep the tree usable without it.
        const active = activePath === path;
        return (
          <li key={path}>
            {onOpenFile !== undefined ? (
              <ListItem
                inline
                icon={<FileIcon />}
                title={entry.name}
                selected={active}
                onClick={() => onOpenFile(path)}
                aria-current={active ? "true" : undefined}
                hint={`Open ${path}`}
                style={{ paddingLeft: `${8 + depth * 14}px` }}
              />
            ) : (
              <span className="tree-row file" style={{ paddingLeft: `${8 + depth * 14}px` }}>
                <FileIcon />
                <span className="tree-name">{entry.name}</span>
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Lucide icons — sized to the row's icon slot; open state is the shape swap. */
function FolderIcon({ open }: { open: boolean }) {
  return open ? (
    <FolderOpen size={14} aria-hidden="true" />
  ) : (
    <Folder size={14} aria-hidden="true" />
  );
}

function FileIcon() {
  return <File size={14} aria-hidden="true" />;
}

function joinPath(dir: string, name: string): string {
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

function basename(p: string): string {
  const parts = p.split("/").filter((s) => s.length > 0);
  return parts[parts.length - 1] ?? p;
}
