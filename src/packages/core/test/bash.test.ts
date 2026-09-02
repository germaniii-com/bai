import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bashTool } from "../src/tools/bash";
import type { ToolContext } from "../src/tools/registry";

const ctx = (cwd?: string): ToolContext =>
  ({ sessionId: "ses_test" as never, signal: new AbortController().signal, emitLive: () => {}, ...(cwd !== undefined ? { cwd } : {}) }) as ToolContext;

describe("bash tool", () => {
  test("stdout, stderr, and exit codes", async () => {
    const t = bashTool();
    const ok = await t.execute({ command: "echo hello-bai" }, ctx());
    expect(ok.content).toContain("hello-bai");
    expect((ok.meta as { exitCode: number }).exitCode).toBe(0);

    const fail = await t.execute({ command: "echo oops >&2; exit 3" }, ctx());
    expect(fail.content).toContain("exit code 3");
    expect(fail.content).toContain("oops");
    expect((fail.meta as { isError: boolean }).isError).toBe(true);
  });

  test("cwd roots the command", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bai-bash-"));
    try {
      writeFileSync(join(dir, "marker.txt"), "here");
      const t = bashTool();
      const result = await t.execute({ command: "cat marker.txt" }, ctx(dir));
      expect(result.content).toContain("here");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("timeout kills the command quickly", async () => {
    const t = bashTool();
    const started = Date.now();
    await expect(t.execute({ command: "sleep 30", timeout: 1 }, ctx())).rejects.toThrow(/timed out/);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  test("validation: empty command rejected", async () => {
    const t = bashTool();
    await expect(t.execute({ command: "  " }, ctx())).rejects.toThrow(/command is required/);
  });
});
