import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry, type ToolContext } from "../src";
import { CodeWorkbench } from "../src/workbench/code";
import { BUILTIN_BUILD_AGENT } from "@bai/shared";

describe("fs tools", () => {
  let dir: string;
  let registry: ToolRegistry;
  let ctx: ToolContext;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bai-fstools-"));
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\nexport const b = 2;\n");
    writeFileSync(join(dir, "readme.md"), "# hello\nworld\n");
    const workbench = new CodeWorkbench({ roots: () => [] });
    registry = new ToolRegistry({ spillDir: join(dir, "tmp") });
    registry.registerAll(workbench.tools());
    ctx = { sessionId: "ses_test" as ToolContext["sessionId"], cwd: dir, signal: new AbortController().signal, emitLive: () => {} };
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const run = (name: string, args: unknown) => registry.execute(name, args, ctx);
  const toolNames = () => registry.names();

  test("code workbench registers the five fs tools; build agent lists them", () => {
    expect(toolNames()).toEqual(["fs.edit", "fs.glob", "fs.list", "fs.read", "fs.write"]);
    for (const name of toolNames()) expect(BUILTIN_BUILD_AGENT.tools).toContain(name);
  });

  test("fs.read returns numbered lines with an end marker", async () => {
    const res = await run("fs.read", { path: "src/a.ts" });
    expect(res.content).toContain("1: export const a = 1;");
    expect(res.content).toContain("(End of file — total 3 lines)");
  });

  test("fs.read pages with a continuation hint", async () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
    writeFileSync(join(dir, "big.txt"), lines);
    const res = await run("fs.read", { path: "big.txt", offset: 1, limit: 10 });
    expect(res.content).toContain("(Showing lines 1-10 of 50. Use offset=11 to continue.)");
    const page2 = await run("fs.read", { path: "big.txt", offset: 11, limit: 10 });
    expect(page2.content).toContain("11: line 11");
  });

  test("fs.read miss suggests alternatives; outside-root is refused; binary refused", async () => {
    const miss = await run("fs.read", { path: "src/a.tsx" }).catch((e: Error) => e);
    expect((miss as Error).message).toContain("Did you mean");
    expect((miss as Error).message).toContain("a.ts");

    const outside = await run("fs.read", { path: "/etc/passwd" }).catch((e: Error) => e);
    expect((outside as Error).message).toContain("outside this session's workspace");

    writeFileSync(join(dir, "bin.dat"), Buffer.from([1, 0, 2, 0, 3, 0]));
    const bin = await run("fs.read", { path: "bin.dat" }).catch((e: Error) => e);
    expect((bin as Error).message).toContain("binary");
  });

  test("fs.list renders a tree and skips ignored dirs", async () => {
    mkdirSync(join(dir, "node_modules", "x"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "x", "y.js"), "");
    const res = await run("fs.list", {});
    expect(res.content).toContain("src/");
    expect(res.content).toContain("readme.md");
    expect(res.content).not.toContain("node_modules");
  });

  test("fs.glob finds matches with a cap", async () => {
    const res = await run("fs.glob", { pattern: "**/*.ts" });
    expect(res.content).toContain(join(dir, "src", "a.ts"));
    const none = await run("fs.glob", { pattern: "**/*.zzz" });
    expect(none.content).toContain("No files found");
  });

  test("fs.write creates and refuses identical content", async () => {
    const res = await run("fs.write", { path: "src/new.ts", content: "export const c = 3;\n" });
    expect(res.content).toContain("Wrote");
    expect(statSync(join(dir, "src", "new.ts")).isFile()).toBe(true);

    const same = await run("fs.write", { path: "src/new.ts", content: "export const c = 3;\n" }).catch((e: Error) => e);
    expect((same as Error).message).toContain("byte-identical");
  });

  test("staleness guard: overwrite without read is refused; stale mtime is refused", async () => {
    const noRead = await run("fs.write", { path: "readme.md", content: "x" }).catch((e: Error) => e);
    expect((noRead as Error).message).toContain("has not been read");

    await run("fs.read", { path: "readme.md" });
    // Bump mtime past the read stamp.
    const future = new Date(Date.now() + 10_000);
    utimesSync(join(dir, "readme.md"), future, future);
    const stale = await run("fs.write", { path: "readme.md", content: "x" }).catch((e: Error) => e);
    expect((stale as Error).message).toContain("modified since it was last read");
  });

  test("fs.edit exact-match replace, uniqueness errors, replaceAll", async () => {
    await run("fs.read", { path: "src/a.ts" });
    const res = await run("fs.edit", { path: "src/a.ts", oldString: "const a = 1", newString: "const a = 42" });
    expect(res.content).toContain("1 replacement");
    expect(readFileText("src/a.ts")).toContain("const a = 42");

    writeFileSync(join(dir, "dup.txt"), "x\nx\nx\n");
    await run("fs.read", { path: "dup.txt" });
    const ambiguous = run("fs.edit", { path: "dup.txt", oldString: "x", newString: "y" }).catch((e: Error) => e);
    expect(((await ambiguous) as Error).message).toContain("3 matches");

    const all = await run("fs.edit", { path: "dup.txt", oldString: "x", newString: "y", replaceAll: true });
    expect(all.content).toContain("3 replacements");
    expect(readFileText("dup.txt")).toBe("y\ny\ny\n");
  });

  test("fs.edit distinct not-found error; identical strings error", async () => {
    await run("fs.read", { path: "src/a.ts" });
    const notFound = run("fs.edit", { path: "src/a.ts", oldString: "nope", newString: "y" }).catch((e: Error) => e);
    expect(((await notFound) as Error).message).toContain("Could not find oldString");
    const same = run("fs.edit", { path: "src/a.ts", oldString: "a", newString: "a" }).catch((e: Error) => e);
    expect(((await same) as Error).message).toContain("identical");
  });

  test("fs.edit normalizes line endings to the file's dominant ending", async () => {
    writeFileSync(join(dir, "crlf.txt"), "one\r\ntwo\r\n");
    await run("fs.read", { path: "crlf.txt" });
    await run("fs.edit", { path: "crlf.txt", oldString: "one\ntwo", newString: "one\ntwo!" });
    expect(readFileText("crlf.txt")).toBe("one\r\ntwo!\r\n");
  });

  test("parallel writes to the same path serialize (mutation queue)", async () => {
    const writes = Array.from({ length: 5 }, (_, i) => run("fs.write", { path: "q.txt", content: `content ${i}\n` }));
    await Promise.all(writes);
    // Every write landed without interleaving corruption: final content is one of them, intact.
    const final = readFileText("q.txt");
    expect(final.startsWith("content ")).toBe(true);
    expect(final.endsWith("\n")).toBe(true);
  });

  function readFileText(rel: string): string {
    return require("node:fs").readFileSync(join(dir, ...rel.split("/")), "utf8") as string;
  }
});
