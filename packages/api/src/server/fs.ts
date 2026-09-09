import { mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  createFolder,
  expandHomeInput,
  FsError,
  ioError,
  statPath,
  toReal,
  type PathStat,
} from "@bai/core";

/**
 * Filesystem support for the web workspace view — read-only, error-mapped,
 * and scoped:
 *
 * - `listDir` lists ONE directory (lazy expansion client-side). Both root
 *   and sub-path are resolved through realpath (symlinks expanded), so a
 *   symlink inside a workspace cannot escape it. IO errors map to plain
 *   user-facing messages (ENOENT → "path not found", EACCES/EPERM →
 *   "permission denied", …).
 * - `readFile` validates ONE file for content preview (same realpath
 *   containment as listDir, but the target must be a file) and reports the
 *   mime + size caps the route enforces when streaming the bytes.
 * - `ensureRegisteredRoot` restricts listing/reading to workspace paths
 *   registered in config — the file tree can only browse workspaces, never
 *   arbitrary machine paths (defense in depth; a registered workspace the
 *   OS user cannot read still fails with "permission denied" at listing
 *   time).
 * - `statPath` / `createFolder` (the add-workspace flow's validate/create
 *   pair, home-only creation) live in @bai/core — the workspace.create
 *   agent tool shares their exact guards.
 * - `completePath` completes one path segment against its parent directory
 *   (directories only, capped). It intentionally works on any readable
 *   directory: suggesting folder names is its job; it reveals no file
 *   content and the endpoint is bearer-guarded beyond loopback.
 */

export { createFolder, statPath, FsError, type PathStat };

export interface FsEntry {
  name: string;
  type: "dir" | "file";
}

export interface FsListing {
  path: string;
  root: string;
  entries: FsEntry[];
  truncated: boolean;
}

export interface PathCompletion {
  /** Real parent directory the suggestions live in. */
  base: string;
  /** The (possibly empty) partial segment being completed. */
  prefix: string;
  /** Matching directory NAMES (join with base to get full paths). */
  entries: string[];
  truncated: boolean;
}

export const FS_LIST_CAP = 1000;
export const COMPLETE_CAP = 50;

/**
 * Require `root` to be one of the registered workspace paths (compared via
 * realpath on both sides, so symlinked registrations match). Returns the
 * resolved root. Unregisterable entries (deleted workspaces) are skipped.
 */
export function ensureRegisteredRoot(root: string, workspaces: readonly string[]): string {
  if (root.length === 0) throw new FsError("root is required");
  const resolvedRoot = toReal(root);
  const registered = (workspaces ?? []).some((w) => {
    try {
      return toReal(w) === resolvedRoot;
    } catch {
      return false; // registered path vanished — can't match it
    }
  });
  if (!registered) throw new FsError("root is not a registered workspace");
  return resolvedRoot;
}

/**
 * List one directory inside `root`. `sub` defaults to the root itself.
 * Both paths are realpath'd and `sub` must stay within the real root —
 * a symlink pointing outside the workspace is rejected, not followed.
 */
export function listDir(root: string, sub?: string): FsListing {
  if (root.length === 0) throw new FsError("root is required");
  const resolvedRoot = toReal(root);
  const target = sub === undefined || sub.length === 0 ? resolvedRoot : toReal(sub);
  const rel = path.relative(resolvedRoot, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new FsError("path escapes the workspace root");
  }

  let stat;
  try {
    stat = statSync(target);
  } catch (err) {
    throw ioError(err, "path not found");
  }
  if (!stat.isDirectory()) throw new FsError("path is not a directory");

  let names: string[];
  try {
    names = readdirSync(target);
  } catch (err) {
    throw ioError(err, "cannot read folder");
  }

  const entries: FsEntry[] = [];
  for (const name of names) {
    let isDir: boolean;
    try {
      isDir = statSync(path.join(target, name)).isDirectory();
    } catch {
      // Raced a delete, or an unreadable node — skip rather than fail the
      // whole listing (the parent was readable; children may not be).
      continue;
    }
    entries.push({ name, type: isDir ? "dir" : "file" });
  }
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const truncated = entries.length > FS_LIST_CAP;
  return {
    path: target,
    root: resolvedRoot,
    entries: truncated ? entries.slice(0, FS_LIST_CAP) : entries,
    truncated,
  };
}

