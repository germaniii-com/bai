import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillRegistry, parseSkillMarkdown, serializeSkillMarkdown, skillTemplate } from "../src/skills/registry";

describe("skill markdown parsing", () => {
  test("frontmatter + body round-trip", () => {
    const md = serializeSkillMarkdown({
      description: "Search arXiv papers by keyword or ID.",
      version: "1.0.0",
      author: "bai",
      platforms: ["darwin", "linux"],
      tags: ["research", "papers"],
      body: "# arXiv Research\n\nSearch papers.",
    });
    const skill = parseSkillMarkdown(md, "arxiv", "/tmp/arxiv/SKILL.md");
    expect(skill).toBeDefined();
    expect(skill?.name).toBe("arxiv");
    expect(skill?.description).toBe("Search arXiv papers by keyword or ID.");
    expect(skill?.version).toBe("1.0.0");
    expect(skill?.author).toBe("bai");
    expect(skill?.platforms).toEqual(["darwin", "linux"]);
    expect(skill?.tags).toEqual(["research", "papers"]);
    expect(skill?.body).toBe("# arXiv Research\n\nSearch papers.");
    expect(skill?.source).toBe("file");
    expect(skill?.path).toBe("/tmp/arxiv/SKILL.md");
    expect(skill?.linkedFiles).toEqual([]);
  });

  test("frontmatter is REQUIRED (the index is built from the description)", () => {
    // A bare body is not a skill — unlike agents (bare persona prompts).
    expect(parseSkillMarkdown("Just instructions.", "bare", "/x/SKILL.md")).toBeUndefined();
    // Missing description fails the schema.
    expect(parseSkillMarkdown("---\nversion: 1.0.0\n---\nBody", "x", "/x/SKILL.md")).toBeUndefined();
    // Empty body rejected.
    expect(parseSkillMarkdown("---\ndescription: x\n---\n   ", "x", "/x/SKILL.md")).toBeUndefined();
  });

  test("invalid frontmatter is rejected (undefined)", () => {
    expect(parseSkillMarkdown("---\ntags: not-an-array\n---\nBody", "x", "/x/SKILL.md")).toBeUndefined();
    expect(parseSkillMarkdown("---\ndescription: 123\n---\nBody", "x", "/x/SKILL.md")).toBeUndefined();
  });
});

