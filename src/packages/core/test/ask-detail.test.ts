import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askDetailFor } from "../src/tools/ask-detail";

/**
 * Phase-1 permission core: ask-detail enrichers (diff previews) — pure unit
 * tests. End-to-end feedback/denial flows live in run-tools.test.ts.
 */
describe("ask-detail enrichers", () => {
  const dir = join(tmpdir(), "bai-askdetail-");

  const setup = () => {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    return dir;
  };

  test("no enricher for unknown/read-only tools", () => {
    expect(askDetailFor("fs.read", { path: "x" }, dir)).toBeUndefined();
    expect(askDetailFor("bash", { command: "ls" }, dir)).toBeUndefined();
    expect(askDetailFor("fs.write", "not-an-object", dir)).toBeUndefined();
  });

  test("fs.write creating a new file: summary, no diff", () => {
    setup();
    const detail = askDetailFor("fs.write", { path: "new.txt", content: "hello" }, dir);
    expect(detail?.summary).toContain("create");
    expect(detail?.summary).toContain("new.txt");
    expect(detail?.diff).toBeUndefined();
    expect(detail?.path).toBe(join(dir, "new.txt"));
  });

  test("fs.write overwriting: unified diff shows removed and added lines", () => {
    setup();
    writeFileSync(join(dir, "file.txt"), "line one\nline two\n");
    const detail = askDetailFor("fs.write", { path: "file.txt", content: "line one\nCHANGED\n" }, dir);
    expect(detail?.summary).toContain("overwrite");
    expect(detail?.diff).toContain("-line two");
    expect(detail?.diff).toContain("+CHANGED");
    expect(detail?.diff).toContain("---");
    expect(detail?.diff).toContain("+++");
  });

  test("fs.write on a relative path resolves against cwd; absolute without cwd still works", () => {
    setup();
    writeFileSync(join(dir, "f.txt"), "a\n");
    const rel = askDetailFor("fs.write", { path: "f.txt", content: "b\n" }, dir);
    expect(rel?.diff).toBeDefined();
    const abs = askDetailFor("fs.write", { path: join(dir, "f.txt"), content: "b\n" });
    expect(abs?.diff).toBeDefined();
  });

  test("fs.edit: in-memory replacement produces the correct diff", () => {
    setup();
    writeFileSync(join(dir, "code.ts"), "const a = 1;\nconst b = 2;\n");
    const detail = askDetailFor(
      "fs.edit",
      { path: "code.ts", oldString: "const b = 2;", newString: "const b = 42;" },
      dir,
    );
    expect(detail?.summary).toContain("edit");
    expect(detail?.diff).toContain("-const b = 2;");
    expect(detail?.diff).toContain("+const b = 42;");
  });

  test("fs.edit: ambiguous oldString yields summary-only detail (tool errors post-approval)", () => {
    setup();
    writeFileSync(join(dir, "dup.txt"), "x\nx\n");
    const detail = askDetailFor("fs.edit", { path: "dup.txt", oldString: "x", newString: "y" }, dir);
    expect(detail?.summary).toContain("edit");
    expect(detail?.diff).toBeUndefined();
  });

  test("fs.edit normalizes CRLF files", () => {
    setup();
    writeFileSync(join(dir, "crlf.txt"), "one\r\ntwo\r\n");
    const detail = askDetailFor("fs.edit", { path: "crlf.txt", oldString: "two", newString: "TWO" }, dir);
    expect(detail?.diff).toContain("+TWO");
  });

  test("oversized diffs are head+tail elided", () => {
    setup();
    const big = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
    writeFileSync(join(dir, "big.txt"), `${big}\n`);
    const detail = askDetailFor("fs.write", { path: "big.txt", content: "replaced entirely" }, dir);
    expect(detail?.diff).toBeDefined();
    expect((detail?.diff ?? "").length).toBeLessThan(10_000);
    expect(detail?.diff).toContain("elided");
  });

  test("binary targets keep a summary but no diff", () => {
    setup();
    writeFileSync(join(dir, "blob.bin"), Buffer.from([0, 1, 2, 0]));
    const detail = askDetailFor("fs.write", { path: "blob.bin", content: "text now" }, dir);
    expect(detail?.summary).toContain("overwrite");
    expect(detail?.diff).toBeUndefined();
  });

  test("enricher failures never throw", () => {
    expect(() => askDetailFor("fs.write", { path: undefined, content: null }, dir)).not.toThrow();
    expect(askDetailFor("fs.write", { path: undefined, content: null }, dir)).toBeDefined();
  });
});
