import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Bundled skills — the repo's `skills/` directory seeded into the user's
 * skills dir on boot (hermes skills_sync parity, single-profile simplification).
 *
 * Provenance manifest (`<skillsDir>/.bundled_manifest`, one `name:hash` line
 * per synced skill; hash = MD5 over the bundled skill directory's sorted
 * relative paths + bytes) drives the decision matrix:
 *
 *   NEW (not in manifest)                      → copy, record hash
 *   pristine + bundled unchanged               → skip (fast path)
 *   pristine + bundled changed                 → update (`.bak` safety swap)
 *   user-modified (hash ≠ origin)              → skip FOREVER (never overwritten)
 *   user-deleted (manifest entry, no dir)      → respected, never reseeded
 *   removed from bundled                       → manifest entry cleaned
 *
 * A copy failure records no manifest entry (the next boot retries) and never
 * touches the user's copy. The opt-out marker (`.no-bundled-skills` in the
 * config dir) disables seeding entirely.
 */

const MANIFEST_NAME = ".bundled_manifest";

export interface BundledSyncResult {
  copied: string[];
  updated: string[];
  skipped: string[];
  userModified: string[];
  /** Manifest entries whose skills vanished from the bundled tree. */
  cleaned: string[];
  /** User-created skills whose name collided with a bundled one (left alone). */
  untrackedCollisions: string[];
  totalBundled: number;
  skippedOptOut: boolean;
}

/**
 * Resolve the bundled skills directory: `BAI_BUNDLED_SKILLS` env → source
 * tree (running from source) → compile-embedded assets / executable sibling
 * (staged by the Makefile for bun < 1.4). Undefined → sync is skipped.
 * Mirrors webDistDir()'s resolution order.
 *
 * Layout: the bundled skills live at `packages/core/skills/` — a sibling of
 * `src/`, so source mode is one `..` + `skills` from this module's dir. In
 * the compiled binary the embedded assets keep their repo-relative paths;
 * the exact virtual layout is covered by the candidate list below (verified
 * against the compiled binary).
 */
export function bundledSkillsDir(): string | undefined {
  const env = process.env.BAI_BUNDLED_SKILLS;
  if (env !== undefined && env !== "") return env;
  const candidates = [
    // Source mode: <repo>/packages/core/src/skills → <repo>/packages/core/skills.
    path.join(import.meta.dir, "..", "..", "skills"),
    // Compiled (bun ≥ 1.4 assets): the embedded repo-relative
    // packages/core/skills under the plausible virtual roots.
    path.join(import.meta.dir, "skills"),
    path.join(import.meta.dir, "src", "skills"),
    path.join(import.meta.dir, "src", "packages", "core", "skills"),
    path.join(import.meta.dir, "..", "src", "packages", "core", "skills"),
    // Staged binaries (bun < 1.4): sibling of the executable (dist/skills).
    path.join(path.dirname(process.execPath), "skills"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** MD5 over the directory's sorted relative paths + file bytes (hermes _dir_hash). */
export function dirHash(dir: string): string {
  const files: string[] = [];
  const walk = (d: string, prefix: string): void => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (entry.isDirectory()) walk(path.join(d, entry.name), `${prefix}${entry.name}/`);
      else if (entry.isFile()) files.push(`${prefix}${entry.name}`);
    }
  };
  walk(dir, "");
  const hash = createHash("md5");
  for (const rel of files.sort()) {
    hash.update(rel);
    hash.update(readFileSync(path.join(dir, rel)));
  }
  return hash.digest("hex");
}

/** Read the manifest into a map (malformed lines skipped). */
function readManifest(file: string): Map<string, string> {
  const map = new Map<string, string>();
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      const idx = trimmed.indexOf(":");
      if (idx <= 0) continue;
      map.set(trimmed.slice(0, idx), trimmed.slice(idx + 1));
    }
  } catch {
    // No manifest yet — everything is new.
  }
  return map;
}

/** Atomic manifest write (tmp + rename). */
function writeManifest(file: string, manifest: Map<string, string>): void {
  const body = [...manifest.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, hash]) => `${name}:${hash}`).join("\n");
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, body.length > 0 ? `${body}\n` : "");
  renameSync(tmp, file);
}

