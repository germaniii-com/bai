import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeCore, waitForEvent, type TestCore } from "./harness";

/**
 * Skill authoring tools (skills.save / skills.writeFile) — the write side of
 * progressive disclosure and the primitive the learn flow runs on.
 */
describe("skills.save tool", () => {
  let t: TestCore;

  beforeEach(() => {
    t = makeCore();
  });

  afterEach(() => {
    t.store.close();
  });

  const ctx = () => ({
    sessionId: t.core.createSession({ workbench: "chat" }).id,
    signal: new AbortController().signal,
    emitLive: () => {},
  });

  test("creates a skill file and broadcasts skills.updated", async () => {
    const updated = waitForEvent(t.bus, "skills.updated");
    const result = await t.tools.execute(
      "skills.save",
      { skill: "arxiv", description: "Search arXiv papers by keyword or ID.", body: "# arXiv\n\nSearch.", tags: ["research"] },
      ctx(),
    );
    expect(result.content).toContain("Saved skill");
    await updated; // the registry's onChange broadcast fired

    const skill = t.skills.get("arxiv");
    expect(skill?.description).toBe("Search arXiv papers by keyword or ID.");
    expect(skill?.tags).toEqual(["research"]);
    expect(existsSync(t.skills.fileFor("arxiv"))).toBe(true);
  });

  test("replaces an existing skill (the extend path re-saves the merged body)", async () => {
    await t.tools.execute("skills.save", { skill: "x", description: "First.", body: "v1" }, ctx());
    await t.tools.execute("skills.save", { skill: "x", description: "Second.", body: "v1\nv2" }, ctx());
    expect(t.skills.get("x")?.body).toBe("v1\nv2");
    expect(t.skills.get("x")?.description).toBe("Second.");
  });

  test("validation rejections", async () => {
    const ctxv = ctx();
    await expect(t.tools.execute("skills.save", { skill: "9bad", description: "d", body: "b" }, ctxv)).rejects.toThrow("skill must start");
    await expect(t.tools.execute("skills.save", { skill: "ok", description: "", body: "b" }, ctxv)).rejects.toThrow("description");
    await expect(t.tools.execute("skills.save", { skill: "ok", description: "d", body: "  " }, ctxv)).rejects.toThrow("body");
  });
});

describe("skills.writeFile tool", () => {
  let t: TestCore;

  beforeEach(() => {
    t = makeCore();
    t.skills.put("book", { description: "A distilled book.", body: "# Book\n\nIndex of chapters." });
  });

  afterEach(() => {
    t.store.close();
  });

  const ctx = () => ({
    sessionId: t.core.createSession({ workbench: "chat" }).id,
    signal: new AbortController().signal,
    emitLive: () => {},
  });

  test("writes a linked file under references/ and refreshes linkedFiles", async () => {
    const result = await t.tools.execute(
      "skills.writeFile",
      { skill: "book", path: "references/ch01.md", content: "# Chapter 1\n\nDistilled structure." },
      ctx(),
    );
    expect(result.content).toContain("Wrote references/ch01.md");
    const onDisk = readFileSync(join(t.skills.dirFor("book"), "references", "ch01.md"), "utf8");
    expect(onDisk).toContain("Chapter 1");
    // The registry's cached linkedFiles set refreshed.
    expect(t.skills.get("book")?.linkedFiles).toContain("references/ch01.md");
  });

  test("nested directories are created; scripts/ and templates/ are allowed", async () => {
    await t.tools.execute("skills.writeFile", { skill: "book", path: "references/deep/ch02.md", content: "c2" }, ctx());
    await t.tools.execute("skills.writeFile", { skill: "book", path: "scripts/run.sh", content: "echo hi" }, ctx());
    await t.tools.execute("skills.writeFile", { skill: "book", path: "templates/notes.md", content: "tpl" }, ctx());
    expect(existsSync(join(t.skills.dirFor("book"), "references", "deep", "ch02.md"))).toBe(true);
    expect(existsSync(join(t.skills.dirFor("book"), "scripts", "run.sh"))).toBe(true);
  });

  test("rejects unknown skills, escapes, and non-support paths", async () => {
    const ctxv = ctx();
    await expect(t.tools.execute("skills.writeFile", { skill: "ghost", path: "references/x.md", content: "c" }, ctxv)).rejects.toThrow(
      "Unknown skill",
    );
    await expect(t.tools.execute("skills.writeFile", { skill: "book", path: "../escape.md", content: "c" }, ctxv)).rejects.toThrow(
      "path must be relative",
    );
    await expect(t.tools.execute("skills.writeFile", { skill: "book", path: "/etc/passwd", content: "c" }, ctxv)).rejects.toThrow(
      "path must be relative",
    );
    await expect(t.tools.execute("skills.writeFile", { skill: "book", path: "notices/x.md", content: "c" }, ctxv)).rejects.toThrow(
      "path must be relative",
    );
    await expect(t.tools.execute("skills.writeFile", { skill: "book", path: "references/y.md", content: "  " }, ctxv)).rejects.toThrow(
      "content",
    );
  });

  test("a pre-existing stray file in the skill dir is not linked until scanned", async () => {
    // Files outside the support dirs are never linked (SKILL.md's siblings).
    const stray = join(t.skills.dirFor("book"), "notes.txt");
    writeFileSync(stray, "stray");
    t.skills.scan();
    expect(t.skills.get("book")?.linkedFiles).toEqual([]);
  });
});

