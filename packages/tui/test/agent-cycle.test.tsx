import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import React from "react";
import { Box } from "ink";
import type { BaiClient } from "@bai/api/client";
import { ChatView } from "../src/views/chat";

/**
 * Tab / Shift+Tab agent cycling through the chat view's real input path
 * (ink-testing-library feeds stdin through ink's parser). The pure decode/
 * wraparound math lives in agents.test.ts; this pins the wiring: forward on
 * Tab, reverse on the backtab escape.
 */

const tick = (ms = 30): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function Harness({ onCycleAgent }: { onCycleAgent: (delta: 1 | -1) => void }) {
  return (
    <Box flexDirection="column" width={60} height={24}>
      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        <ChatView
          client={{} as BaiClient}
          session={null}
          messages={[]}
          runActive={false}
          mode="normal"
          modelLabel="stub/echo"
          agent="build"
          footerRows={1}
          onEnterInput={() => {}}
          onExitInput={() => {}}
          onSessionCreated={() => {}}
          onOpenSubagent={() => {}}
          onOpenModels={() => {}}
          onOpenAgents={() => {}}
          onOpenSessions={() => {}}
          onCycleAgent={onCycleAgent}
        />
      </Box>
    </Box>
  );
}

describe("Tab / Shift+Tab agent cycling", () => {
  test("tab steps forward, shift+tab steps back", async () => {
    const deltas: number[] = [];
    const { stdin, unmount } = render(<Harness onCycleAgent={(d) => deltas.push(d)} />);
    await tick();
    stdin.write("\t");
    await tick();
    stdin.write("\x1b[Z");
    await tick();
    unmount();
    expect(deltas).toEqual([1, -1]);
  });
});
