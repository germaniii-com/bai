import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirHash, syncBundledSkills } from "../src/skills/bundled";
import { parseSkillMarkdown } from "../src/skills/registry";

/**
 * Bundled skills sync (hermes skills_sync parity): the manifest decision
 * matrix — new copies, pristine updates with .bak safety, user-modified
 * freezes, user-deletion stickiness, upstream cleanup, opt-out.
 */
describe("bundled skills sync", () => {
  let bundled: string;
  let skillsDir: string;
  let optOut: string;

  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), "bai-bundled-"));
    bundled = join(root, "bundled");
    skillsDir = join(root, "skills");
    optOut = join(root, ".no-bundled-skills");
    mkdirSync(bundled, { recursive: true });
    writeSkill(bundled, "alpha", "Alpha skill.", "Alpha body v1.");
    writeSkill(bundled, "beta", "Beta skill.", "Beta body v1.");
  });

  afterEach(() => {
    rmSync(join(bundled, ".."), { recursive: true, force: true });
  });

  function writeSkill(dir: string, name: string, description: string, body: string): void {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, "SKILL.md"), `---\ndescription: ${description}\n---\n${body}`);
  }

  test("first sync copies everything and writes the manifest", () => {
    const result = syncBundledSkills({ bundledDir: bundled, skillsDir, optOutFile: optOut });
    expect(result.copied.sort()).toEqual(["alpha", "beta"]);
    expect(result.totalBundled).toBe(2);
    expect(existsSync(join(skillsDir, "alpha", "SKILL.md"))).toBe(true);
    const manifest = readFileSync(join(skillsDir, ".bundled_manifest"), "utf8");
    expect(manifest).toContain("alpha:");
    expect(manifest).toContain("beta:");
  });

  test("second sync is a no-op (fast path)", () => {
    syncBundledSkills({ bundledDir: bundled, skillsDir, optOutFile: optOut });
    const again = syncBundledSkills({ bundledDir: bundled, skillsDir, optOutFile: optOut });
    expect(again.copied).toEqual([]);
    expect(again.updated).toEqual([]);
    expect(again.skipped.sort()).toEqual(["alpha", "beta"]);
  });

  test("pristine copy updates when upstream changes; user-modified never does", () => {
    syncBundledSkills({ bundledDir: bundled, skillsDir, optOutFile: optOut });

    // Upstream changes BOTH skills; the user also modifies their beta copy.
    // (User modifications are only DETECTED when upstream changes too —
    // until then the fast path skips without even reading the user copy,
    // which protects the edit all the same.)
    writeSkill(bundled, "alpha", "Alpha skill.", "Alpha body v2 — new chapter.");
    writeSkill(bundled, "beta", "Beta skill.", "Beta body v2 — new chapter.");
    const betaCopy = join(skillsDir, "beta", "SKILL.md");
    writeFileSync(betaCopy, readFileSync(betaCopy, "utf8").replace("Beta body v1.", "Beta body v1 + my notes."));

    const result = syncBundledSkills({ bundledDir: bundled, skillsDir, optOutFile: optOut });
    expect(result.updated).toEqual(["alpha"]);
    expect(result.userModified).toEqual(["beta"]);
    // The update landed; the user's edit survived untouched.
    expect(readFileSync(join(skillsDir, "alpha", "SKILL.md"), "utf8")).toContain("v2 — new chapter.");
    expect(readFileSync(betaCopy, "utf8")).toContain("my notes.");
    // No .bak litter after a successful update.
    expect(existsSync(join(skillsDir, "alpha.bak"))).toBe(false);
  });

  test("user deletion is respected — never reseeded", () => {
    syncBundledSkills({ bundledDir: bundled, skillsDir, optOutFile: optOut });
    rmSync(join(skillsDir, "alpha"), { recursive: true });

    const result = syncBundledSkills({ bundledDir: bundled, skillsDir, optOutFile: optOut });
    expect(result.copied).toEqual([]); // NOT reseeded
    expect(existsSync(join(skillsDir, "alpha"))).toBe(false);
    // The manifest entry stays — the deletion remains sticky.
    expect(readFileSync(join(skillsDir, ".bundled_manifest"), "utf8")).toContain("alpha:");
  });

  test("skills removed upstream are cleaned from the manifest", () => {
    syncBundledSkills({ bundledDir: bundled, skillsDir, optOutFile: optOut });
    rmSync(join(bundled, "beta"), { recursive: true });

    const result = syncBundledSkills({ bundledDir: bundled, skillsDir, optOutFile: optOut });
    expect(result.cleaned).toEqual(["beta"]);
    expect(readFileSync(join(skillsDir, ".bundled_manifest"), "utf8")).not.toContain("beta:");
    // The user's copy is untouched by manifest cleanup.
    expect(existsSync(join(skillsDir, "beta", "SKILL.md"))).toBe(true);
  });

  test("an untracked user-created skill with a bundled name is left alone", () => {
    // The user created their own "alpha" before any sync ran.
    mkdirSync(join(skillsDir, "alpha"), { recursive: true });
    writeFileSync(join(skillsDir, "alpha", "SKILL.md"), "---\ndescription: My own alpha.\n---\nMine.");

    const result = syncBundledSkills({ bundledDir: bundled, skillsDir, optOutFile: optOut });
    expect(result.untrackedCollisions).toEqual(["alpha"]);
    expect(readFileSync(join(skillsDir, "alpha", "SKILL.md"), "utf8")).toContain("My own alpha.");
    // Not manifested — the user's version is never adopted as bundled.
    expect(readFileSync(join(skillsDir, ".bundled_manifest"), "utf8")).not.toContain("alpha:");
  });

  test("the opt-out marker skips seeding entirely", () => {
    writeFileSync(optOut, "opted out via marker\n");
    const result = syncBundledSkills({ bundledDir: bundled, skillsDir, optOutFile: optOut });
    expect(result.skippedOptOut).toBe(true);
    expect(existsSync(join(skillsDir, "alpha"))).toBe(false);
  });

  test("dirHash reflects content, not metadata", () => {
    const h1 = dirHash(bundled);
    // Touch a file without changing content (rewrite same bytes).
    const p = join(bundled, "alpha", "SKILL.md");
    writeFileSync(p, readFileSync(p, "utf8"));
    expect(dirHash(bundled)).toBe(h1);
    // Content change → hash change.
    writeSkill(bundled, "alpha", "Alpha skill.", "changed");
    expect(dirHash(bundled)).not.toBe(h1);
  });

  test("a failed copy leaves no manifest entry (retries next boot)", () => {
    // Make the bundled source unreadable — the hash pass fails, the skill is
    // skipped, and no manifest entry is written (the next boot retries).
    const alphaDir = join(bundled, "alpha");
    chmodSync(alphaDir, 0o000);
    try {
      const result = syncBundledSkills({ bundledDir: bundled, skillsDir, optOutFile: optOut });
      // alpha failed (unreadable source) — beta still copies fine.
      expect(result.copied).not.toContain("alpha");
      expect(result.copied).toContain("beta");
      expect(existsSync(join(skillsDir, "alpha"))).toBe(false);
      expect(readFileSync(join(skillsDir, ".bundled_manifest"), "utf8")).not.toContain("alpha:");
    } finally {
      chmodSync(alphaDir, 0o755); // restore for cleanup
    }
  });
});

/** The bundled-validity contract: every repo skill parses with a ≤60-char description. */
describe("repo bundled skills validity", () => {
  test("every skills/<name>/SKILL.md parses (valid YAML frontmatter) with a routable description", () => {
    // Resolved from the test dir regardless of the working directory
    // (test → packages/core → the bundled skills sibling of src/).
    const repo = join(import.meta.dir, "..", "skills");
    expect(existsSync(repo)).toBe(true);
    const names = readdirSyncSafe(repo);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const file = join(repo, name, "SKILL.md");
      expect(existsSync(file)).toBe(true);
      // Full parse — an unquoted colon or any YAML error fails here, the
      // exact crash class a bad bundled skill would cause at boot.
      const skill = parseSkillMarkdown(readFileSync(file, "utf8"), name, file);
      expect(skill).toBeDefined();
      expect(skill?.description.length).toBeLessThanOrEqual(60);
      expect(skill?.description.endsWith(".")).toBe(true);
    }
  });
});

function readdirSyncSafe(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name);
  } catch {
    return [];
  }
}
