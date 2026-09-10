import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearFindCache, findFiles, fuzzyScore } from "../src/fs/find";

describe("findFiles", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bai-find-"));
    mkdirSync(join(dir, "src", "components"), { recursive: true });
    writeFileSync(join(dir, "src", "index.ts"), "export {};\n");
    writeFileSync(join(dir, "src", "components", "button.tsx"), "export {};\n");
    writeFileSync(join(dir, "README.md"), "# readme\n");
    mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "pkg", "index.js"), "");
    mkdirSync(join(dir, ".git"), { recursive: true });
    writeFileSync(join(dir, ".env"), "SECRET=1\n");
    clearFindCache();
  });

  afterEach(() => {
    clearFindCache();
    rmSync(dir, { recursive: true, force: true });
  });

  test("walks files and directories, skipping ignored and hidden entries", () => {
    const { results } = findFiles(dir, "", { limit: 100 });
    const paths = results.map((r) => r.path);
    expect(paths).toContain("src");
    expect(paths).toContain("src/index.ts");
    expect(paths).toContain("src/components/button.tsx");
    expect(paths).toContain("README.md");
    expect(paths.some((p) => p.includes("node_modules"))).toBe(false);
    expect(paths.some((p) => p.includes(".git"))).toBe(false);
    expect(paths).not.toContain(".env");
  });

  test("ranks basename matches above deep matches", () => {
    const { results } = findFiles(dir, "button", { limit: 10 });
    expect(results[0]?.path).toBe("src/components/button.tsx");
  });

  test("matches path fragments fuzzily in order", () => {
    const { results } = findFiles(dir, "compbut", { limit: 10 });
    expect(results[0]?.path).toBe("src/components/button.tsx");
  });

  test("honors the limit and reports truncation", () => {
    const all = findFiles(dir, "", { limit: 100 });
    const limited = findFiles(dir, "", { limit: 2 });
    expect(limited.results.length).toBe(2);
    expect(limited.truncated).toBe(true);
    expect(all.results.length).toBeGreaterThan(2);
  });

  test("empty query lists shallower entries first", () => {
    const { results } = findFiles(dir, "", { limit: 100 });
    const firstDepth = results[0]!.path.split("/").length;
    expect(firstDepth).toBe(1);
    expect(results[1]!.path.split("/").length).toBe(1);
  });

  test("throws a mapped error for a missing root", () => {
    expect(() => findFiles(join(dir, "nope"), "")).toThrow();
  });
});

describe("fuzzyScore", () => {
  test("is -Infinity when the query is not a subsequence", () => {
    expect(fuzzyScore("zzz", "src/index.ts")).toBe(Number.NEGATIVE_INFINITY);
  });

  test("prefers basename and boundary matches", () => {
    expect(fuzzyScore("idx", "src/idx.ts")).toBeGreaterThan(fuzzyScore("idx", "src/x/i/d/x.ts"));
    expect(fuzzyScore("index", "src/index.ts")).toBeGreaterThan(fuzzyScore("index", "deep/nested/xindexy.ts"));
  });

  test("empty query scores zero", () => {
    expect(fuzzyScore("", "anything")).toBe(0);
  });
});
