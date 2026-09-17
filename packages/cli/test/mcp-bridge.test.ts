import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCliArgs } from "../src/args";
import { runMcpBridge } from "../src/modes/mcp";

/** Capture stderr while running `fn` (stdout is the JSON-RPC channel). */
async function captureStderr(fn: () => Promise<number>): Promise<{ code: number; stderr: string }> {
  const original = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
  };
  try {
    const code = await fn();
    return { code, stderr: lines.join("\n") };
  } finally {
    console.error = original;
  }
}

describe("`bai mcp` stdio bridge resolution", () => {
  test("without a discoverable server it explains how to start one (exit 1)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bai-mcp-bridge-"));
    const prevState = process.env.XDG_STATE_HOME;
    const prevUrl = process.env.BAI_URL;
    process.env.XDG_STATE_HOME = dir;
    delete process.env.BAI_URL;
    try {
      const { code, stderr } = await captureStderr(() => runMcpBridge(parseCliArgs(["mcp"])));
      expect(code).toBe(1);
      expect(stderr).toContain("no running bai server");
    } finally {
      if (prevState === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = prevState;
      if (prevUrl === undefined) delete process.env.BAI_URL;
      else process.env.BAI_URL = prevUrl;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an unreachable --url reports a connection failure (exit 1)", async () => {
    const { code, stderr } = await captureStderr(() =>
      runMcpBridge(parseCliArgs(["mcp", "--url", "http://127.0.0.1:1/mcp"])),
    );
    expect(code).toBe(1);
    expect(stderr).toContain("could not connect");
  });
});
