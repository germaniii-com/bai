/**
 * Workspace external-folder helpers — pure string logic shared by the web rail,
 * both `#file` mention pickers, and core's mention expansion so they agree on
 * the derived folder alias and the root list.
 *
 * A workspace's extra folders live in `config.workspaceFolders[workspacePath]`.
 * Each extra gets a derived alias from its basename (whitespace collapsed to
 * `-`, `#` stripped), de-duplicated against the main workspace's basename and
 * the previously assigned aliases (`repo`, `repo-2`, …). Mentions address an
 * extra as `#<alias>/relative/path`; core maps the alias back to the absolute
 * folder root.
 */

export interface FolderAlias {
  alias: string;
  path: string;
}

/** Basename of an absolute POSIX path (trailing slashes ignored). */
export function pathBasename(p: string): string {
  const trimmed = p.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  return slash >= 0 ? trimmed.slice(slash + 1) || "/" : trimmed;
}

/** A mention-safe alias: no whitespace, no `#`, no separators; never empty. */
export function sanitizeAlias(name: string): string {
  const cleaned = name
    .replace(/\s+/g, "-")
    .replace(/[#/\\]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .trim();
  return cleaned.length > 0 ? cleaned : "folder";
}

/**
 * Derive the alias for every extra folder of `mainPath`, in array order.
 * Deterministic and collision-free within the workspace: the first extra keeps
 * its basename-derived alias, later clashes get `-2`, `-3`, ….
 */
export function deriveFolderAliases(mainPath: string, extras: readonly string[]): FolderAlias[] {
  const taken = new Set<string>([sanitizeAlias(pathBasename(mainPath))]);
  const out: FolderAlias[] = [];
  for (const p of extras) {
    const base = sanitizeAlias(pathBasename(p));
    let alias = base;
    for (let n = 2; taken.has(alias); n++) alias = `${base}-${n}`;
    taken.add(alias);
    out.push({ alias, path: p });
  }
  return out;
}

/** Alias → absolute folder root map for one workspace. */
export function folderAliasMap(mainPath: string, extras: readonly string[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const { alias, path } of deriveFolderAliases(mainPath, extras)) map[alias] = path;
  return map;
}

/**
 * Resolve a mention token whose first path segment is a folder alias to its
 * absolute path (the alias alone means the folder itself). Returns null when
 * the first segment is not an alias, so callers fall back to cwd-relative /
 * absolute resolution.
 */
export function resolveMentionAlias(token: string, aliases: Record<string, string>): string | null {
  const slash = token.indexOf("/");
  const first = slash >= 0 ? token.slice(0, slash) : token;
  const root = aliases[first];
  if (root === undefined) return null;
  const rest = slash >= 0 ? token.slice(slash + 1) : "";
  if (rest.length === 0) return root;
  return `${root.replace(/\/+$/, "")}/${rest}`;
}

/**
 * Map an alias token back to its owning root + relative path (the web viewer's
 * chip-open path). Returns null when `token` is not alias-qualified.
 */
export function resolveAliasPath(
  mainPath: string,
  extras: readonly string[],
  token: string,
): { root: string; rel: string } | null {
  const aliasMap = folderAliasMap(mainPath, extras);
  const slash = token.indexOf("/");
  const first = slash >= 0 ? token.slice(0, slash) : token;
  const root = aliasMap[first];
  if (root === undefined) return null;
  return { root, rel: slash >= 0 ? token.slice(slash + 1) : "" };
}

/** A mention picker candidate (mirrors the picker's entry shape). */
export interface MentionCandidate {
  path: string;
  type: "file" | "dir";
}

/**
 * Merge a workspace-root search with its external-folder searches into one
 * candidate list. Extra-folder results are rewritten to `alias/rel` tokens
 * (the form the server resolves); the main-root results lead. Capped so a
 * handful of extras can't flood the popover.
 */
export function mergeExternalResults(
  main: readonly MentionCandidate[],
  extras: ReadonlyArray<{ alias: string; results: readonly MentionCandidate[] }>,
  limit = 30,
): MentionCandidate[] {
  const out: MentionCandidate[] = [...main];
  for (const extra of extras) {
    for (const entry of extra.results) out.push({ path: `${extra.alias}/${entry.path}`, type: entry.type });
  }
  return out.slice(0, limit);
}

/**
 * Inverse of `resolveAliasPath`: the mention token for an absolute path.
 * Returns the workspace-relative path for the main root, `alias/rel` for an
 * extra folder, `alias` for an extra root itself, and `null` for the workspace
 * root or a path outside every browsable root.
 */
export function toMentionPath(
  workspaceRoot: string,
  extras: readonly string[],
  absPath: string,
): string | null {
  const norm = (p: string): string => p.replace(/\/+$/, "");
  const root = norm(workspaceRoot);
  const abs = norm(absPath);
  if (root.length === 0 || abs.length === 0 || abs === root) return null;
  if (abs.startsWith(`${root}/`)) return abs.slice(root.length + 1);
  for (const { alias, path } of deriveFolderAliases(workspaceRoot, extras)) {
    const r = norm(path);
    if (abs === r) return alias;
    if (abs.startsWith(`${r}/`)) return `${alias}/${abs.slice(r.length + 1)}`;
  }
  return null;
}

/**
 * Every absolute root the server may touch: the registered workspaces plus
 * every workspace's extra folders (de-duplicated, order preserved).
 */
export function registeredRoots(
  workspaces: readonly string[],
  workspaceFolders: Record<string, readonly string[]> | undefined,
): string[] {
  const out = [...workspaces];
  const seen = new Set(out);
  for (const list of Object.values(workspaceFolders ?? {})) {
    for (const p of list) {
      if (!seen.has(p)) {
        seen.add(p);
        out.push(p);
      }
    }
  }
  return out;
}
