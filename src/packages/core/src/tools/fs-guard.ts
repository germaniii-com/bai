import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Shared guards for the fs tools:
 *
 * - Rooting: relative paths resolve against the session cwd; absolute paths
 *   must live under the session cwd or a registered workspace.
 * - Staleness: writes/edits refuse to touch a file that was never read in
 *   this process, or whose mtime moved after the last read (opencode2's
 *   `tools/file.go` guard — read-before-write and no clobbering of
 *   externally-modified files).
 * - "Did you mean": substring suggestions on a miss.
 * - Per-path mutation queue: parallel write/edit calls to one file serialize
 *   instead of interleaving (pi's `withFileMutationQueue`).
 *
 * Convention: every expected failure THROWS a plain Error with a model-facing
 * message; the run loop converts throws into error tool results.
 */

export interface FsRoots {
  /** Absolute directory roots the session may touch (cwd first, then workspaces). */
  roots(): string[];
}

/** One shared staleness table for the process (keyed by absolute path). */
const fileState = new Map<string, { readAt: number; writtenAt: number }>();

export function recordRead(abs: string): void {
  const now = Date.now();
  const state = fileState.get(abs) ?? { readAt: now, writtenAt: 0 };
  state.readAt = now;
  fileState.set(abs, state);
}

export function recordWrite(abs: string): void {
  const now = Date.now();
  // A write implies knowledge of the content: it also refreshes the read stamp.
  fileState.set(abs, { readAt: now, writtenAt: now });
}

/** Throws unless the file may be written/edited right now (staleness guard). */
export function assertFreshForWrite(abs: string, exists: boolean): void {
  if (!exists) return; // creating a new file needs no prior read
  const state = fileState.get(abs);
  if (state === undefined || state.readAt === 0) {
    throw new Error(`File has not been read yet. Read it before overwriting: ${abs}`);
  }
  const mtimeMs = safeMtimeMs(abs);
  // Floor before comparing: statSync reports sub-ms precision while the
  // read/write stamps come from integer Date.now() — without the floor a
  // just-written file always looks "modified" (mtime 100.7 > stamp 100).
  if (mtimeMs !== undefined && Math.floor(mtimeMs) > state.readAt) {
    throw new Error(`File has been modified since it was last read: ${abs}. Re-read it, then retry.`);
  }
}

function safeMtimeMs(abs: string): number | undefined {
  try {
    return statSync(abs).mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * Resolve a user-supplied path against the session roots. Returns the
 * absolute path or throws with a model-facing message.
 */
export function resolveInRoots(ctx: { cwd?: string }, roots: string[], input: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0) throw new Error("path is required");
  const candidates = [...(ctx.cwd !== undefined && ctx.cwd.length > 0 ? [ctx.cwd] : []), ...roots];
  if (candidates.length === 0) {
    throw new Error("This session has no working directory. Create the session with a cwd, or set the workspace first.");
  }
  if (path.isAbsolute(trimmed)) {
    const abs = path.normalize(trimmed);
    const inside = candidates.find((root) => abs === root || abs.startsWith(root.endsWith(path.sep) ? root : root + path.sep));
    if (inside === undefined) {
      throw new Error(`Path is outside this session's workspace: ${abs}`);
    }
    return abs;
  }
  if (ctx.cwd === undefined || ctx.cwd.length === 0) {
    throw new Error("Relative paths need a session working directory. Use an absolute path inside a registered workspace.");
  }
  return path.normalize(path.resolve(ctx.cwd, trimmed));
}

/** Up to 3 sibling entries fuzzy-matching a missed filename ("did you mean"). */
export function suggestAlternatives(dir: string, base: string): string[] {
  try {
    const lower = base.toLowerCase();
    return readdirSync(dir)
      .filter((entry) => entry.toLowerCase().includes(lower) || lower.includes(entry.toLowerCase()))
      .slice(0, 3)
      .map((entry) => path.join(dir, entry));
  } catch {
    return [];
  }
}

/** Not-found error with suggestions attached. */
export function notFoundError(abs: string): Error {
  const suggestions = suggestAlternatives(path.dirname(abs), path.basename(abs));
  if (suggestions.length > 0) {
    return new Error(`File not found: ${abs}\n\nDid you mean one of these?\n${suggestions.join("\n")}`);
  }
  return new Error(`File not found: ${abs}`);
}

const MUTATION_QUEUES = new Map<string, Promise<unknown>>();

/**
 * Serialize mutating operations per absolute path: parallel edits to one
 * file run one after another; different files stay independent.
 */
export async function withFileMutationQueue<T>(abs: string, fn: () => Promise<T> | T): Promise<T> {
  const tail = MUTATION_QUEUES.get(abs) ?? Promise.resolve();
  const next = tail.then(fn, fn);
  // The map holds the newest tail; a swallowed copy keeps the chain alive
  // when this call's caller does not handle the rejection.
  MUTATION_QUEUES.set(abs, next.catch(() => undefined));
  return next;
}

/** Directories always skipped by listing/globbing tools. */
export const DEFAULT_IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "__pycache__",
  ".venv",
  "venv",
  "target",
  ".next",
  ".cache",
]);

export function isIgnoredDir(name: string, extra: string[] = []): boolean {
  return name.startsWith(".") || DEFAULT_IGNORED_DIRS.has(name) || extra.includes(name);
}

/** Cheap binary sniff: a NUL byte in the first 8KB disqualifies text reads. */
export function looksBinary(buf: Uint8Array): boolean {
  const sample = buf.subarray(0, 8192);
  return sample.includes(0);
}

export function fileExists(abs: string): boolean {
  return existsSync(abs);
}