/** Preview size caps: text (Monaco) files vs media (image/pdf/video) files. */
export const FS_TEXT_MAX_BYTES = 1024 * 1024; // 1 MB
export const FS_MEDIA_MAX_BYTES = 64 * 1024 * 1024; // 64 MB

/**
 * Mime types worth previewing as media (image / pdf / video), by extension.
 * EVERYTHING else — including html/xml and js — serves as `text/plain`:
 * a blob-iframe on the app origin must never receive executable or
 * document content (GitHub-raw-style sanitization; the web client renders
 * text files as source in the editor, never as documents).
 */
const MEDIA_MIME: Record<string, string> = {
  // images
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml", // safe: the client renders svg only via <img>
  // documents
  pdf: "application/pdf",
  // video
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  ogv: "video/ogg",
  mkv: "video/x-matroska",
};

/** Best-effort mime for a file name — media map, else text/plain. */
export function fileMime(name: string): string {
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
  return MEDIA_MIME[ext] ?? "text/plain";
}

export interface FilePreview {
  /** Realpath of the file — the route streams it via Bun.file. */
  path: string;
  /** Sanitized mime (never text/html or text/javascript). */
  mime: string;
  /** Stat'd size in bytes — the cap was checked against this. */
  size: number;
}

/**
 * Validate ONE file for content preview inside `root`. Same realpath
 * containment as listDir (a symlink pointing outside the workspace is
 * rejected, not followed), but the target must be a FILE. Size caps are
 * checked against the stat'd size: 1 MB for text (the editor's budget),
 * 64 MB for media. Returns the resolved path + sanitized mime for the
 * route to stream — no bytes are read here.
 */
export function readFile(root: string, sub?: string): FilePreview {
  if (root.length === 0) throw new FsError("root is required");
  const resolvedRoot = toReal(root);
  const target = sub === undefined || sub.length === 0 ? resolvedRoot : toReal(sub);
  const rel = path.relative(resolvedRoot, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new FsError("path escapes the workspace root");
  }

  let stat;
  try {
    stat = statSync(target);
  } catch (err) {
    throw ioError(err, "path not found");
  }
  if (!stat.isFile()) throw new FsError("path is not a file");

  const mime = fileMime(target);
  const cap = mime === "text/plain" ? FS_TEXT_MAX_BYTES : FS_MEDIA_MAX_BYTES;
  if (stat.size > cap) throw new FsError("file too large");
  return { path: target, mime, size: stat.size };
}

/**
 * Complete ONE path segment: split the partial input into parent directory
 * + prefix, list the parent's subdirectories, and return those matching the
 * prefix (case-insensitive). `~` expands to the home directory, empty input
 * completes the home directory's children, and anything else not starting
 * with `/` or `~` is a search UNDER the home directory ("Doc" → "~/Doc").
 * Hidden (dot) directories are only suggested when the prefix itself starts
 * with a dot (shell convention) or when `includeHidden` is set — the
 * explorer's show-dotfiles toggle.
 */
export function completePath(
  partial: string,
  home: string = homedir(),
  includeHidden = false,
): PathCompletion {
  const p = expandHomeInput(partial.trim(), home);
  if (!path.isAbsolute(p)) throw new FsError("enter an absolute folder path");

  let base: string;
  let prefix: string;
  if (p.endsWith(path.sep)) {
    base = p;
    prefix = "";
  } else {
    base = path.dirname(p);
    prefix = path.basename(p);
  }

  const realBase = toReal(base); // ENOENT / EACCES on any ancestor → mapped message
  let names: string[];
  try {
    names = readdirSync(realBase);
  } catch (err) {
    throw ioError(err, "cannot read folder");
  }

  const lower = prefix.toLowerCase();
  const dirs: string[] = [];
  for (const name of names) {
    if (!includeHidden && !lower.startsWith(".") && name.startsWith(".")) continue;
    if (prefix.length > 0 && !name.toLowerCase().startsWith(lower)) continue;
    let isDir: boolean;
    try {
      isDir = statSync(path.join(realBase, name)).isDirectory();
    } catch {
      continue; // unreadable/raced child — not suggestible
    }
    if (isDir) dirs.push(name);
  }
  dirs.sort((a, b) => a.localeCompare(b));

  const truncated = dirs.length > COMPLETE_CAP;
  return {
    base: realBase,
    prefix,
    entries: truncated ? dirs.slice(0, COMPLETE_CAP) : dirs,
    truncated,
  };
}
