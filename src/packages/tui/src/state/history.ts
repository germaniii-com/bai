/**
 * Global in-memory prompt history — one shell-like history for the whole app
 * run, shared across sessions and views (module state survives ChatView
 * remounts on view switches). Lost on exit by design.
 *
 * Traversal mirrors readline: an index walks the entries; the live draft is
 * saved on the first up-step and restored when stepping past the newest
 * entry. Consecutive duplicates collapse (spamming enter doesn't fill the
 * history), and the log is capped.
 */

const MAX = 500;

let entries: string[] = [];
let index = 0; // traversal cursor; entries.length = live draft
let draft = ""; // draft saved when traversal started

/** Record a submitted prompt (consecutive duplicates collapse). */
export function recordPrompt(text: string): void {
  if (text.length === 0) return;
  if (entries[entries.length - 1] !== text) {
    entries.push(text);
    if (entries.length > MAX) entries.shift();
  }
  index = entries.length;
}

/**
 * History traversal. up=true → older, up=false → newer. Returns the entry to
 * show, or null when there is nothing to change to (empty history, or
 * already at the live draft going down). Recalled entries are shown verbatim
 * — the caller positions the cursor at their end.
 */
export function traverse(up: boolean, current: string): string | null {
  if (entries.length === 0) return null;
  if (up) {
    if (index === entries.length) draft = current; // entering traversal
    if (index === 0) return entries[0]!; // pinned at the oldest entry
    index -= 1;
    return entries[index]!;
  }
  if (index >= entries.length) return null; // already at the live draft
  index += 1;
  return index === entries.length ? draft : entries[index]!;
}

/** Back to the live-draft boundary (after submit, on session switch). */
export function resetTraversal(): void {
  index = entries.length;
}

/** Drop all history (test seam; a future /clear hook can reuse it). */
export function clearHistory(): void {
  entries = [];
  index = 0;
  draft = "";
}
