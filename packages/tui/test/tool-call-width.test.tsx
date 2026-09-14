import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import React from "react";
import { Box, Text } from "ink";
import type { BaiClient } from "@bai/api/client";
import type { Message, MessageId, Part, PartId, SessionId } from "@bai/shared";
import { ChatView } from "../src/views/chat";
import { argsDigest } from "../src/state/sync";

/**
 * Tool-call width regressions: the collapsed tool line used to cap args at
 * 60 chars and truncate the transcript row at the terminal edge, so deep
 * workspace paths read ".../pack…" (clipped in the middle). The digest now
 * keeps a generous preview and the transcript header wraps, using the full
 * terminal width.
 */

const tick = (ms = 40): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const LONG_PATH =
  "/Users/u/Work/Projects/bai-ts/packages/core/src/provider/adapters/openai.ts";

function part(ord: number, kind: string, payload: unknown): Part {
  return {
    id: `part_${ord}` as PartId,
    messageId: "msg" as MessageId,
    ord,
    kind: kind as Part["kind"],
    payload,
  };
}

const toolMessage: Message = {
  id: "msg-0" as MessageId,
  sessionId: "ses_1" as SessionId,
  role: "assistant",
  createdAt: "t",
  parts: [
    part(0, "tool_call", { callId: "c1", name: "fs.read", args: JSON.stringify({ path: LONG_PATH }) }),
    part(1, "tool_result", { callId: "c1", content: "ok" }),
  ],
};

function Harness() {
  return (
    <Box flexDirection="column" width={60} height={24}>
      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        <ChatView
          client={{} as BaiClient}
          session={null}
          messages={[toolMessage]}
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
        />
      </Box>
      <Box paddingX={1}>
        <Text dimColor>footer hints</Text>
      </Box>
    </Box>
  );
}

describe("argsDigest preview width", () => {
  test("a long path is kept whole instead of cut at 60 chars", () => {
    expect(LONG_PATH.length).toBeGreaterThan(60);
    expect(argsDigest("fs.read", JSON.stringify({ path: LONG_PATH }))).toBe(LONG_PATH);
  });
});

describe("tool-call transcript width", () => {
  test("a long args path wraps across lines instead of clipping at the edge", async () => {
    const { lastFrame, unmount } = render(<Harness />);
    await tick();
    const frame = lastFrame() ?? "";
    unmount();

    // Every segment of the path survives the wrap (whitespace-stripped, since
    // the path breaks across the terminal width). A 60-char digest cap or a
    // `truncate` wrapper would drop the tail.
    expect(frame).toContain("fs.read");
    expect(frame.replace(/\s+/g, "")).toContain(LONG_PATH);
  });
});
