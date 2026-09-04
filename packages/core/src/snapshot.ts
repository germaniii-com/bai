import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Shadow-repo snapshot service (opencode parity, packages/opencode/src/snapshot):
 * one git repository per worktree under `<root>/<sha256(cwd)>` whose
 * `--work-tree` points back at the session cwd. Trees are recorded with
 * `write-tree` and restored with `read-tree` + `checkout-index`, so file
 * changes made by tool calls can be rolled back on revert without touching
 * the project's own `.git`.
 *
 * Object database is seeded from the project repo via
 * `objects/info/alternates` — existing blobs are never re-hashed. Every git
 * operation is serialized per gitdir (a promise chain; git racing itself on
 * one index corrupts it). All operations are best-effort at the call sites:
 * they throw with the git stderr and callers decide to swallow.
 */

/** A recorded change-set: tree hash BEFORE the changes + files the changes touched. */
export interface SnapshotPatch {
  hash: string;
  files: string[];
}

/** Files larger than this are never staged (opencode's 2 MB limit). */
const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** Hard budget per git invocation — a hung git must not wedge a run. */
const GIT_TIMEOUT_MS = 30_000;
/** `git add` argument chunk size (stays under ARG_MAX). */
const ADD_CHUNK = 200;

export class Snapshot {
  private readonly locks = new Map<string, Promise<unknown>>();
  /** cwd → git-worktree probe result (a repo doesn't stop being one mid-boot). */
  private readonly worktrees = new Map<string, boolean>();

  /** @param root directory holding one shadow repo per worktree (e.g. dataDir()/snapshot). */
  constructor(private readonly root: string) {}

  /** True when `cwd` sits inside a git worktree (snapshots are only taken there). */
  async enabled(cwd: string): Promise<boolean> {
    const cached = this.worktrees.get(cwd);
    if (cached !== undefined) return cached;
    try {
      const out = await this.spawn(["-C", cwd, "rev-parse", "--is-inside-work-tree"], { timeoutMs: 5_000 });
      const ok = out.trim() === "true";
      this.worktrees.set(cwd, ok);
      return ok;
    } catch {
      this.worktrees.set(cwd, false);
      return false;
    }
  }

  /**
   * Stage the worktree's current state and return the tree hash (opencode's
   * `track`). Returns undefined when the cwd isn't a git worktree.
   */
  async track(cwd: string): Promise<string | undefined> {
    if (!(await this.enabled(cwd))) return undefined;
    return this.withLock(this.gitdir(cwd), async () => {
      await this.ensureInit(cwd);
      await this.stage(cwd);
      return (await this.git(cwd, ["write-tree"])).trim();
    });
  }

  /**
   * Files changed between `hash` and the worktree's current state (opencode's
   * `patch`) — the `files` half of a patch part. Returns undefined when not a
   * git worktree; an empty array means nothing changed (no patch part needed).
   */
  async patch(cwd: string, hash: string): Promise<string[] | undefined> {
    if (!(await this.enabled(cwd))) return undefined;
    return this.withLock(this.gitdir(cwd), async () => {
      await this.ensureInit(cwd);
      await this.stage(cwd);
      const out = await this.git(cwd, ["diff", "--cached", "--name-only", "-z", hash, "--"]);
      return out.split("\0").filter((f) => f.length > 0);
    });
  }

  /**
   * Force the worktree back to `hash` (opencode's `restore` — unrevert target).
   * Writes every file of the tree; extra files added since the snapshot are
   * left alone (opencode does the same — the revert path handles removals).
   */
  async restore(cwd: string, hash: string): Promise<void> {
    await this.withLock(this.gitdir(cwd), async () => {
      await this.ensureInit(cwd);
      await this.git(cwd, ["read-tree", hash]);
      await this.git(cwd, ["checkout-index", "-a", "-f"]);
    });
  }

  /**
   * Roll back each recorded change-set (opencode's `revert`): every file is
   * checked out from its patch's pre-change tree; files that didn't exist in
   * that tree are deleted from the worktree.
   */
  async revert(cwd: string, patches: SnapshotPatch[]): Promise<void> {
    if (patches.length === 0) return;
    await this.withLock(this.gitdir(cwd), async () => {
      await this.ensureInit(cwd);
      for (const patch of patches) {
        for (const file of patch.files) {
          // Exit-code probe (cat-file -e): the file only had a blob in the
          // pre-change tree when git says so.
          const existed = await this.gitSucceeds(cwd, ["cat-file", "-e", `${patch.hash}:${file}`]);
          if (existed) {
            await this.git(cwd, ["checkout", patch.hash, "--", file]);
          } else {
            // The batch created this file — the pre-change tree has no blob
            // for it, so reverting means deleting it from the worktree. The
            // shadow index self-heals on the next stage (ls-files -d → add).
            rmSync(join(cwd, file), { force: true, recursive: true });
          }
        }
      }
    });
  }

