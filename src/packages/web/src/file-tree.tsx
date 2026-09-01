import { useCallback, useEffect, useState } from "react";
import type { BaiClient } from "@bai/api/client";

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
 * nothing until opened. Display-only in v1; file actions arrive with the
 * Phase 3 code workbench.
 */
export function FileTree({ client, root }: { client: BaiClient; root: string }) {
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
}: {
  dir: string;
  depth: number;
  dirs: Map<string, DirState>;
  expanded: Set<string>;
  onToggle: (dir: string) => void;
  showDotfiles: boolean;
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
    <ul className="tree-entries" role="group">
      {visible.map((entry) => {
        const path = joinPath(dir, entry.name);
        if (entry.type === "dir") {
          const isOpen = expanded.has(path);
          return (
            <li key={path}>
              {/* No caret — the folder icon marks the type; an open folder
                  tints accent (closed stays dim) and the indented children
                  show the expanded state (aria-expanded keeps it
                  programmatically). */}
              <button
                type="button"
                className="tree-row"
                style={{ paddingLeft: `${8 + depth * 14}px` }}
                onClick={() => onToggle(path)}
                aria-expanded={isOpen}
              >
                <FolderIcon open={isOpen} />
                <span className="tree-name">{entry.name}</span>
              </button>
              {isOpen && (
                <DirEntries
                  dir={path}
                  depth={depth + 1}
                  dirs={dirs}
                  expanded={expanded}
                  onToggle={onToggle}
                  showDotfiles={showDotfiles}
                />
              )}
            </li>
          );
        }
        return (
          <li key={path}>
            <span className="tree-row file" style={{ paddingLeft: `${8 + depth * 14}px` }}>
              <FileIcon />
              <span className="tree-name">{entry.name}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** Stroke icons — same inline-SVG convention as the master rail. */
function FolderIcon({ open }: { open: boolean }) {
  return (
    <svg
      className={open ? "tree-icon open" : "tree-icon"}
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

function FileIcon() {
  return (
    <svg className="tree-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
      <polyline points="13 2 13 9 20 9" />
    </svg>
  );
}

function joinPath(dir: string, name: string): string {
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

function basename(p: string): string {
  const parts = p.split("/").filter((s) => s.length > 0);
  return parts[parts.length - 1] ?? p;
}
