import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import React from "react";
import { Box } from "ink";
import type { BaiClient } from "@bai/api/client";
import type { Message, MessageId, Part, PartId, SessionId } from "@bai/shared";
import { ChatView } from "../src/views/chat";

/**
 * The TUI's per-assistant-message attribution byline ("chat . anthropic/…"),
 * rendered through the real ChatView so the transcript node actually paints —
 * the unit tests in transcript.test.ts cover the flattening, this covers the
 * rendering.
 */

const tick = (ms = 40): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function textPart(ord: number, text: string): Part {
  return { id: `part_${ord}` as PartId, messageId: "msg" as MessageId, ord, kind: "text", payload: { text } };
}

function assistant(text: string, attribution: Partial<Pick<Message, "agent" | "provider" | "model">> = {}): Message {
  return {
    id: "msg-01" as MessageId,
    sessionId: "ses_1" as SessionId,
    role: "assistant",
    createdAt: "t",
    parts: [textPart(0, text)],
    agent: attribution.agent ?? "chat",
    provider: attribution.provider ?? "anthropic",
    model: attribution.model ?? "claude-sonnet-4-5",
  };
}

function Harness({ messages, providerNames }: { messages: Message[]; providerNames?: Record<string, string> }) {
  return (
    <Box flexDirection="column" width={80} height={20}>
      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        <ChatView
          client={{} as BaiClient}
          session={null}
          messages={messages}
          runActive={false}
          mode="normal"
          modelLabel="stub/echo"
          agent="chat"
          {...(providerNames !== undefined ? { providerNames } : {})}
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
    </Box>
  );
}

describe("ChatView attribution byline", () => {
  test("renders `<agent> . <provider/model>` above the reply", async () => {
    const { lastFrame, unmount } = render(<Harness messages={[assistant("the reply body")]} />);
    await tick();
    const frame = lastFrame() ?? "";
    unmount();

    expect(frame).toContain("chat . anthropic/claude-sonnet-4-5");
    expect(frame).toContain("the reply body");
    // The byline precedes the reply body in the frame.
    expect(frame.indexOf("chat . anthropic/claude-sonnet-4-5")).toBeLessThan(frame.indexOf("the reply body"));
  });

  test("uses the provider display name when the catalog resolved one", async () => {
    const { lastFrame, unmount } = render(
      <Harness messages={[assistant("body")]} providerNames={{ anthropic: "Anthropic" }} />,
    );
    await tick();
    const frame = lastFrame() ?? "";
    unmount();

    expect(frame).toContain("chat . Anthropic/claude-sonnet-4-5");
  });

  test("an unattributed assistant message renders no byline", async () => {
    const legacy: Message = { ...assistant("legacy body") };
    delete legacy.agent;
    delete legacy.provider;
    delete legacy.model;
    const { lastFrame, unmount } = render(<Harness messages={[legacy]} />);
    await tick();
    const frame = lastFrame() ?? "";
    unmount();

    expect(frame).toContain("legacy body");
    expect(frame).not.toContain("anthropic/");
  });

  test("a turn cancelled before its first token still shows its byline", async () => {
    // Zero parts — the empty assistant message an interrupt leaves behind.
    const cancelled: Message = { ...assistant(""), parts: [] };
    const { lastFrame, unmount } = render(<Harness messages={[cancelled]} />);
    await tick();
    const frame = lastFrame() ?? "";
    unmount();

    expect(frame).toContain("chat . anthropic/claude-sonnet-4-5");
  });
});