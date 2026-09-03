import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import React from "react";
import type { BaiClient } from "@bai/api/client";
import type { AgentInfo } from "@bai/shared";
import { AgentManager } from "../src/views/agent-manager";

/**
 * The ctrl+a agents & tools dialog scrolls long lists in a sliding window
 * (same listbox pattern as the sessions/provider dialogs) instead of
 * overflowing the terminal.
 */

const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

function agent(i: number): AgentInfo {
  return {
    name: `agent-${String(i).padStart(2, "0")}`,
    description: `agent ${i}`,
    prompt: `You are agent ${i}.`,
    tools: [],
    source: "file",
    path: `/tmp/agent-${i}.md`,
  };
}

const agents = Array.from({ length: 30 }, (_, i) => agent(i));

function stubClient(applied: string[]): BaiClient {
  return {
    listAgents: async () => agents,
    listTools: async () => [],
    putConfig: async (config: { agents?: { default?: string } }) => {
      if (config.agents?.default !== undefined) applied.push(config.agents.default);
    },
  } as unknown as BaiClient;
}

describe("AgentManager dialog list scrolling (ctrl+a)", () => {
  test("long agent lists render a window with more-indicators", async () => {
    const { lastFrame, unmount } = render(
      <AgentManager client={stubClient([])} active={null} catalogTick={0} onDone={() => {}} />,
    );
    await tick();
    const frame = lastFrame() ?? "";
    unmount();

    expect(frame).toContain("agent-00");
    expect(frame).toContain("agent-11");
    expect(frame).not.toContain("agent-12");
    expect(frame).toContain("↓ 18 more");
  });

  test("navigating to the end slides the window; u applies the highlighted agent", async () => {
    const applied: string[] = [];
    const { stdin, lastFrame, unmount } = render(
      <AgentManager client={stubClient(applied)} active={null} catalogTick={0} onDone={() => {}} />,
    );
    await tick();
    for (let i = 0; i < 29; i++) {
      stdin.write("j");
      await tick();
    }
    const frame = lastFrame() ?? "";
    expect(frame).toContain("agent-29");
    expect(frame).toContain("↑ 18 more");
    expect(frame).not.toContain("agent-11 ");

    stdin.write("u"); // apply as default (no active session)
    await tick();
    unmount();
    expect(applied).toEqual(["agent-29"]);
  });
});
