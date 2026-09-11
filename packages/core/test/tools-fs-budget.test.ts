import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OUTPUT_LIMIT, ToolRegistry, type ToolContext } from "../src";
import { CodeWorkbench } from "../src/workbench/code";

/**
 * Regression coverage for the truncation bug: fs.read used to return up to
 * 2000 lines / ~4 MB, which the registry then cut head+tail *mid-line*, so the
 * model saw mangled line numbers and a tail that looked like EOF while the
 * middle of the file was gone. Line-oriented tools must now stay inside the
 * tool output budget on their own and page contiguously via `offset`.
 */
describe("fs tool output budgets", () => {
  let dir: string;
  let registry: ToolRegistry;
  let ctx: ToolContext;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bai-fsbudget-"));
    const workbench = new CodeWorkbench({ roots: () => [] });
    registry = new ToolRegistry({ spillDir: join(dir, "tmp") });
    registry.registerAll(workbench.tools());
    ctx = { sessionId: "ses_test" as ToolContext["sessionId"], cwd: dir, signal: new AbortController().signal, emitLive: () => {} };
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const run = (name: string, args: unknown) => registry.execute(name, args, ctx);

  /** One numbered line per entry, sized so 1500 lines blows past OUTPUT_LIMIT. */
  function writeBigFile(name: string, count = 1500): string[] {
    const lines = Array.from({ length: count }, (_, i) => `line ${i + 1} ${"x".repeat(40)}`);
    writeFileSync(join(dir, name), lines.join("\n"));
    return lines;
  }

  test("a 1500-line file is never elided mid-read", async () => {
    writeBigFile("big.txt");
    const res = await run("fs.read", { path: "big.txt" });
    expect(res.content.length).toBeLessThanOrEqual(OUTPUT_LIMIT);
    expect(res.content).not.toContain("elided");
    expect(res.content).toContain("window capped to the");
    expect(res.meta?.stoppedByBudget).toBe(true);
    expect(res.meta?.truncated).toBe(true);
    expect(res.meta?.total).toBe(1500);
  });

  test("offset pages tile the file contiguously to EOF", async () => {
    const lines = writeBigFile("big.txt");
    const seen = new Map<number, string>();
    let offset = 1;
    let ended = false;
    for (let page = 0; page < 50 && !ended; page++) {
      const res = await run("fs.read", { path: "big.txt", offset });
      expect(res.content.length).toBeLessThanOrEqual(OUTPUT_LIMIT);
      expect(res.content).not.toContain("elided");
      for (const line of res.content.split("\n")) {
        const m = /^(\d+): (.*)$/.exec(line);
        if (!m) continue;
        const n = Number.parseInt(m[1] as string, 10);
        expect(seen.has(n)).toBe(false); // no duplicates across pages
        seen.set(n, m[2] as string);
      }
      const last = Number(res.meta?.offset ?? 1) + Number(res.meta?.lines ?? 0) - 1;
      if (res.content.includes("(End of file")) {
        ended = true;
      } else {
        // The hint must name exactly the next unseen line.
        expect(res.content).toContain(`Use offset=${last + 1} to continue.`);
        offset = last + 1;
      }
    }
    expect(ended).toBe(true);
    expect(seen.size).toBe(lines.length);
    for (let i = 0; i < lines.length; i++) expect(seen.get(i + 1)).toBe(lines[i] as string);
  });

  test("an over-long line is capped inline instead of blowing the budget", async () => {
    writeFileSync(join(dir, "long.txt"), `${"y".repeat(100_000)}\n`);
    const res = await run("fs.read", { path: "long.txt" });
    expect(res.content.length).toBeLessThanOrEqual(OUTPUT_LIMIT);
    expect(res.content).not.toContain("elided");
    expect(res.content).toContain("line truncated to 2000 chars");
  });

  test("a directory read notes truncation instead of dropping entries silently", async () => {
    for (let i = 0; i < 600; i++) writeFileSync(join(dir, `f${String(i).padStart(3, "0")}.txt`), "");
    const res = await run("fs.read", { path: "." });
    expect(res.content).toContain("(truncated at 500 entries");
    expect(res.meta?.kind).toBe("directory");
    expect(res.meta?.truncated).toBe(true);
  });

  test("fs.list and fs.glob note truncation with a next step", async () => {
    for (let i = 0; i < 700; i++) writeFileSync(join(dir, `g${String(i).padStart(3, "0")}.txt`), "");
    const list = await run("fs.list", {});
    expect(list.content).toContain("truncated, list a subdirectory for the rest");
    expect(list.meta?.truncated).toBe(true);

    const glob = await run("fs.glob", { pattern: "*.txt" });
    expect(glob.content).toContain("(truncated at 100 matches — refine the pattern or path for more.)");
    expect(glob.meta?.truncated).toBe(true);
  });

  test("listing stays inside the budget for long absolute paths", async () => {
    mkdirSync(join(dir, "nested"), { recursive: true });
    for (let i = 0; i < 600; i++) {
      writeFileSync(join(dir, "nested", `deep-${"d".repeat(60)}-${i}.txt`), "");
    }
    const res = await run("fs.list", { path: "nested" });
    expect(res.content.length).toBeLessThanOrEqual(OUTPUT_LIMIT);
    expect(res.content).not.toContain("elided");
  });
});
