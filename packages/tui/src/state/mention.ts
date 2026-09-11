/**
 * Pure state helpers for the composer's `#file` mention picker. The chat
 * view owns the trigger detection + fetch; this module keeps the list
 * navigation deterministic and unit-testable (the state/hub.ts pattern).
 */

export interface MentionEntry {
  /** Workspace-relative path, POSIX separators. */
  path: string;
  /**
   * `dir-select` is the folder currently being browsed, offered as a row of
   * its own so a folder can be mentioned *as a whole*.
   *
   * `dir` rows drill in on Enter (`#dir/`, no trailing space, picker stays
   * open to keep filtering inside) — which alone can never express "this
   * folder". So a directory that has children, i.e. exactly the folders that
   * get listed while browsing, had no way to be referenced. This row routes
   * through the file/insert path instead, producing a terminal `#folder `
   * token.
   */
  type: "file" | "dir" | "dir-select";
}

export interface MentionUiState {
  open: boolean;
  /** Full query after `#`, ranges included (e.g. "src/foo.ts:10-20"). */
  raw: string;
  /** Path portion the picker filters on (range stripped). */
  pathQuery: string;
  results: MentionEntry[];
  selected: number;
  loading: boolean;
  error?: string;
}

export function emptyMentionUi(): MentionUiState {
  return { open: false, raw: "", pathQuery: "", results: [], selected: 0, loading: false };
}

/** Open (or re-query) the picker for a fresh trigger. */
export function openedMention(raw: string, pathQuery: string): MentionUiState {
  return { open: true, raw, pathQuery, results: [], selected: 0, loading: true };
}

/**
 * The directory a trailing-slash query is browsing (`a/b/` → `a/b`), or
 * undefined when the query is not a directory query / is the workspace root.
 */
export function browsedFolder(pathQuery: string): string | undefined {
  if (!pathQuery.endsWith("/")) return undefined;
  const trimmed = pathQuery.replace(/\/+$/, "");
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Apply a fetched result set (keeping the selection in range), with the
 * browsed folder offered as a selectable row.
 *
 * It is listed first so that Enter drills into a folder and Enter again takes
 * it — mirroring how the query narrows (`#src` → `#src/` → pick). A result
 * that already *is* that folder is re-typed rather than duplicated, so exactly
 * one row represents it.
 */
export function withMentionResults(state: MentionUiState, results: MentionEntry[]): MentionUiState {
  const folder = browsedFolder(state.pathQuery);
  let rows = results;
  if (folder !== undefined) {
    rows = results.some((entry) => entry.path === folder)
      ? results.map((entry) => (entry.path === folder ? { ...entry, type: "dir-select" as const } : entry))
      : [{ path: folder, type: "dir-select" as const }, ...results];
  }
  return { ...state, results: rows, selected: Math.min(state.selected, Math.max(0, rows.length - 1)), loading: false };
}

/** Move the highlight, wrapping at both ends. No-op on an empty list. */
export function moveMention(state: MentionUiState, delta: number): MentionUiState {
  if (state.results.length === 0) return state;
  const count = state.results.length;
  const selected = ((state.selected + delta) % count + count) % count;
  return { ...state, selected };
}

/** The highlighted entry, when any. */
export function selectedMention(state: MentionUiState): MentionEntry | undefined {
  return state.results[state.selected];
}
