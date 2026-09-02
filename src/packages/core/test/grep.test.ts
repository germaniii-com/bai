import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fsGrepTool, compileGlob } from "../src/tools/fs-grep";
import type { ToolContext } from "../src/tools/registry";

const ctx = (cwd?: string): ToolContext =>
  ({ sessionId: "ses_test" as never, signal: new AbortController().signal, emitLive: () => {}, ...(cwd !== undefined ? { cwd } : {}) }) as ToolContext;

const dir = join(tmpdir(), "bai-grep-fixture");

const setup = () => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "node_modules/pkg"), { recursive: true });
  writeFileSync(join(dir, "src/a.ts"), "export const apple = 1;\nexport const apricot = 2;\n");
  writeFileSync(join(dir, "src/b.js"), "const apple_tree = 3;\n");
  writeFileSync(join(dir, "readme.md"), "an apple a day\n");
  writeFileSync(join(dir, "node_modules/pkg/x.js"), "const apple_picked = 9;\n");
};

describe("fs.grep tool", () => {
  test("finds matches with file:line output", async () => {
    setup();
    const t = fsGrepTool();
    const result = await t.execute({ pattern: "apple", path: dir }, ctx());
    expect(result.content).toContain("a.ts:1: export const apple = 1;");
    expect(result.content).not.toContain("apple_picked"); // node_modules ignored
    expect((result.meta as { count: number }).count).toBeGreaterThan(2);
  });

  test("include glob filters files", async () => {
    setup();
    const t = fsGrepTool();
    const result = await t.execute({ pattern: "apple", path: dir, include: "*.js" }, ctx());
    expect(result.content).toContain("b.js");
    expect(result.content).not.toContain("a.ts");
  });

  test("no matches produces a clear empty result", async () => {
    setup();
    const t = fsGrepTool();
    const result = await t.execute({ pattern: "zebra-xyz", path: dir }, ctx());
    expect(result.content).toContain("No matches");
  });

  test("regex syntax errors are model-facing", async () => {
    const t = fsGrepTool();
    await expect(t.execute({ pattern: "([unclosed", path: dir }, ctx())).rejects.toThrow(/Invalid regular expression/);
  });

  test("missing path without cwd errors clearly", async () => {
    const t = fsGrepTool();
    await expect(t.execute({ pattern: "x" }, ctx())).rejects.toThrow(/No path given/);
  });

  test("relative path resolves against cwd", async () => {
    setup();
    const t = fsGrepTool();
    const result = await t.execute({ pattern: "apple", path: "src" }, ctx(dir));
    expect(result.content).toContain("a.ts");
  });
});

describe("compileGlob", () => {
  test("* matches within a segment only", () => {
    const star = compileGlob("*.ts");
    expect(star?.("a.ts")).toBe(true);
    expect(star?.("src/a.ts")).toBe(false);
  });
  test("** matches across segments", () => {
    const dbl = compileGlob("**/*.ts");
    expect(dbl?.("src/a.ts")).toBe(true);
    expect(dbl?.("a/b/c.ts")).toBe(true);
  });
  test("? matches one character", () => {
    const q = compileGlob("a?c");
    expect(q?.("abc")).toBe(true);
    expect(q?.("abbc")).toBe(false);
  });
  test("undefined/empty → no filter", () => {
    expect(compileGlob(undefined)).toBeUndefined();
    expect(compileGlob("  ")).toBeUndefined();
  });
});
