import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import React from "react";
import { Box, Text } from "ink";
import type { BaiClient } from "@bai/api/client";
import type { Message, MessageId, Part, PartId, SessionId } from "@bai/shared";
import { ChatView } from "../src/views/chat";

/**
 * Integration checks for the chat view's scroll wiring on the vendored
 * ScrollView, inside a replica of app.tsx's real shell nesting (fixed-height
 * root → 3-row header → flex body with paddingX → footer):
 *
 *   1. On mount the follow-the-bottom chain (content measured → sticky-bottom
 *      snap) lands the view on the NEWEST message, older content clipped.
 *   2. Wheel input (SGR mouse sequences through stdin) scrolls CONTINUOUSLY
 *      by rows — 3 rows per tick, partial steps, no message snapping.
 *   3. j/k line-scroll moves ±1 row.
 */

const tick = (ms = 30): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function textPart(ord: number, text: string): Part {
  return { id: `part_${ord}` as PartId, messageId: "msg" as MessageId, ord, kind: "text", payload: { text } };
}

function msg(i: number, role: Message["role"]): Message {
  return {
    id: `msg-${String(i).padStart(2, "0")}` as MessageId,
    sessionId: "ses_1" as SessionId,
    role,
    createdAt: "t",
    parts: [textPart(0, `msg-${String(i).padStart(2, "0")} body`)],
  };
}

const messages = Array.from({ length: 30 }, (_, i) => msg(i, i % 2 === 0 ? "user" : "assistant"));

function ChatHarness({ messages: msgs }: { messages: Message[] }) {
  // Mirrors app.tsx's shell: fixed-height root, 3-row header, flex body with
  // paddingX, footer line — the ScrollView must scroll inside THIS nesting.
  return (
    <Box flexDirection="column" width={60} height={24}>
      <Box borderStyle="round" paddingX={1}>
        <Text wrap="truncate">bai vdev · test session</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        <ChatView
          client={{} as BaiClient}
          session={null}
          messages={messages}
          runActive={false}
          mode="normal"
          onEnterInput={() => {}}
          onExitInput={() => {}}
          onSessionCreated={() => {}}
          onOpenSubagent={() => {}}
        />
      </Box>
      <Box paddingX={1}>
        <Text dimColor>footer hints</Text>
      </Box>
    </Box>
  );
}

describe("ChatView scrolling (continuous, follow-the-bottom)", () => {
  test("mounts pinned to the newest message with older content clipped", async () => {
    const { lastFrame, unmount } = render(<ChatHarness messages={messages} />);
    await tick();
    const frame = lastFrame() ?? "";
    unmount();

    // Follow-on-mount: the newest message is visible…
    expect(frame).toContain("msg-29");
    // …the oldest content is clipped above the viewport…
    expect(frame).not.toContain("msg-00");
    // …and the scroll indicator counts the messages fully above the viewport.
    expect(frame).toContain("earlier message");
    // The composer is rendered below the transcript (NORMAL prompt).
    expect(frame).toContain(": ");
  });

  test("wheel input scrolls continuously by rows (3 per tick)", async () => {
    const { stdin, lastFrame, unmount } = render(<ChatHarness messages={messages} />);
    await tick();
    expect(lastFrame() ?? "").toContain("msg-29");

    // One wheel-up tick (SGR press, button 64): 3 rows toward older content —
    // msg-29 leaves the viewport, msg-24 (partially) enters at the top.
    stdin.write("\x1b[<64;10;5M");
    await tick();
    const up = lastFrame() ?? "";
    expect(up).not.toContain("msg-29");
    expect(up).toContain("msg-24");

    // Wheel back down restores the pinned view.
    stdin.write("\x1b[<65;10;5M");
    await tick();
    expect(lastFrame() ?? "").toContain("msg-29");
    unmount();
  });

  test("j/k line-scroll moves exactly one row per press", async () => {
    const { stdin, lastFrame, unmount } = render(<ChatHarness messages={messages} />);
    await tick();
    expect(lastFrame() ?? "").toContain("msg-29");

    // Six rows up via two wheel ticks…
    stdin.write("\x1b[<64;10;5M");
    await tick();
    stdin.write("\x1b[<64;10;5M");
    await tick();
    expect(lastFrame() ?? "").not.toContain("msg-29");

    // …then five single-row j presses: still one row above the bottom, the
    // newest message's text row is clipped…
    for (let i = 0; i < 5; i++) {
      stdin.write("j");
      await tick();
    }
    expect(lastFrame() ?? "").not.toContain("msg-29");

    // …the sixth j lands exactly on the bottom (pinned)…
    stdin.write("j");
    await tick();
    expect(lastFrame() ?? "").toContain("msg-29");

    // …and one k unpins it again.
    stdin.write("k");
    await tick();
    expect(lastFrame() ?? "").not.toContain("msg-29");
    unmount();
  });

  test("ctrl+j/ctrl+k focus traversal works in every terminal spelling", async () => {
    const { stdin, lastFrame, unmount } = render(<ChatHarness messages={messages} />);
    await tick();

    // Legacy ctrl+k byte (0x0B → ch:'k', ctrl:true). First press seeds the
    // focus on the last visible message (msg-29, assistant), second steps up
    // to msg-27 (assistant) — the cyan ❯ marker shows the focus.
    stdin.write("\x0b");
    await tick();
    stdin.write("\x0b");
    await tick();
    expect(lastFrame() ?? "").toContain("❯ msg-27");

    // Legacy ctrl+j byte arrives as a raw linefeed ("\n", parsed as
    // name:'enter' with ctrl=false) — it must still step the focus DOWN
    // (msg-27 → msg-28, a user message: the marker disappears).
    stdin.write("\n");
    await tick();
    expect(lastFrame() ?? "").not.toContain("❯ msg-27");

    // Kitty-protocol ctrl+j (CSI u, codepoint 106, modifier 5 = ctrl) steps
    // down again onto the newest assistant message.
    stdin.write("\x1b[106;5u");
    await tick();
    expect(lastFrame() ?? "").toContain("❯ msg-29");

    // Kitty-protocol ctrl+k steps back up — twice: msg-29 → msg-28 (user, no
    // marker) → msg-27 (assistant, marker again).
    stdin.write("\x1b[107;5u");
    await tick();
    expect(lastFrame() ?? "").not.toContain("❯ msg-29");
    stdin.write("\x1b[107;5u");
    await tick();
    expect(lastFrame() ?? "").toContain("❯ msg-27");
    unmount();
  });

  test("focus traversal scrolls by rows to reveal offscreen messages", async () => {
    const { stdin, lastFrame, unmount } = render(<ChatHarness messages={messages} />);
    await tick();

    // Scroll well up so the newest messages are offscreen…
    stdin.write("\x1b[<64;10;5M");
    await tick();
    stdin.write("\x1b[<64;10;5M");
    await tick();
    stdin.write("\x1b[<64;10;5M");
    await tick();
    expect(lastFrame() ?? "").not.toContain("msg-29");

    // …then ctrl+j (down) repeatedly: focus walks toward the newest and the
    // view must scroll BY ROWS to reveal each newly focused message.
    for (let i = 0; i < 6; i++) {
      stdin.write("\n"); // legacy ctrl+j
      await tick();
    }
    const frame = lastFrame() ?? "";
    unmount();

    // Focus reached the newest message and the viewport followed it.
    expect(frame).toContain("❯ msg-29");
    expect(frame).toContain("msg-29");
  });
});