describe("skills.patch tool", () => {
  let t: TestCore;

  beforeEach(() => {
    t = makeCore();
    t.skills.put("book", {
      description: "A distilled book.",
      body: "# Book\n\n## Core Models\n\nReplication is the heart of distributed storage.\n\n## Pitfalls\n\nClocks lie.",
    });
  });

  afterEach(() => {
    t.store.close();
  });

  const ctx = () => ({
    sessionId: t.core.createSession({ workbench: "chat" }).id,
    signal: new AbortController().signal,
    emitLive: () => {},
  });

  test("surgical SKILL.md edit preserves frontmatter and refreshes the cache", async () => {
    const result = await t.tools.execute(
      "skills.patch",
      { skill: "book", oldString: "Clocks lie.", newString: "Clocks lie, and networks partition." },
      ctx(),
    );
    expect(result.content).toContain("1 replacement");
    // The raw file kept its frontmatter; the body changed.
    const raw = readFileSync(t.skills.fileFor("book"), "utf8");
    expect(raw).toContain("description: A distilled book.");
    expect(raw).toContain("Clocks lie, and networks partition.");
    // The registry's parsed cache refreshed.
    expect(t.skills.get("book")?.body).toContain("Clocks lie, and networks partition.");
  });

  test("patches a linked file", async () => {
    await t.tools.execute("skills.writeFile", { skill: "book", path: "references/ch01.md", content: "old text" }, ctx());
    await t.tools.execute(
      "skills.patch",
      { skill: "book", path: "references/ch01.md", oldString: "old text", newString: "new text" },
      ctx(),
    );
    expect(readFileSync(join(t.skills.dirFor("book"), "references", "ch01.md"), "utf8")).toBe("new text");
  });

  test("empty newString deletes the match; replaceAll replaces every occurrence", async () => {
    await t.tools.execute("skills.patch", { skill: "book", oldString: "Clocks lie.", newString: "" }, ctx());
    expect(t.skills.get("book")?.body).not.toContain("Clocks lie.");

    await t.tools.execute("skills.writeFile", { skill: "book", path: "references/dup.md", content: "x\nx\nx" }, ctx());
    await t.tools.execute(
      "skills.patch",
      { skill: "book", path: "references/dup.md", oldString: "x", newString: "y", replaceAll: true },
      ctx(),
    );
    expect(readFileSync(join(t.skills.dirFor("book"), "references", "dup.md"), "utf8")).toBe("y\ny\ny");
  });

  test("rejections: unknown skill, missing oldString, no match, ambiguous, identical, structure break", async () => {
    const ctxv = ctx();
    await expect(t.tools.execute("skills.patch", { skill: "ghost", oldString: "a", newString: "b" }, ctxv)).rejects.toThrow(
      "Unknown skill",
    );
    await expect(t.tools.execute("skills.patch", { skill: "book", newString: "b" }, ctxv)).rejects.toThrow("oldString is required");
    await expect(t.tools.execute("skills.patch", { skill: "book", oldString: "nope", newString: "b" }, ctxv)).rejects.toThrow(
      "Could not find oldString",
    );
    await expect(
      t.tools.execute("skills.patch", { skill: "book", oldString: "e", newString: "f" }, ctxv),
    ).rejects.toThrow(/matches for oldString/);
    await expect(t.tools.execute("skills.patch", { skill: "book", oldString: "same", newString: "same" }, ctxv)).rejects.toThrow(
      "identical",
    );
    // A patch that destroys the frontmatter is rejected BEFORE writing.
    await expect(
      t.tools.execute("skills.patch", { skill: "book", oldString: "---\ndescription: A distilled book.\n---", newString: "gone" }, ctxv),
    ).rejects.toThrow("break SKILL.md structure");
    expect(readFileSync(t.skills.fileFor("book"), "utf8")).toContain("description: A distilled book.");
  });
});

describe("skills.delete tool", () => {
  let t: TestCore;

  beforeEach(() => {
    t = makeCore();
    t.skills.put("doomed", { description: "Doomed skill.", body: "# Doomed" });
  });

  afterEach(() => {
    t.store.close();
  });

  const ctx = () => ({
    sessionId: t.core.createSession({ workbench: "chat" }).id,
    signal: new AbortController().signal,
    emitLive: () => {},
  });

  test("whole-skill delete removes the directory; the deletion is final", async () => {
    const result = await t.tools.execute("skills.delete", { skill: "doomed" }, ctx());
    expect(result.content).toContain("deleted");
    expect(existsSync(t.skills.dirFor("doomed"))).toBe(false);
    expect(t.skills.get("doomed")).toBeUndefined();
    await expect(t.tools.execute("skills.delete", { skill: "doomed" }, ctx())).rejects.toThrow("Unknown skill");
  });

  test("single-file delete removes the file and prunes the empty dir", async () => {
    await t.tools.execute("skills.writeFile", { skill: "doomed", path: "references/temp.md", content: "x" }, ctx());
    await t.tools.execute("skills.delete", { skill: "doomed", path: "references/temp.md" }, ctx());
    expect(existsSync(join(t.skills.dirFor("doomed"), "references", "temp.md"))).toBe(false);
    expect(existsSync(join(t.skills.dirFor("doomed"), "references"))).toBe(false); // pruned
    expect(t.skills.get("doomed")?.linkedFiles).toEqual([]);
  });

  test("rejections: unknown skill, unknown file, traversal", async () => {
    const ctxv = ctx();
    await expect(t.tools.execute("skills.delete", { skill: "ghost" }, ctxv)).rejects.toThrow("Unknown skill");
    await expect(t.tools.execute("skills.delete", { skill: "doomed", path: "references/nope.md" }, ctxv)).rejects.toThrow(
      "not found",
    );
    await expect(t.tools.execute("skills.delete", { skill: "doomed", path: "../escape.md" }, ctxv)).rejects.toThrow(
      "path must be relative",
    );
  });
});
