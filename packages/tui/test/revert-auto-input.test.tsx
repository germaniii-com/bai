import { describe, expect, mock, test } from "bun:test";
import { render } from "ink-testing-library";
import React, { useState } from "react";
import { Box, Text } from "ink";
import { ChatView } from "../src/views/chat";
import type { BaiClient } from "@bai/api/client";
import type { Message, MessageId, Part, PartId, Session, SessionId } from "@bai/shared";

/**
 * "Revert to here" sends the message back to the composer; the composer must
 * also switch to INPUT so the prompt is immediately editable (no extra `i`).
 * Drives the real NORMAL-mode path: ctrl+j focus → ctrl+k to the user node →
 * enter opens Message Actions → enter picks "Revert to here".
 */

const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

function textPart(messageId: string, ord: number, text: string): Part {
  return { id: `${messageId}-p${ord}` as PartId, messageId: messageId as MessageId, ord, kind: "text", payload: { text } };
}

function mockClient() {
  // Explicit parameters: bun's Mock carries calls as parameter tuples.
  const revertSession = mock((_id: string, _messageId: string) => Promise.resolve());
  const interrupt = mock((_id: string) => Promise.resolve());
  const client = { revertSession, interrupt } as unknown as BaiClient;
  return { client, revertSession, interrupt };
}

const session: Session = {
  id: "ses_1" as SessionId,
  title: "Revert test",
  workbench: "code",
  cwd: "/tmp/proj",
  createdAt: "",
  updatedAt: "",
  meta: {},
};

const messages: Message[] = [
  {
    id: "m1" as MessageId,
    sessionId: "ses_1" as SessionId,
    role: "user",
    createdAt: "t",
    parts: [textPart("m1", 0, "revert this prompt")],
  },
  {
    id: "m2" as MessageId,
    sessionId: "ses_1" as SessionId,
    role: "assistant",
    createdAt: "t",
    parts: [textPart("m2", 0, "the reply")],
  },
];

/** App-parity shell that owns INPUT/NORMAL mode like App does. */
function Harness({ client, entered }: { client: BaiClient; entered: () => void }) {
  const [mode, setMode] = useState<"normal" | "input">("normal");
  return (
    <Box flexDirection="column" width={80} height={24}>
      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        <ChatView
          client={client}
          session={session}
          messages={messages}
          runActive={false}
          mode={mode}
          modelLabel="stub/echo"
          agent="build"
          footerRows={1}
          onEnterInput={() => {
            entered();
            setMode("input");
          }}
          onExitInput={() => setMode("normal")}
          onSessionCreated={() => {}}
          onOpenSubagent={() => {}}
          onOpenModels={() => {}}
          onOpenAgents={() => {}}
          onOpenSessions={() => {}}
          onPermissionDone={() => {}}
          onChildAskDone={() => {}}
          onQuestionDone={() => {}}
        />
      </Box>
      <Box paddingX={1}>
        <Text dimColor>{mode === "normal" ? "NORMAL" : "INPUT"} footer hints</Text>
      </Box>
    </Box>
  );
}

describe("Revert to here auto-enters INPUT mode", () => {
  test("selecting Revert seeds the composer and switches to INPUT automatically", async () => {
    const { client, revertSession } = mockClient();
    const entered = mock(() => {});
    const { stdin, lastFrame, unmount } = render(<Harness client={client} entered={entered} />);
    await tick();

    // Focus the newest node, then step up onto the user message.
    stdin.write("\n"); // legacy ctrl+j (focus newest)
    await tick();
    stdin.write("\x0b"); // ctrl+k (step up to the user node)
    await tick();
    stdin.write("\r"); // open Message Actions on the focused user message
    await tick();
    expect(lastFrame() ?? "").toContain("Revert to here");

    stdin.write("\r"); // pick "Revert to here" (first option)
    await tick();
    await tick();
    const frame = lastFrame() ?? "";

    expect(revertSession).toHaveBeenCalledWith("ses_1", "m1");
    // The mode switched without an explicit `i`…
    expect(entered).toHaveBeenCalledTimes(1);
    expect(frame).toContain("INPUT");
    // …and the reverted prompt is back in the composer, ready to edit.
    expect(frame).toContain("revert this prompt");
    unmount();
  });
});
