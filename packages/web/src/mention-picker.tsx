/**
 * The web composer's `#file` mention popover — a listbox anchored above the
 * input (opencode2's completion, `#`-triggered). Presentational: the chat
 * pane owns the trigger detection, fetch, and insertion.
 */

export interface MentionEntry {
  /** Workspace-relative path, POSIX separators. */
  path: string;
  type: "file" | "dir";
}

export function MentionPicker({
  results,
  selected,
  loading,
  query,
  error,
  onPick,
  onHover,
}: {
  results: MentionEntry[];
  selected: number;
  loading: boolean;
  query: string;
  error?: string;
  onPick: (entry: MentionEntry) => void;
  onHover: (index: number) => void;
}) {
  return (
    <div className="mention-pop" role="listbox" aria-label="File suggestions">
      {error !== undefined ? (
        <p className="mention-empty"># {error}</p>
      ) : results.length === 0 ? (
        <p className="mention-empty">{loading ? `# searching ${query}…` : `# no files match ${query}`}</p>
      ) : (
        results.map((entry, i) => {
          const slash = entry.path.lastIndexOf("/");
          const dir = slash >= 0 ? entry.path.slice(0, slash + 1) : "";
          const base = slash >= 0 ? entry.path.slice(slash + 1) : entry.path;
          return (
            <button
              key={entry.path}
              type="button"
              role="option"
              aria-selected={i === selected}
              className={i === selected ? "mention-option active" : "mention-option"}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => onHover(i)}
              onClick={() => onPick(entry)}
            >
              <span className="mention-dir">{dir}</span>
              <span className="mention-base">{base}</span>
              {entry.type === "dir" && <span className="mention-dir">/</span>}
            </button>
          );
        })
      )}
    </div>
  );
}