describe("skill registry", () => {
  let dir: string;
  let registry: SkillRegistry;
  let changes: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bai-skills-"));
    changes = 0;
    registry = new SkillRegistry({
      dir,
      debounceMs: 40,
      onChange: () => {
        changes++;
      },
    });
  });

  afterEach(() => {
    registry.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  const writeSkill = (name: string, md: string): string => {
    const skillDir = join(dir, name);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), md);
    return skillDir;
  };

  test("scan picks up dropped skill directories", () => {
    writeSkill("arxiv", "---\ndescription: Search arXiv papers.\n---\n# arXiv\n\nSearch.");
    expect(registry.scan()).toBe(true);
    const skill = registry.get("arxiv");
    expect(skill?.description).toBe("Search arXiv papers.");
    expect(skill?.body).toBe("# arXiv\n\nSearch.");
    expect(skill?.path).toBe(join(dir, "arxiv", "SKILL.md"));
  });

  test("the name is the directory stem (frontmatter carries no name)", () => {
    writeSkill("my-skill", "---\ndescription: d\n---\nBody");
    registry.scan();
    expect(registry.get("my-skill")?.name).toBe("my-skill");
  });

  test("directories without SKILL.md and invalid names are skipped", () => {
    mkdirSync(join(dir, "empty-dir"), { recursive: true });
    writeSkill("1bad", "---\ndescription: d\n---\nBody");
    writeSkill(".hidden", "---\ndescription: d\n---\nBody");
    registry.scan();
    expect(registry.get("empty-dir")).toBeUndefined();
    expect(registry.get("1bad")).toBeUndefined();
    expect(registry.get(".hidden")).toBeUndefined();
  });

  test("invalid frontmatter is skipped with the registry still serving the rest", () => {
    writeSkill("broken", "---\ntags: nope\n---\nBody");
    writeSkill("fine", "---\ndescription: d\n---\nBody");
    registry.scan();
    expect(registry.get("broken")).toBeUndefined();
    expect(registry.get("fine")).toBeDefined();
  });

  test("platform gate hides skills that exclude this platform", () => {
    writeSkill("windows-only", "---\ndescription: d\nplatforms: [win32]\n---\nBody");
    writeSkill("cross-platform", "---\ndescription: d\nplatforms: [darwin, linux, win32]\n---\nBody");
    registry.scan();
    // The test platform is whatever bun runs on — exactly one of these loads.
    const isWin = process.platform === "win32";
    expect(registry.get(isWin ? "windows-only" : "cross-platform")).toBeDefined();
    expect(registry.get(isWin ? "cross-platform" : "windows-only")).toBeUndefined();
  });

  test("platform gate is injectable (opts.platform)", () => {
    registry.stop();
    registry = new SkillRegistry({ dir, debounceMs: 40, platform: "linux" });
    writeSkill("linux-tool", "---\ndescription: d\nplatforms: [linux]\n---\nBody");
    writeSkill("mac-tool", "---\ndescription: d\nplatforms: [darwin]\n---\nBody");
    registry.scan();
    expect(registry.get("linux-tool")).toBeDefined();
    expect(registry.get("mac-tool")).toBeUndefined();
  });

  test("linked files are collected from the support directories", () => {
    const skillDir = writeSkill("packaged", "---\ndescription: d\n---\nBody");
    mkdirSync(join(skillDir, "references", "nested"), { recursive: true });
    mkdirSync(join(skillDir, "scripts"), { recursive: true });
    writeFileSync(join(skillDir, "references", "api.md"), "api docs");
    writeFileSync(join(skillDir, "references", "nested", "deep.md"), "deep");
    writeFileSync(join(skillDir, "scripts", "run.sh"), "echo hi");
    writeFileSync(join(skillDir, ".secret"), "nope");
    registry.scan();
    const skill = registry.get("packaged");
    expect(skill?.linkedFiles).toEqual(["references/api.md", "references/nested/deep.md", "scripts/run.sh"]);
  });

  test("deleted skills disappear from the registry", () => {
    writeSkill("gone", "---\ndescription: d\n---\nBody");
    registry.scan();
    expect(registry.get("gone")).toBeDefined();
    rmSync(join(dir, "gone"), { recursive: true });
    registry.scan();
    expect(registry.get("gone")).toBeUndefined();
  });

  test("watcher hot-reloads new skills without restart", async () => {
    writeSkill("hot", "---\ndescription: Hot skill.\n---\nHot body.");
    // fs.watch latency can spike under parallel test load — give it room.
    const deadline = Date.now() + 5000;
    while (registry.get("hot") === undefined && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(registry.get("hot")?.description).toBe("Hot skill.");
    expect(changes).toBeGreaterThan(0);
  });

  test("put writes SKILL.md and remove deletes the whole directory (CRUD path)", () => {
    const skill = registry.put("writer", { description: "w", body: "# Writer\n\nYou write.", tags: ["prose"] });
    expect(skill.name).toBe("writer");
    expect(existsSync(registry.fileFor("writer"))).toBe(true);
    const onDisk = readFileSync(registry.fileFor("writer"), "utf8");
    expect(onDisk).toContain("description: w");
    expect(onDisk).toContain("# Writer");

    // Linked files ride the directory — remove takes them with it.
    mkdirSync(join(registry.dirFor("writer"), "references"), { recursive: true });
    writeFileSync(join(registry.dirFor("writer"), "references", "x.md"), "x");
    registry.scan();
    expect(registry.get("writer")?.linkedFiles).toEqual(["references/x.md"]);

    expect(registry.remove("writer")).toBe(true);
    expect(existsSync(registry.dirFor("writer"))).toBe(false);
    expect(registry.get("writer")).toBeUndefined();
    expect(registry.remove("writer")).toBe(false);
  });

  test("put refuses invalid names", () => {
    expect(() => registry.put("9bad", { description: "d", body: "b" })).toThrow();
  });

  test("skillTemplate produces a valid skill", () => {
    const tpl = skillTemplate("deploy");
    expect(tpl.description.length).toBeGreaterThan(0);
    const skill = parseSkillMarkdown(serializeSkillMarkdown(tpl), "deploy", "/x/SKILL.md");
    expect(skill).toBeDefined();
    expect(skill?.body).toContain("# deploy");
  });
});
