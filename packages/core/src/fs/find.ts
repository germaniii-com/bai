import { statSync } from "node:fs";
import path from "node:path";
import { Glob } from "bun";
import { isIgnoredDir } from "../tools/fs-guard";
import { toReal } from "./paths";

/**
 * Recursive fuzzy file/folder search scoped to a workspace root — the
 * `#file` mention picker's data source (opencode2's `rg --files` ⊕
 * `fzf`/`fuzzysearch` walk, adapted to one server-side call).
 *
 * The walk is cached per resolved root for a few seconds so per-keystroke
 * filtering is an in-memory rank, not a re-walk. Hidden entries and the
 * shared ignored-dir list (node_modules, dist, …) are skipped; paths are
 * returned workspace-relative with POSIX separators (the form the composer
 * inserts and the server resolves back against the session cwd).
 */

export interface FoundEntry {
  /** Workspace-relative path, POSIX separators. */
  path: string;
  type: "file" | "dir";
}

export interface FindResult {
  /** Realpath of the searched root. */
  root: string;
  results: FoundEntry[];
  /** True when the walk hit the raw cap (results may be incomplete). */
  truncated: boolean;
}

export interface FindOptions {
  /** Max results returned (default 20). */
  limit?: number;
  /** Max entries retained from the walk (default 20000). */
  maxEntries?: number;
}

const DEFAULT_LIMIT = 20;
const DEFAULT_MAX_ENTRIES = 20_000;
const CACHE_TTL_MS = 5_000;

interface CacheEntry {
  entries: FoundEntry[];
  truncated: boolean;
  ts: number;
}

const walkCache = new Map<string, CacheEntry>();

/** Drop the cached walk for a root (or every root) — tests + fs-change hooks. */
export function clearFindCache(root?: string): void {
  if (root === undefined) walkCache.clear();
  else walkCache.delete(toRealOrSelf(root));
}

function toRealOrSelf(root: string): string {
  try {
    return toReal(root);
  } catch {
    return root;
  }
}

/**
 * Walk `root` once (cached) and rank entries against `query`. An empty query
 * lists the shallowest entries first (stable, useful default); otherwise a
 * case-insensitive subsequence score orders results, with basename and
 * segment-boundary matches preferred.
 */
export function findFiles(root: string, query: string, opts: FindOptions = {}): FindResult {
  if (root.length === 0) throw new Error("root is required");
  const resolvedRoot = toReal(root);
  const limit = Math.max(1, Math.floor(opts.limit ?? DEFAULT_LIMIT));
  const maxEntries = Math.max(1, Math.floor(opts.maxEntries ?? DEFAULT_MAX_ENTRIES));

  const cached = readCache(resolvedRoot, maxEntries);
  const filtered = rank(cached.entries, query);
  return {
    root: resolvedRoot,
    results: filtered.slice(0, limit),
    truncated: cached.truncated || filtered.length > limit,
  };
}

function readCache(resolvedRoot: string, maxEntries: number): CacheEntry {
  const now = Date.now();
  const hit = walkCache.get(resolvedRoot);
  if (hit !== undefined && now - hit.ts < CACHE_TTL_MS) return hit;

  const entries = walk(resolvedRoot, maxEntries);
  const entry: CacheEntry = { entries: entries.entries, truncated: entries.truncated, ts: now };
  walkCache.set(resolvedRoot, entry);
  return entry;
}

function walk(resolvedRoot: string, maxEntries: number): { entries: FoundEntry[]; truncated: boolean } {
  const glob = new Glob("**/*");
  const entries: FoundEntry[] = [];
  let truncated = false;
  for (const rel of glob.scanSync({ cwd: resolvedRoot, dot: false, onlyFiles: false })) {
    if (entries.length >= maxEntries) {
      truncated = true;
      break;
    }
    const posix = rel.split(path.sep).join("/");
    const segments = posix.split("/");
    if (segments.some((s) => isIgnoredDir(s))) continue;
    let isDir: boolean;
    try {
      isDir = statSync(path.join(resolvedRoot, rel)).isDirectory();
    } catch {
      continue; // raced a delete or unreadable node
    }
    entries.push({ path: posix, type: isDir ? "dir" : "file" });
  }
  return { entries, truncated };
}

/**
 * Rank `entries` for `query`. Pure and deterministic: stable ties break on
 * path length then lexical order, so the same list renders the same way on
 * every call.
 */
export function rank(entries: FoundEntry[], query: string): FoundEntry[] {
  const q = query.trim();
  if (q.length === 0) {
    return [...entries].sort((a, b) => {
      const da = depth(a.path);
      const db = depth(b.path);
      if (da !== db) return da - db;
      return a.path.localeCompare(b.path);
    });
  }
  const scored: Array<{ entry: FoundEntry; score: number }> = [];
  for (const entry of entries) {
    const score = fuzzyScore(q, entry.path);
    if (score > Number.NEGATIVE_INFINITY) scored.push({ entry, score });
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.entry.path.length !== b.entry.path.length) return a.entry.path.length - b.entry.path.length;
    return a.entry.path.localeCompare(b.entry.path);
  });
  return scored.map((s) => s.entry);
}

function depth(p: string): number {
  let n = 0;
  for (const ch of p) if (ch === "/") n++;
  return n;
}

/**
 * Case-insensitive subsequence score. Returns -Infinity when `query` is not
 * a subsequence of `target`. Consecutive runs, segment boundaries (start,
 * `/`, `-`, `_`, `.`), and basename matches score higher; long paths score
 * slightly lower so short, precise hits float up.
 */
export function fuzzyScore(query: string, target: string): number {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (q.length === 0) return 0;

  const baseStart = t.lastIndexOf("/") + 1;
  let qi = 0;
  let score = 0;
  let streak = 0;
  let prev = -2;
  let baseHits = 0;

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) continue;
    const boundary = ti === 0 || "/-_. ".includes(t[ti - 1]!);
    if (ti === prev + 1) {
      streak++;
      score += 2 + streak * 2;
    } else {
      streak = 0;
      score += 1;
    }
    if (boundary) score += 3;
    if (ti >= baseStart) {
      score += 2;
      baseHits++;
    }
    prev = ti;
    qi++;
  }
  if (qi < q.length) return Number.NEGATIVE_INFINITY;

  // Prefer hits that live in the basename, and shorter/less deep targets.
  if (baseHits > 0) score += 4;
  score -= depth(t) * 0.5;
  score -= t.length * 0.02;
  return score;
}
