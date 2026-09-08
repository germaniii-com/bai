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
