import { accessSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Workspace-path helpers shared by the API's web file routes and the
 * workspace.create tool (core owns them; @bai/api re-exports — api depends
 * on core, never the reverse). Error mapping is user-facing plain text:
 * ENOENT → "path not found", EACCES/EPERM → "permission denied", ….
 */

/** Thrown for user-facing validation/IO failures (mapped to 400 by the API routes). */
export class FsError extends Error {}

/** Map a filesystem error to a plain, user-facing message. */
export function ioError(err: unknown, fallback: string): FsError {
  const code = (err as { code?: string } | null)?.code;
  if (code === "ENOENT") return new FsError("path not found");
  if (code === "EACCES" || code === "EPERM") return new FsError("permission denied");
  if (code === "ENOTDIR") return new FsError("path is not a directory");
  if (code === "ELOOP") return new FsError("invalid path (symlink loop)");
  return new FsError(fallback);
}

/** realpath with mapped errors — symlinks expanded so checks see the truth. */
export function toReal(p: string): string {
  try {
    return realpathSync(p);
  } catch (err) {
    throw ioError(err, "path not found");
  }
}

/**
 * Normalize user-typed path input: `~` expands to the home directory, and
 * anything not starting with `/` or `~` is treated as a search UNDER the
 * home directory ("Doc" → "~/Doc"). The trailing separator survives — it
 * decides whether the last segment is a prefix or the base directory.
 */
export function expandHomeInput(p: string, home: string): string {
  if (p.length === 0 || p === "~") return `${home}${path.sep}`;
  if (p.startsWith("~/")) return `${home}${p.slice(1)}`;
  if (p.startsWith("/")) return p;
  return `${home}${path.sep}${p}`;
}

export interface PathStat {
  path: string;
  type: "dir" | "file" | "other";
}

/**
 * Validate a single candidate path for use as a workspace: it must exist,
 * be a directory, and be readable+traversable by the server's user.
 * Files and unreadable paths are rejections with plain messages.
 */
export function statPath(p: string, home: string = homedir()): PathStat {
  if (p.length === 0) throw new FsError("path is required");
  // Same convention as completion: relative input searches under ~.
  const resolved = toReal(expandHomeInput(p.trim(), home));
  let stat;
  try {
    stat = statSync(resolved);
  } catch (err) {
    throw ioError(err, "path not found");
  }
  if (!stat.isDirectory()) throw new FsError("path is not a directory");
  try {
    // Reading a directory needs read (listing) + execute (traversal).
    accessSync(resolved, accessMode(stat.isDirectory()));
  } catch (err) {
    throw ioError(err, "permission denied");
  }
  return { path: resolved, type: stat.isDirectory() ? "dir" : stat.isFile() ? "file" : "other" };
}

function accessMode(isDir: boolean): number {
  // node:fs constants without importing the whole namespace inline.
  const R_OK = 4;
  const X_OK = 1;
  return isDir ? R_OK | X_OK : R_OK;
}

/**
 * Create a missing folder (and missing parents) as a workspace target.
 * SAFE BY CONSTRUCTION — creation is only allowed inside the user's home
 * directory, the one place a web- or agent-initiated mkdir is predictable.
 * The guard: walk up to the deepest EXISTING ancestor of the target and
 * realpath it — it must live inside the real home. One check covers every
 * escape: absolute paths outside home (in either home spelling — /var vs
 * /private/var on macOS), lexical `..` normalization, and home-level
 * symlinks pointing elsewhere (~/link → /etc). Nothing is created before
 * it passes. Idempotent: an already-existing directory validates and
 * returns like statPath; an existing FILE at the path is a rejection.
 */
export function createFolder(p: string, home: string = homedir()): PathStat {
  if (p.length === 0) throw new FsError("path is required");
  const homeReal = toReal(home);
  const resolved = path.resolve(expandHomeInput(p.trim(), home));

  // Walk up to the deepest existing ancestor; it must really (realpath) live
  // under home — nothing is created before this passes.
  let ancestor = resolved;
  for (;;) {
    try {
      statSync(ancestor);
      break;
    } catch (err) {
      if ((err as { code?: string } | null)?.code === "ENOENT") {
        const parent = path.dirname(ancestor);
        if (parent === ancestor) throw ioError(err, "path not found");
        ancestor = parent;
        continue;
      }
      throw ioError(err, "cannot create folder");
    }
  }
  const relAncestor = path.relative(homeReal, toReal(ancestor));
  if (relAncestor.startsWith("..") || path.isAbsolute(relAncestor)) {
    throw new FsError("folder creation is only allowed inside your home directory");
  }

  try {
    mkdirSync(resolved, { recursive: true });
  } catch (err) {
    if ((err as { code?: string } | null)?.code !== "EEXIST") {
      throw ioError(err, "cannot create folder");
    }
    // EEXIST: something appeared at the path meanwhile — statPath below
    // accepts a directory and rejects a file.
  }
  return statPath(resolved, home);
}
