import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Plus } from "lucide-react";
import type { BaiClient } from "@bai/api/client";
import { Button, Modal, TextInput } from "./components";

interface Completion {
  base: string;
  prefix: string;
  entries: string[];
  truncated: boolean;
}

/**
 * "Add a Workspace" modal: path input + a Finder-style two-column explorer.
 *
 * - LEFT pane: the current directory's folders. Clicking a folder SETS THE
 *   PATH to it (it becomes the workspace target) and previews its children
 *   in the RIGHT pane; the left pane stays on the current directory so
 *   siblings remain browsable. ".." goes up one level; "+ New Folder"
 *   (last row) creates a folder in the pane's directory via an inline name
 *   input, then drills into it.
 * - RIGHT pane: the selected folder's children. Clicking one DRILLS IN —
 *   it becomes the current directory (left pane follows). "+ New Folder"
 *   creates inside the previewed folder.
 * - The input drives registration: validated via /api/fs/stat (relative
 *   input resolves under ~; the resolved absolute path wins), or created
 *   via /api/fs/mkdir when missing — home directory only.
 * - Typing re-syncs the explorer to the typed path's base directory
 *   (navigation clicks suppress that sync for one cycle — see skipSync).
 *   The typed prefix filters the left pane as you type.
 */
export function AddWorkspaceModal({
  client,
  onAdd,
  onClose,
}: {
  client: BaiClient;
  /** Persist a validated workspace path (throws on failure). */
  onAdd: (path: string) => Promise<void>;
  onClose: () => void;
}) {
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [completion, setCompletion] = useState<Completion | null>(null);
  const [completionError, setCompletionError] = useState<string | null>(null);
  const [showDotfiles, setShowDotfiles] = useState(false);
  const requestId = useRef(0);
  // Navigation clicks move the explorer themselves — the next completion
  // (from the input change they caused) must not re-sync it.
  const skipSyncRef = useRef(false);

  // Debounced completion for the typed path (no focus gate — the explorer
  // must keep updating when focus moves to the columns).
  useEffect(() => {
    const id = ++requestId.current;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const res = await client.completePath(path, { dotfiles: showDotfiles });
          if (requestId.current !== id) return;
          // Navigation clicks already moved the explorer — don't let the
          // input-derived base yank it back. One skip per navigation.
          if (skipSyncRef.current) {
            skipSyncRef.current = false;
          } else {
            setCurrentDir(res.base);
          }
          setCompletion(res);
          setCompletionError(null);
        } catch (err) {
          if (requestId.current !== id) return;
          if (skipSyncRef.current) skipSyncRef.current = false;
          setCompletion(null);
          setCompletionError(err instanceof Error ? err.message : String(err));
        }
      })();
    }, 250);
    return () => clearTimeout(timer);
  }, [path, client, showDotfiles]);

  // --- left pane: the current directory's folders ---
  const [currentDir, setCurrentDir] = useState<string | null>(null);
  const [leftEntries, setLeftEntries] = useState<string[]>([]);
  const [leftError, setLeftError] = useState<string | null>(null);
  const leftReq = useRef(0);
  useEffect(() => {
    if (currentDir === null) {
      setLeftEntries([]);
      setLeftError(null);
      return;
    }
    const id = ++leftReq.current;
    void (async () => {
      try {
        const res = await client.completePath(`${currentDir}/`, { dotfiles: showDotfiles });
        if (leftReq.current !== id) return;
        setLeftEntries(res.entries);
        setLeftError(null);
      } catch (err) {
        if (leftReq.current !== id) return;
        setLeftEntries([]);
        setLeftError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [currentDir, client, showDotfiles]);

  // --- right pane: the selected folder's children ---
  const [selectedDir, setSelectedDir] = useState<string | null>(null);
  const [rightEntries, setRightEntries] = useState<string[]>([]);
  const [rightError, setRightError] = useState<string | null>(null);
  const rightReq = useRef(0);
  useEffect(() => {
    if (selectedDir === null) {
      setRightEntries([]);
      setRightError(null);
      return;
    }
    const id = ++rightReq.current;
    void (async () => {
      try {
        const res = await client.completePath(`${selectedDir}/`, { dotfiles: showDotfiles });
        if (rightReq.current !== id) return;
        setRightEntries(res.entries);
        setRightError(null);
      } catch (err) {
        if (rightReq.current !== id) return;
        setRightEntries([]);
        setRightError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [selectedDir, client, showDotfiles]);

  /** Create offer: the typed path can't be completed because it's missing. */
  const canCreate =
    completionError === "path not found" ||
    (completion !== null && completion.entries.length === 0 && completion.prefix !== "");

  // The typed prefix filters the left pane (empty prefix → show all).
  const prefix = completion?.prefix ?? "";
  const lowerPrefix = prefix.toLowerCase();
  const filteredLeft = leftEntries.filter(
    (n) => prefix.length === 0 || n.toLowerCase().startsWith(lowerPrefix),
  );

  /** Select a left-pane folder: it becomes the path + right-pane preview. */
  const selectLeft = (dir: string): void => {
    skipSyncRef.current = true;
    setPath(`${dir}/`);
    setSelectedDir(dir);
  };

  /** Drill in: the folder becomes the current directory (left follows). */
  const drillIn = (dir: string): void => {
    skipSyncRef.current = true;
    setCurrentDir(dir);
    setPath(`${dir}/`);
    setSelectedDir(null);
  };

  const goUp = (): void => {
    if (currentDir !== null) drillIn(parentPath(currentDir));
  };

  // --- inline per-pane folder creation ---
  const [creating, setCreating] = useState<"left" | "right" | null>(null);
  const [newName, setNewName] = useState("");

  const startCreate = (pane: "left" | "right"): void => {
    setCreating(pane);
    setNewName("");
    setError(null);
  };

  const cancelCreate = (): void => {
    setCreating(null);
    setNewName("");
  };

  /** Create the folder in the pane's directory, then drill into it. */
  const confirmCreate = async (pane: "left" | "right"): Promise<void> => {
    const dir = pane === "left" ? currentDir : selectedDir;
    const name = newName.trim();
    if (dir === null || name.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const stat = await client.createFolder(joinPath(dir, name));
      setCreating(null);
      setNewName("");
      drillIn(stat.path);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const submit = async (): Promise<void> => {
    const candidate = path.trim();
    if (candidate.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const stat = await client.statPath(candidate);
      await onAdd(stat.path);
      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A missing folder is what the create buttons are for — no raw error.
      if (message !== "path not found") setError(message);
    } finally {
      setBusy(false);
    }
  };

  const createAndAdd = async (): Promise<void> => {
    const candidate = path.trim();
    if (candidate.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const stat = await client.createFolder(candidate);
      await onAdd(stat.path);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const newFolderRow = (pane: "left" | "right"): ReactNode =>
    creating === pane ? (
      <div className="ws-newrow">
        <input
          className="ws-newname"
          value={newName}
          placeholder="folder name"
          autoFocus
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void confirmCreate(pane);
            } else if (e.key === "Escape") {
              // Cancel the inline create — don't let Esc close the modal.
              e.stopPropagation();
              cancelCreate();
            }
          }}
          aria-label="new folder name"
        />
        <button
          type="button"
          className="ws-newok"
          disabled={newName.trim().length === 0 || busy}
          aria-label="create folder"
          onClick={() => {
            void confirmCreate(pane);
          }}
        >
          <Check size={14} aria-hidden="true" />
        </button>
      </div>
    ) : (
      <button
        type="button"
        className="ws-row ws-newfolder"
        onClick={() => startCreate(pane)}
      >
        <Plus size={14} aria-hidden="true" />
        New Folder
      </button>
    );

  return (
    <Modal
      open
      onClose={onClose}
      title="Add a Workspace"
      ariaLabel="Add a workspace"
      footer={
        <>
          {canCreate && (
            <>
              <Button variant="outline" disabled={busy} onClick={() => void createAndAdd()}>
                + Create New Folder
              </Button>
              <span className="dim">inside your home directory</span>
            </>
          )}
          <span className="modal-foot-spacer" />
          <Button
            variant="primary"
            disabled={path.trim().length === 0}
            loading={busy}
            onClick={() => void submit()}
          >
            <Plus size={14} aria-hidden="true" />
            Add Workspace
          </Button>
        </>
      }
    >
      <TextInput
        mono
        value={path}
        placeholder="/absolute/path — or type to search ~"
        onChange={(e) => setPath(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void submit();
          }
        }}
        aria-label="workspace folder path"
        autoComplete="off"
        autoFocus
      />
      <div className="ws-explorer-bar">
        <label className="ws-dotfiles-toggle">
          <input
            type="checkbox"
            checked={showDotfiles}
            onChange={(e) => setShowDotfiles(e.target.checked)}
          />
          show dotfiles
        </label>
      </div>
      <div className="ws-explorer">
        <div className="ws-col">
          <div className="ws-col-head" title={currentDir ?? undefined}>
            {currentDir !== null ? basename(currentDir) : "folders"}
          </div>
          <div className="ws-col-list">
            {completionError !== null && <p className="dim col-hint">{completionError}</p>}
            {leftError !== null && <p className="dim col-hint">{leftError}</p>}
            {currentDir !== null && (
              <>
                <button
                  type="button"
                  className="ws-row dotdot"
                  title={parentPath(currentDir)}
                  onClick={goUp}
                >
                  ..
                </button>
                {filteredLeft.map((name) => {
                  const dir = joinPath(currentDir, name);
                  return (
                    <button
                      key={name}
                      type="button"
                      className={selectedDir === dir ? "ws-row active" : "ws-row"}
                      title={dir}
                      onClick={() => selectLeft(dir)}
                    >
                      {name}/
                    </button>
                  );
                })}
                {newFolderRow("left")}
              </>
            )}
          </div>
        </div>
        <div className="ws-col">
          <div className="ws-col-head" title={selectedDir ?? undefined}>
            {selectedDir !== null ? basename(selectedDir) : "preview"}
          </div>
          <div className="ws-col-list">
            {selectedDir === null && (
              <p className="dim col-hint">Click a folder to preview.</p>
            )}
            {rightError !== null && <p className="dim col-hint">{rightError}</p>}
            {selectedDir !== null &&
              rightError === null &&
              rightEntries.length === 0 && <p className="dim col-hint">No subfolders.</p>}
            {selectedDir !== null &&
              rightEntries.map((name) => {
                const dir = joinPath(selectedDir, name);
                return (
                  <button
                    key={name}
                    type="button"
                    className="ws-row"
                    title={dir}
                    onClick={() => drillIn(dir)}
                  >
                    {name}/
                  </button>
                );
              })}
            {selectedDir !== null && newFolderRow("right")}
          </div>
        </div>
      </div>
      {error !== null && <div className="error" role="alert">{error}</div>}
    </Modal>
  );
}

function joinPath(dir: string, name: string): string {
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

function parentPath(dir: string): string {
  const trimmed = dir.endsWith("/") ? dir.slice(0, -1) : dir;
  const idx = trimmed.lastIndexOf("/");
  return idx <= 0 ? "/" : trimmed.slice(0, idx);
}

function basename(p: string): string {
  const parts = p.split("/").filter((s) => s.length > 0);
  return parts[parts.length - 1] ?? p;
}
