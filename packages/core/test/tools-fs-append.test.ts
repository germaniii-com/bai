import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry, type ToolContext } from "../src";
import { CodeWorkbench } from "../src/workbench/code";
import { askDetailFor } from "../src/tools/ask-detail";

/**
 * `fs.write { append: true }` exists so a large file never has to be one
 * oversized tool call: the model's output is capped
 * (see `provider/output-limit.ts`), so a single big write gets cut off
 * mid-JSON and the run fails. Chunking keeps each call inside the ceiling.
 *
 * Append keeps the read-before-write guard: appending to a file that was never
 * read, or that changed on disk since, is as destructive as overwriting it.
 */
describe("fs.write append mode", () => {
  let dir: string;
  let registry: ToolRegistry;
  let ctx: ToolContext;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bai-append-"));
    registry = new ToolRegistry({ spillDir: join(dir, "tmp") });
    registry.registerAll(new CodeWorkbench({ roots: () => [] }).tools());
    ctx = { sessionId: "ses_test" as ToolContext["sessionId"], cwd: dir, signal: new AbortController().signal, emitLive: () => {} };
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const run = (args: unknown) => registry.execute("fs.write", args, ctx);
  const read = (name: string) => readFileSync(join(dir, name), "utf8");

  test("append grows the file and reports the new total", async () => {
    await run({ path: "notes.txt", content: "one\n" });
    await registry.execute("fs.read", { path: "notes.txt" }, ctx);
    const res = await run({ path: "notes.txt", content: "two\n", append: true });

    expect(read("notes.txt")).toBe("one\ntwo\n");
    expect(res.meta?.appended).toBe(true);
    expect(res.meta?.bytes).toBe(4);
    expect(res.meta?.totalBytes).toBe(8);
  });

  test("refuses to append to a file that was never read", async () => {
    writeFileSync(join(dir, "stale.txt"), "existing\n");
    await expect(run({ path: "stale.txt", content: "more\n", append: true })).rejects.toThrow(/has not been read/);
    expect(read("stale.txt")).toBe("existing\n"); // untouched
  });

  test("refuses to append to a missing file", async () => {
    await expect(run({ path: "nope.txt", content: "x", append: true })).rejects.toThrow(/Cannot append/);
  });

  test("append mode allows repeating identical content", async () => {
    await run({ path: "rep.txt", content: "block\n" });
    await registry.execute("fs.read", { path: "rep.txt" }, ctx);
    await run({ path: "rep.txt", content: "block\n", append: true });
    await run({ path: "rep.txt", content: "block\n", append: true });
    expect(read("rep.txt")).toBe("block\nblock\nblock\n");
  });

  test("replace mode still refuses byte-identical content", async () => {
    await run({ path: "same.txt", content: "unchanged\n" });
    await registry.execute("fs.read", { path: "same.txt" }, ctx);
    await expect(run({ path: "same.txt", content: "unchanged\n" })).rejects.toThrow(/byte-identical/);
  });

  test("chunked writes rebuild a large file exactly", async () => {
    const chunk = (from: number, to: number) =>
      Array.from({ length: to - from + 1 }, (_, i) => `line ${from + i} ${"x".repeat(40)}`).join("\n") + "\n";

    // 1000 lines in 5 appends — each call stays far below the output ceiling.
    await run({ path: "big.txt", content: chunk(1, 200) });
    for (const [from, to] of [
      [201, 400],
      [401, 600],
      [601, 800],
      [801, 1000],
    ] as const) {
      await run({ path: "big.txt", content: chunk(from, to), append: true });
    }

    const actual = read("big.txt");
    expect(actual).toBe(chunk(1, 1000));
    expect(actual.split("\n")).toHaveLength(1001); // 1000 lines + trailing ""

    // And the result is readable back end-to-end by paging.
    const first = await registry.execute("fs.read", { path: "big.txt" }, ctx);
    expect(first.content).not.toContain("elided");
    expect(first.meta?.total).toBe(1001);
  });

  test("each chunk is appended in call order", async () => {
    await run({ path: "ordered.txt", content: "a" });
    for (const piece of ["b", "c", "d"]) {
      await run({ path: "ordered.txt", content: piece, append: true });
    }
    expect(read("ordered.txt")).toBe("abcd");
  });
});

/**
 * The permission dialog must describe an append honestly — showing it as an
 * "overwrite" with a whole-file diff would badly misrepresent the call the user
 * is approving.
 */
describe("fs.write append ask-detail", () => {
  test("append previews only the appended lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "bai-append-ask-"));
    try {
      writeFileSync(join(dir, "a.txt"), "keep\n");
      const detail = askDetailFor("fs.write", { path: "a.txt", content: "add\n", append: true }, dir);
      expect(detail?.summary).toBe("append a.txt (4 bytes)");
      expect(detail?.diff).toContain("+add");
      expect(detail?.diff).not.toContain("-keep");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("append to a missing file asks with a summary and no diff", () => {
    const dir = mkdtempSync(join(tmpdir(), "bai-append-ask2-"));
    try {
      const detail = askDetailFor("fs.write", { path: "gone.txt", content: "x", append: true }, dir);
      expect(detail?.summary).toBe("append gone.txt (1 bytes)");
      expect(detail?.diff).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("replace-mode summaries are unchanged", () => {
    const dir = mkdtempSync(join(tmpdir(), "bai-append-ask3-"));
    try {
      writeFileSync(join(dir, "b.txt"), "old\n");
      expect(askDetailFor("fs.write", { path: "b.txt", content: "new\n" }, dir)?.summary).toBe("overwrite b.txt (4 bytes)");
      expect(askDetailFor("fs.write", { path: "fresh.txt", content: "hi" }, dir)?.summary).toBe("create fresh.txt (2 bytes)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
