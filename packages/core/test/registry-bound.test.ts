import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OUTPUT_LIMIT, ToolRegistry, type ToolContext } from "../src";
import { CodeWorkbench } from "../src/workbench/code";

/**
 * The registry's `bound()` is the last resort for tools that ignore the output
 * budget. It used to cut head+tail at raw character offsets, which split lines
 * in half and made the tail (which carries the real end of the output) look
 * like a clean EOF — the model then believed it had read everything while the
 * middle was gone. It must now cut on line boundaries and say plainly that the
 * gap is the middle, with a spill path that can actually be paged.
 */
describe("registry last-resort truncation", () => {
  const payload = (n: number) => `line ${n} ${"x".repeat(40)}`;
  const WHOLE_LINE = /^\d+: line \d+ x{40}$/;
  let dir: string;
  let registry: ToolRegistry;
  let ctx: ToolContext;
  let big: string;
  let expected: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bai-bound-"));
    expected = Array.from({ length: 2000 }, (_, i) => `${i + 1}: ${payload(i + 1)}`);
    big = expected.join("\n");
    registry = new ToolRegistry({ spillDir: join(dir, "tmp") });
    registry.registerAll(new CodeWorkbench({ roots: () => [] }).tools());
    registry.register({
      name: "test.big",
      description: "returns more than the output limit",
      schema: {},
      async execute() {
        return { content: big };
      },
    });
    ctx = { sessionId: "ses_test" as ToolContext["sessionId"], cwd: dir, signal: new AbortController().signal, emitLive: () => {} };
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const numbered = (text: string) => text.split("\n").filter((line) => /^\d+: /.test(line));

  test("cuts on line boundaries and labels the elided middle", async () => {
    const res = await registry.execute("test.big", {}, ctx);
    expect(res.content.length).toBeLessThan(OUTPUT_LIMIT);
    expect(res.content).toContain("this is the MIDDLE of the");

    const markerAt = res.content.indexOf("\n\n[… ");
    expect(markerAt).toBeGreaterThan(0);
    const head = res.content.slice(0, markerAt);
    const rest = res.content.slice(markerAt);
    const tail = rest.slice(rest.indexOf("…]\n\n") + 4);

    // No half-lines anywhere: every numbered fragment is a whole source line.
    for (const line of [...numbered(head), ...numbered(tail)]) expect(line).toMatch(WHOLE_LINE);
    expect(numbered(head)[0]).toBe(expected[0] as string);
    expect(numbered(head).at(-1)).toBe(`${numbered(head).length}: ${payload(numbered(head).length)}`);
    const headLast = numbered(head).length;
    const tailFirst = Number.parseInt((numbered(tail)[0] as string).split(":")[0] as string, 10);
    expect(headLast).toBeLessThan(tailFirst); // the middle really is missing
    expect(numbered(tail).at(-1)).toBe(expected.at(-1) as string); // and the real end survived
  });

  test("spills the full output and records where it went", async () => {
    const res = await registry.execute("test.big", {}, ctx);
    const spill = res.meta?.spilledTo as string;
    expect(typeof spill).toBe("string");
    expect(existsSync(spill)).toBe(true);
    expect(res.content).toContain(spill);
    expect(res.meta?.truncated).toBe(true);
    // Nothing was lost: the spill is the original, byte for byte.
    expect(readFileSync(spill, "utf8")).toBe(big);
  });

  test("the spill can be paged back in full with fs.read", async () => {
    const res = await registry.execute("test.big", {}, ctx);
    const spill = res.meta?.spilledTo as string;
    const seen = new Map<string, string>();
    let offset = 1;
    let ended = false;
    for (let page = 0; page < 20 && !ended; page++) {
      const read = await registry.execute("fs.read", { path: spill, offset }, ctx);
      expect(read.content).not.toContain("elided");
      for (const line of numbered(read.content)) {
        const m = /^(\d+): (.*)$/.exec(line) as RegExpExecArray;
        seen.set(m[1] as string, m[2] as string);
      }
      const last = Number(read.meta?.offset ?? 1) + Number(read.meta?.lines ?? 0) - 1;
      if (read.content.includes("(End of file")) ended = true;
      else offset = last + 1;
    }
    expect(ended).toBe(true);
    expect(seen.size).toBe(expected.length);
    for (let i = 0; i < expected.length; i++) expect(seen.get(String(i + 1))).toBe(expected[i] as string);
  });
});
