/**
 * Pure state helpers for the composer's `#file` mention picker. The chat
 * view owns the trigger detection + fetch; this module keeps the list
 * navigation deterministic and unit-testable (the state/hub.ts pattern).
 */

export interface MentionEntry {
  /** Workspace-relative path, POSIX separators. */
  path: string;
  type: "file" | "dir";
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

/** Apply a fetched result set (keeping the selection in range). */
export function withMentionResults(state: MentionUiState, results: MentionEntry[]): MentionUiState {
  return { ...state, results, selected: Math.min(state.selected, Math.max(0, results.length - 1)), loading: false };
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
