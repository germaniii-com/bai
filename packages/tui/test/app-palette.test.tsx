import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import React from "react";
import type { BaiClient } from "@bai/api";
import { createApp, dialListener } from "@bai/api";
import { makeStack, type TestStack } from "../../api/test/harness";
import { App } from "../src/app";

/**
 * The supermenu end-to-end through the REAL App (bare harness — stub/echo,
 * no prompt): ctrl+p opens the command palette in NORMAL mode, the
 * Suggested section floats "Connect provider" (no provider connected),
 * a batched "sess\r" dispatches Switch session into the sessions dialog,
 * and the removed ctrl+** family is inert everywhere.
 */

const tick = (ms = 30): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll the ACCUMULATED frame stream for a matching frame (see app-ask-flow). */
async function waitForAnyFrame(getFrames: () => string[], predicate: (frame: string) => boolean, ms = 10000): Promise<string> {
  const deadline = Date.now() + ms;
  for (;;) {
    const hit = [...getFrames()].reverse().find(predicate);
    if (hit !== undefined) return hit;
    if (Date.now() > deadline) {
      throw new Error(`no frame matched; last: ${JSON.stringify([...getFrames()].reverse()[0] ?? "")}`);
    }
    await tick(50);
  }
}

describe("App supermenu (ctrl+p)", () => {
  let stack: TestStack;
  let server: ReturnType<typeof Bun.serve>;
  let client: BaiClient;

  beforeEach(() => {
    stack = makeStack();
    server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: createApp(stack.deps).fetch });
    client = dialListener(server.port ?? 0);
  });

  afterEach(async () => {
    await Promise.race([server.stop(true), new Promise((r) => setTimeout(r, 1000))]);
    stack.cleanup();
  });

  test("ctrl+p opens the palette; dispatch works; the old ctrl family is dead", async () => {
    const { stdin, lastFrame, stdout, unmount } = render(<App client={client} version="test" />);
    const frames = stdout.frames;
    try {
      await tick(200); // startup fetches (sessions/config) + firehose hello

      // ctrl+p: the palette renders with the registry's sections. The
      // on-demand provider fetch lands (stub/echo only → nothing connected)
      // and floats "Connect provider" under Suggested.
      const markP = frames.length;
      stdin.write("\x10"); // ctrl+p
      const palette = await waitForAnyFrame(
        () => frames.slice(markP),
        (f) => f.includes("commands") && f.includes("Suggested") && f.includes("Connect provider"),
      );
      expect(palette).toContain("Session"); // category header
      expect(palette).toContain("❯ Connect provider"); // cursor on the suggested entry

      // Batched "sess\r": filters to the two session commands and runs the
      // first (Switch session) — the sessions dialog REPLACES the palette.
      const markS = frames.length;
      stdin.write("sess\r");
      const sessions = await waitForAnyFrame(
        () => frames.slice(markS),
        (f) => f.includes("type to filter") && f.includes("enter select"),
      );
      expect(sessions).toContain("sessions");
      expect(sessions).toContain("none yet — ctrl+n to start one"); // bare stack: no sessions

      // esc closes the dialog; the removed ctrl family opens NOTHING.
      stdin.write("\x1b");
      await tick();
      for (const chord of ["\x0c", "\x01", "\x13", "\x14", "\x07", "\x0f"]) {
        stdin.write(chord); // ctrl+l a s t g o — all dead now
        await tick();
      }
      const after = lastFrame() ?? "";
      expect(after).not.toContain("type to filter");
      expect(after).not.toContain("Themes");

      // INPUT mode: ctrl+p is inert — app globals gate off while typing.
      stdin.write("i");
      await tick();
      const markI = frames.length;
      stdin.write("\x10");
      await tick();
      await tick();
      expect(frames.slice(markI).every((f) => !f.includes("type to filter"))).toBe(true);
    } finally {
      unmount();
    }
  }, 30000);

  test("the palette floats over the live chat; the chat goes silent while it's open", async () => {
    const { stdin, lastFrame, stdout, unmount } = render(<App client={client} version="test" />);
    const frames = stdout.frames;
    try {
      await tick(200); // startup fetches + firehose hello

      // ctrl+p: the palette renders as an OVERLAY — the chat underneath
      // stays mounted and visible in the same frame (the hub's draft label
      // at the panel's left + the commands row below it; the wider panel
      // covers the empty-transcript line itself on the 100-col terminal).
      const markP = frames.length;
      stdin.write("\x10"); // ctrl+p
      const palette = await waitForAnyFrame(
        () => frames.slice(markP),
        (f) => f.includes("commands") && f.includes("Suggested"),
      );
      expect(palette).toContain("new session");
      expect(palette).toContain("i input · j/k scroll");

      // Typing goes to the palette's filter; the chat behind must NOT react
      // ("i" in NORMAL mode would enter INPUT — the hub's commands row would
      // swap to the input-mode hints; the status badge itself is occluded by
      // the floating panel, the commands row is not).
      stdin.write("i");
      const filtered = await waitForAnyFrame(
        () => frames.slice(markP),
        (f) => f.includes("filter: i"),
      );
      expect(filtered).toContain("i input · j/k scroll");
      expect(filtered).not.toContain("enter send · esc normal");

      // esc closes the overlay; the chat is live again — "i" now enters
      // INPUT mode (the hub's typing affordance appears).
      const markE = frames.length; // palette is on screen here
      stdin.write("\x1b");
      await waitForAnyFrame(
        () => frames.slice(markE),
        (f) => !f.includes("type to filter"),
      );
      const markI = frames.length;
      stdin.write("i");
      const inputMode = await waitForAnyFrame(
        () => frames.slice(markI),
        (f) => f.includes("enter send"),
      );
      expect(inputMode).toContain("›");
      expect(inputMode).not.toContain("type to filter");
    } finally {
      unmount();
    }
  }, 30000);
});
