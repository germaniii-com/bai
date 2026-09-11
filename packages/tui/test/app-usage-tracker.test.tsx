import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import React from "react";
import type { BaiClient } from "@bai/api";
import { createApp, dialListener } from "@bai/api";
import { makeStack, type TestStack } from "../../api/test/harness";
import { App } from "../src/app";

/**
 * The context tracker + overlay dialogs end-to-end through the REAL App and
 * stack (bare harness — stub/echo): a completed run's usage seeds the hub's
 * tracker (snapshot → meta.lastUsage), and ctrl+p floats the palette over
 * the live transcript.
 */
describe("App context tracker + overlay (real stack)", () => {
  test("a run's usage lands in the hub; ctrl+p floats over the live transcript", async () => {
    const stack: TestStack = makeStack();
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: createApp(stack.deps).fetch });
    const client: BaiClient = dialListener(server.port ?? 0);
    const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));
    try {
      // A session with a completed run — the echo stub reports 10 in / 5 out.
      const session = await client.createSession({ workbench: "chat" });
      await client.submitPrompt(session.id, { text: "hi" });
      await stack.core.drainNow(session.id);

      const { stdin, stdout, unmount } = render(<App client={client} version="test" />);
      const frames = stdout.frames;
      try {
        await tick(200);
        // Open the sessions dialog via the palette and pick the session.
        stdin.write("\x10");
        await tick(120);
        stdin.write("sess\r");
        await tick(120);
        stdin.write("\r");
        await tick(300);
        const withSession = [...frames].reverse().find((f) => f.includes("Echo: hi")) ?? "";
        expect(withSession).toContain("Echo: hi");

        // The tracker leads the commands row; the NORMAL row is long, so
        // enter INPUT mode (short hints) for a comfortable assert. 15 tokens,
        // no catalog window → bare count before the hint list.
        stdin.write("i");
        await tick(120);
        const inputFrame = [...frames].reverse().find((f) => f.includes("enter send")) ?? "";
        expect(inputFrame).toContain("15 ·");

        // ctrl+p floats the palette over the live transcript (NORMAL mode
        // only — esc out of INPUT first); the reply stays visible behind.
        stdin.write("\x1b");
        await tick(120);
        const mark = frames.length;
        stdin.write("\x10");
        await tick(200);
        const overlay = [...frames.slice(mark)].reverse().find((f) => f.includes("commands")) ?? "";
        expect(overlay).toContain("Echo: hi");
        expect(overlay).toContain("Suggested");
      } finally {
        unmount();
      }
    } finally {
      await Promise.race([server.stop(true), new Promise((r) => setTimeout(r, 1000))]);
      stack.cleanup();
    }
  }, 30000);
});
