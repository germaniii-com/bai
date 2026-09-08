import path from "node:path";
import { SKILL_SUPPORT_DIRS } from "@bai/shared";

/**
 * Shared guard for linked-file operations (skills.writeFile, skills.patch,
 * skills.delete file-mode, and the Service file endpoints): a path is valid
 * when it is relative, contains no ".." segments, starts with one of the
 * progressive-disclosure support directories, and resolves inside the skill
 * directory. One guard, four callers — the tools and the API can never drift.
 */

export type LinkedPathResult =
  | { ok: true; /** The validated absolute path. */ resolved: string; /** The normalized relative path. */ relative: string }
  | { ok: false; /** Human-readable rejection (safe to show the model/user). */ error: string };

/** Validate + resolve a linked-file path against a skill directory. */
export function resolveLinkedPath(skillDir: string, rawPath: string): LinkedPathResult {
  const clean = rawPath.trim();
  if (clean.length === 0) {
    return { ok: false, error: "path must be a relative path starting with references/, templates/, scripts/, or assets/." };
  }
  if (path.isAbsolute(clean) || clean.split("/").some((segment) => segment === "..")) {
    return { ok: false, error: "path must be relative and start with one of: " + supportList() + " (no \"..\")." };
  }
  const head = clean.split("/")[0] ?? "";
  if (!SKILL_SUPPORT_DIRS.includes(head as (typeof SKILL_SUPPORT_DIRS)[number])) {
    return { ok: false, error: "path must be relative and start with one of: " + supportList() + "." };
  }
  const root = path.resolve(skillDir);
  const resolved = path.resolve(root, clean);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    return { ok: false, error: `Path escapes the skill directory: ${clean}` };
  }
  return { ok: true, resolved, relative: clean };
}

function supportList(): string {
  return SKILL_SUPPORT_DIRS.map((d) => `${d}/`).join(", ");
}