  /**
   * Unified diff between `hash` and the worktree's current state (opencode's
   * `diff`) — stored on the revert state for the surfaces' banner.
   */
  async diff(cwd: string, hash: string): Promise<string | undefined> {
    if (!(await this.enabled(cwd))) return undefined;
    return this.withLock(this.gitdir(cwd), async () => {
      await this.ensureInit(cwd);
      await this.stage(cwd);
      return this.git(cwd, ["diff", "--cached", hash, "--"]);
    });
  }

  // --- internals -------------------------------------------------------------

  private gitdir(cwd: string): string {
    return join(this.root, createHash("sha256").update(cwd).digest("hex"));
  }

  /** Serialize git work per gitdir — concurrent git on one index corrupts it. */
  private withLock<T>(gitdir: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(gitdir) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(gitdir, next.catch(() => {}));
    return next;
  }

  /** Init the shadow repo once, seeding the project repo's object database. */
  private async ensureInit(cwd: string): Promise<void> {
    const gitdir = this.gitdir(cwd);
    mkdirSync(gitdir, { recursive: true });
    if (!existsSync(join(gitdir, "HEAD"))) {
      await this.git(cwd, ["init", "--quiet"]);
    }
    // Alternates: borrow the project repo's objects so huge repos aren't
    // re-hashed into the shadow repo. Re-resolved per call — cheap (one
    // rev-parse) and self-repairs if the source repo moved.
    const alternatesPath = join(gitdir, "objects", "info", "alternates");
    if (!existsSync(alternatesPath)) {
      try {
        const raw = await this.git(cwd, ["-C", cwd, "rev-parse", "--git-path", "objects"], { timeoutMs: 5_000 });
        const objectsDir = resolve(cwd, raw.trim());
        if (objectsDir !== join(gitdir, "objects")) {
          mkdirSync(join(gitdir, "objects", "info"), { recursive: true });
          writeFileSync(alternatesPath, `${objectsDir}\n`);
        }
      } catch {
        // No source object db (e.g. cwd repo without objects yet) — the shadow
        // repo just stores its own objects.
      }
    }
  }

  /**
   * Stage the worktree's current state into the shadow index: modified,
   * untracked and deleted paths (gitignore-aware via --exclude-standard),
   * capped at 2 MB per file, added in ARG_MAX-safe chunks. The next
   * write-tree/diff then reflects reality.
   */
  private async stage(cwd: string): Promise<void> {
    const listed = await this.git(cwd, ["ls-files", "-m", "-o", "-d", "-z", "--exclude-standard"]);
    const paths = listed.split("\0").filter((f) => f.length > 0).filter((f) => {
      const abs = join(cwd, f);
      if (!existsSync(abs)) return true; // deletions must be staged too
      try {
        return statSync(abs).size <= MAX_FILE_BYTES;
      } catch {
        return false;
      }
    });
    for (let i = 0; i < paths.length; i += ADD_CHUNK) {
      await this.git(cwd, ["add", "--", ...paths.slice(i, i + ADD_CHUNK)]);
    }
  }

  /**
   * One git invocation with the shadow gitdir + work-tree wired in. Throws
   * with stderr on non-zero exit unless `allowFail`; kills hung processes at
   * `timeoutMs`.
   */
  private async git(
    cwd: string,
    args: string[],
    opts: { timeoutMs?: number; allowFail?: boolean } = {},
  ): Promise<string> {
    return this.spawn(["--git-dir", this.gitdir(cwd), "--work-tree", cwd, ...args], opts);
  }

  private async spawn(
    args: string[],
    opts: { timeoutMs?: number; allowFail?: boolean } = {},
  ): Promise<string> {
    const timeoutMs = opts.timeoutMs ?? GIT_TIMEOUT_MS;
    const proc = Bun.spawn({
      cmd: ["git", ...args],
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => proc.kill(9), timeoutMs);
    let stdout = "";
    let stderr = "";
    try {
      [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const code = await proc.exited;
      if (code !== 0 && !opts.allowFail) {
        throw new Error(`git ${args.slice(0, 3).join(" ")} failed (${code}): ${stderr.trim() || "no stderr"}`);
      }
      return stdout;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Exit-code probe (e.g. cat-file -e): true when git succeeds. */
  private async gitSucceeds(cwd: string, args: string[]): Promise<boolean> {
    const proc = Bun.spawn({
      cmd: ["git", "--git-dir", this.gitdir(cwd), "--work-tree", cwd, ...args],
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    const timer = setTimeout(() => proc.kill(9), GIT_TIMEOUT_MS);
    try {
      return (await proc.exited) === 0;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** The snapshot root for a data dir (mirrors cli/src/paths.ts layout). */
export function snapshotDir(dataDir: string): string {
  return join(dataDir, "snapshot");
}
