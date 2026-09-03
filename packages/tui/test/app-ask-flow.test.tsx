import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import React from "react";
import type { ModelInfo } from "@bai/shared";
import type { LlmRequest, Provider, ProviderStream, StreamEvent } from "@bai/core";
import { createApp, dialListener, type BaiClient } from "@bai/api";
import { makeStack, type TestStack } from "../../api/test/harness";
import { App } from "../src/app";

/**
 * End-to-end smoke of the inline ask flow through the REAL App: a real
 * server on an ephemeral loopback port, a scripted provider that emits a
 * `bash` tool call (bash defaults to "ask"), the App's firehose + session
 * stream, and the inline prompt answering over HTTP.
 *
 *   submit → run → bash ask → inline prompt (footer counter) → `a` →
 *   permission.replied → prompt clears → tool executes → run finishes.
 */

const tick = (ms = 30): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

class ScriptedToolProvider implements Provider {
  readonly requests: LlmRequest[] = [];

  constructor(private readonly script: Array<StreamEvent[]>) {}

  name(): string {
    return "scripted";
  }

  async models(): Promise<ModelInfo[]> {
    return [{ id: "scripted/main", provider: "scripted", label: "Scripted", supportsTools: true }];
  }

  async stream(req: LlmRequest): Promise<ProviderStream> {
    const first = req.messages[0];
    const isTitleCall =
      first?.role === "system" && (first as { content: string }).content.startsWith("You are a title generator");
    if (isTitleCall) {
      return this.streamOf([{ type: "text_delta", delta: "Title" }, { type: "done", stopReason: "end_turn" }]);
    }
    const entry = this.script[this.requests.length];
    this.requests.push(req);
    return this.streamOf(entry ?? [{ type: "done", stopReason: "end_turn" }]);
  }

  private streamOf(events: StreamEvent[]): ProviderStream {
    async function* generate(): AsyncGenerator<StreamEvent> {
      for (const evt of events) yield evt;
    }
    const iterator = generate();
    return { [Symbol.asyncIterator]: () => iterator, close: async () => {} };
  }
}

/** Poll the frame until the predicate holds (SSE + ink are async). */
async function waitForFrame(lastFrame: () => string | undefined, predicate: (frame: string) => boolean, ms = 10000): Promise<string> {
  const deadline = Date.now() + ms;
  for (;;) {
    const frame = lastFrame() ?? "";
    if (predicate(frame)) return frame;
    if (Date.now() > deadline) throw new Error(`frame condition not met; last frame:\n${frame}`);
    await tick(50);
  }
}

describe("App inline ask flow (end-to-end)", () => {
  let stack: TestStack;
  let server: ReturnType<typeof Bun.serve>;
  let client: BaiClient;

  beforeEach(() => {
    stack = makeStack();
    // Route runs at the scripted provider (the harness default is stub/echo,
    // which never calls tools). The minimal configStore stand-in deep-merges
    // into the live config object the Service reads.
    stack.deps.providers.register(
      new ScriptedToolProvider([
        // Turn 1: call bash (defaults to "ask" — not in DEFAULT_PERMISSIONS).
        [
          { type: "tool_call_delta", id: "c1", name: "bash", argsDelta: JSON.stringify({ command: "echo hello" }) },
          { type: "done", stopReason: "tool_use" },
        ],
        // Turn 2 (after the tool result): wrap up.
        [
          { type: "text_delta", delta: "done running" },
          { type: "done", stopReason: "end_turn" },
        ],
      ]),
    );
    // Route runs at the scripted model: mutate the LIVE config object the
    // Service's config() closure reads (deepMerge is non-mutating, so the
    // configStore.update helper alone wouldn't be observed).
    (stack.deps.configStore.get() as { models: { default: string } }).models.default = "scripted/main";
    server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: createApp(stack.deps).fetch });
    client = dialListener(server.port ?? 0);
  });

  afterEach(async () => {
    await Promise.race([server.stop(true), new Promise((r) => setTimeout(r, 1000))]);
    stack.cleanup();
  });

  test("ask renders inline above the composer slot; a approves; the run completes", async () => {
    const { stdin, lastFrame, unmount } = render(<App client={client} version="test" />);
    try {
      await tick(200); // startup fetches (sessions/config) + firehose hello

      // Submit a prompt through the composer (NORMAL → INPUT → type → enter).
      stdin.write("i");
      await tick();
      stdin.write("run the bash tool");
      await tick();
      stdin.write("\r");
      await tick();

      // The ask surfaces INLINE (prompt in the composer slot) and the
      // footer counts it — while the transcript stays visible.
      const asked = await waitForFrame(
        lastFrame,
        (f) => f.includes("permission requested") && f.includes("bash") && f.includes("△ 1 pending ask"),
      );
      expect(asked).toContain("a allow once");

      // ctrl+s: the sessions list shows the blocked session with a yellow
      // ask badge (the global index — seeded over HTTP, live via firehose).
      stdin.write("\x13"); // legacy ctrl+s
      await waitForFrame(lastFrame, (f) => f.includes("sessions") && f.includes("△ 1"));
      stdin.write("\x1b"); // esc — back to the chat, the prompt is still up
      await waitForFrame(lastFrame, (f) => f.includes("permission requested"));

      // Approve once: the reply rides HTTP, permission.replied clears the
      // prompt, the tool executes, and the run finishes with the wrap-up.
      stdin.write("a");
      await waitForFrame(
        lastFrame,
        (f) => f.includes("done running") && !f.includes("permission requested") && !f.includes("pending ask"),
      );

      // The composer is back (the prompt yielded its slot).
      expect(lastFrame() ?? "").toContain(": ");
    } finally {
      unmount();
    }
  }, 30000);
});