/** Discover bundled skills: `<bundledDir>/<name>/SKILL.md` (flat, no categories). */
function discoverBundled(bundledDir: string): string[] {
  let entries;
  try {
    entries = readdirSync(bundledDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .filter((name) => existsSync(path.join(bundledDir, name, "SKILL.md")))
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Sync bundled skills into the user's skills dir. Best-effort: individual
 * failures skip that skill (no manifest entry) without breaking the rest.
 */
export function syncBundledSkills(opts: {
  bundledDir: string;
  skillsDir: string;
  /** Opt-out marker path — when it exists, seeding is skipped entirely. */
  optOutFile?: string;
}): BundledSyncResult {
  const result: BundledSyncResult = {
    copied: [],
    updated: [],
    skipped: [],
    userModified: [],
    cleaned: [],
    untrackedCollisions: [],
    totalBundled: 0,
    skippedOptOut: false,
  };
  if (opts.optOutFile !== undefined && existsSync(opts.optOutFile)) {
    result.skippedOptOut = true;
    return result;
  }
  const bundled = discoverBundled(opts.bundledDir);
  result.totalBundled = bundled.length;
  if (bundled.length === 0) return result;

  mkdirSync(opts.skillsDir, { recursive: true });
  const manifestFile = path.join(opts.skillsDir, MANIFEST_NAME);
  const manifest = readManifest(manifestFile);
  const bundledSet = new Set(bundled);

  for (const name of bundled) {
    const src = path.join(opts.bundledDir, name);
    const dest = path.join(opts.skillsDir, name);
    const bundledHash = dirHash(src);
    if (bundledHash.length === 0) {
      // Unreadable bundled source — skip without a manifest entry (the next
      // boot retries); never poison the manifest with an empty hash.
      result.skipped.push(name);
      continue;
    }
    const originHash = manifest.get(name);

    if (!existsSync(dest)) {
      if (originHash !== undefined) {
        // User-deleted: respected — the manifest entry stays, so the skill
        // never comes back on a later boot.
        result.skipped.push(name);
        continue;
      }
      // New: copy; a failure records no manifest entry (retry next boot).
      try {
        cpSync(src, dest, { recursive: true });
        manifest.set(name, bundledHash);
        result.copied.push(name);
      } catch {
        result.skipped.push(name);
      }
      continue;
    }

    if (originHash === undefined) {
      // Untracked destination: baseline a pristine copy; a user-created skill
      // with the same name is left completely alone.
      if (dirHash(dest) === bundledHash) {
        manifest.set(name, bundledHash);
        result.skipped.push(name);
      } else {
        result.untrackedCollisions.push(name);
      }
      continue;
    }

    if (bundledHash === originHash) {
      // Fast path: bundled unchanged since the last sync.
      result.skipped.push(name);
      continue;
    }

    const userHash = dirHash(dest);
    if (userHash !== originHash) {
      // User modified their copy — frozen forever (until manual reset).
      result.userModified.push(name);
      continue;
    }
    // Pristine + upstream changed: safe upgrade with .bak rollback.
    const backup = `${dest}.bak`;
    try {
      rmSync(backup, { recursive: true, force: true });
      renameSync(dest, backup);
      cpSync(src, dest, { recursive: true });
      manifest.set(name, bundledHash);
      rmSync(backup, { recursive: true, force: true });
      result.updated.push(name);
    } catch {
      // Restore the user's copy; keep the old manifest entry.
      try {
        rmSync(dest, { recursive: true, force: true });
        renameSync(backup, dest);
      } catch {
        // Snapshot kept at .bak for manual recovery.
      }
      result.skipped.push(name);
    }
  }

  // Skills removed from the bundled tree: clean their manifest entries.
  for (const name of [...manifest.keys()]) {
    if (!bundledSet.has(name)) {
      manifest.delete(name);
      result.cleaned.push(name);
    }
  }

  writeManifest(manifestFile, manifest);
  return result;
}
