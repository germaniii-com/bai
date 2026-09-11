import { describe, expect, mock, test } from "bun:test";
import { render } from "ink-testing-library";
import React, { useState } from "react";
import { Box, Text } from "ink";
import { ChatView } from "../src/views/chat";
import type { BaiClient } from "@bai/api/client";
import type { Message, Session, SessionId } from "@bai/shared";

/**
 * The TUI boots in workspace mode: the folder it was launched from is the
 * current workspace. These tests pin the two user-visible consequences:
 *   1. the composer hub labels the draft with that folder (not "new session");
 *   2. the first prompt creates a *code* session rooted at that folder.
 * Without a root (tests/embeds) the old cwd-less chat behaviour is retained.
 */

const tick = () => new Promise((r) => setTimeout(r, 0));

function mockClient() {
  const createSession = mock((_body?: unknown) => Promise.resolve({ id: "ses_new" } as unknown as Session));
  const submitPrompt = mock((_id: string, _body?: unknown) => Promise.resolve());
  const client = { createSession, submitPrompt } as unknown as BaiClient;
  return { client, createSession, submitPrompt };
}

/** Minimal app-parity shell that owns INPUT/NORMAL mode like App does. */
function Harness({
  client,
  session = null,
  workspaceRoot,
  onSessionCreated = () => {},
}: {
  client: BaiClient;
  session?: Session | null;
  workspaceRoot?: string;
  onSessionCreated?: (session: Session) => void;
}) {
  const [mode, setMode] = useState<"normal" | "input">("normal");
  const messages: Message[] = [];
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
          {...(workspaceRoot !== undefined ? { workspaceRoot } : {})}
          onEnterInput={() => setMode("input")}
          onExitInput={() => setMode("normal")}
          onSessionCreated={onSessionCreated}
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

/** NORMAL → INPUT, type `text`, press Enter. */
async function submit(stdin: { write: (s: string) => void }, text: string) {
  stdin.write("i");
  await tick();
  stdin.write(text);
  await tick();
  stdin.write("\r");
  await tick();
}

describe("TUI defaults to workspace mode", () => {
  test("the draft hub shows the launch folder, not 'new session'", async () => {
    const { client } = mockClient();
    const { lastFrame, unmount } = render(
      <Harness client={client} workspaceRoot="/Users/dev/Work/my-app" />,
    );
    await tick();
    const frame = lastFrame() ?? "";
    unmount();
    expect(frame).toContain("my-app");
    expect(frame).not.toContain("new session");
  });

  test("without a root the placeholder is retained (tests/embeds)", async () => {
    const { client } = mockClient();
    const { lastFrame, unmount } = render(<Harness client={client} />);
    await tick();
    const frame = lastFrame() ?? "";
    unmount();
    expect(frame).toContain("new session");
  });

  test("the first prompt creates a code session rooted at the launch folder", async () => {
    const { client, createSession, submitPrompt } = mockClient();
    const { stdin, unmount } = render(
      <Harness client={client} workspaceRoot="/Users/dev/Work/my-app" />,
    );
    await tick();
    await submit(stdin, "hello there");
    unmount();

    expect(createSession).toHaveBeenCalledTimes(1);
    expect(createSession.mock.calls[0]?.[0]).toEqual({
      workbench: "code",
      cwd: "/Users/dev/Work/my-app",
    });
    expect(submitPrompt.mock.calls[0]?.[0]).toBe("ses_new");
    expect(submitPrompt.mock.calls[0]?.[1]).toEqual({ text: "hello there" });
  });

  test("without a root the first prompt stays a cwd-less chat session", async () => {
    const { client, createSession } = mockClient();
    const { stdin, unmount } = render(<Harness client={client} />);
    await tick();
    await submit(stdin, "hi");
    unmount();

    expect(createSession).toHaveBeenCalledTimes(1);
    expect(createSession.mock.calls[0]?.[0]).toEqual({ workbench: "chat" });
  });

  test("an existing session is reused — no second session is created", async () => {
    const { client, createSession, submitPrompt } = mockClient();
    const existing: Session = {
      id: "ses_existing" as SessionId,
      title: "Existing",
      workbench: "code",
      cwd: "/Users/dev/Work/my-app",
      createdAt: "",
      updatedAt: "",
      meta: {},
    };
    const { stdin, unmount } = render(
      <Harness client={client} session={existing} workspaceRoot="/Users/dev/Work/my-app" />,
    );
    await tick();
    await submit(stdin, "follow up");
    unmount();

    expect(createSession).not.toHaveBeenCalled();
    expect(submitPrompt.mock.calls[0]?.[0]).toBe("ses_existing");
  });
});
