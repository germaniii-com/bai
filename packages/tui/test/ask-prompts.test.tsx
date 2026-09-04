import { describe, expect, test, mock } from "bun:test";
import { render } from "ink-testing-library";
import React, { useState } from "react";
import { Box, Text } from "ink";
import type { BaiClient } from "@bai/api/client";
import type {
  Event,
  Message,
  MessageId,
  Part,
  PartId,
  PermissionRequest,
  QuestionRequest,
  SessionId,
} from "@bai/shared";
import { ChatView } from "../src/views/chat";
import { PermissionPrompt } from "../src/views/permission-prompt";
import { QuestionPrompt } from "../src/views/question-prompt";
import { applyAskIndexEvent, askIndexFrom, askUiFor, emptyAskUi, typedChar, type AskIndex, type AskUiState } from "../src/state/asks";

/**
 * The inline ask prompts (opencode's above-the-editor placement):
 *
 *   1. PermissionPrompt / QuestionPrompt key contracts (a/s/d, question
 *      keys, two-stage esc) with the App-hoisted ui state.
 *   2. ctrl-chord guards: ctrl+a must open the agent manager, never answer.
 *   3. ChatView integration: while an ask is pending the prompt replaces
 *      the composer, plain keys route to the prompt (i does NOT enter
 *      INPUT, enter does not submit, k does not scroll), and the chat's
 *      own affordances (wheel scroll) stay live.
 *   4. The hoisted-state contract: prompt progress survives unmount.
 */

const tick = (ms = 30): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---- fixtures -------------------------------------------------------------

const permRequest: PermissionRequest = {
  id: "perm_1" as PermissionRequest["id"],
  sessionId: "ses_1" as SessionId,
  tool: "bash",
  argsDigest: "fnv:deadbeef",
  status: "pending",
  detail: { summary: "echo hello", diff: "+ line one\n+ line two" },
  createdAt: "t",
};

const childPermRequest: PermissionRequest = {
  ...permRequest,
  id: "perm_2" as PermissionRequest["id"],
  sessionId: "ses_child" as SessionId,
};

/** A second ask in the SAME session — the consecutive-asks scenario. */
const nextPermRequest: PermissionRequest = {
  ...permRequest,
  id: "perm_2" as PermissionRequest["id"],
  detail: { summary: "rm -rf node_modules" },
};

const questionRequest: QuestionRequest = {
  id: "que_1" as QuestionRequest["id"],
  sessionId: "ses_1" as SessionId,
  questions: [
    {
      question: "Which database?",
      header: "db",
      options: [
        { label: "postgres", description: "relational" },
        { label: "sqlite", description: "embedded" },
      ],
    },
    {
      question: "Proceed?",
      header: "confirm",
      options: [
        { label: "yes", description: "go" },
        { label: "no", description: "stop" },
      ],
    },
  ],
};

const multiQuestion: QuestionRequest = {
  id: "que_2" as QuestionRequest["id"],
  sessionId: "ses_1" as SessionId,
  questions: [
    {
      question: "Pick toppings",
      header: "toppings",
      multiple: true,
      options: [
        { label: "cheese", description: "classic" },
        { label: "basil", description: "fresh" },
      ],
    },
  ],
};

function mockClient() {
  // Explicit parameter lists: bun's Mock carries its calls as parameter
  // tuples, so zero-arg mocks would type every call as [].
  const replyPermission = mock((_id: string, _body?: unknown) => Promise.resolve());
  const replyQuestion = mock((_id: string, _answers?: string[][]) => Promise.resolve());
  const rejectQuestion = mock((_id: string) => Promise.resolve());
  const interrupt = mock((_id: string) => Promise.resolve());
  const createSession = mock((_body?: unknown) => Promise.resolve({ id: "ses_new" }));
  const submitPrompt = mock((_id: string, _body?: unknown) => Promise.resolve());
  const client = {
    replyPermission,
    replyQuestion,
    rejectQuestion,
    interrupt,
    createSession,
    submitPrompt,
  } as unknown as BaiClient;
  return { client, replyPermission, replyQuestion, rejectQuestion, createSession };
}

// ---- prompt harnesses (ui state owned by the harness, like App does) -----

function PermissionHarness({
  request,
  client,
  queued = 0,
  onDone = () => {},
}: {
  request: PermissionRequest;
  client: BaiClient;
  queued?: number;
  onDone?: () => void;
}) {
  const [ui, setUi] = useState<AskUiState>(() => askUiFor(request));
  return (
    <PermissionPrompt client={client} request={request} ui={ui} onUi={setUi} queued={queued} onDone={onDone} />
  );
}

function QuestionHarness({
  request,
  client,
  queued = 0,
  onDone = () => {},
}: {
  request: QuestionRequest;
  client: BaiClient;
  queued?: number;
  onDone?: () => void;
}) {
  const [ui, setUi] = useState<AskUiState>(() => askUiFor(request));
  return (
    <QuestionPrompt client={client} request={request} ui={ui} onUi={setUi} queued={queued} onDone={onDone} />
  );
}

/** uiRef variant: state survives unmount (the App-hoisted contract). */
function PersistPermissionHarness({
  request,
  client,
  uiRef,
}: {
  request: PermissionRequest;
  client: BaiClient;
  uiRef: { current: AskUiState };
}) {
  const [, force] = useState(0);
  return (
    <PermissionPrompt
      client={client}
      request={request}
      ui={uiRef.current}
      onUi={(update) => {
        uiRef.current = update(uiRef.current);
        force((n) => n + 1);
      }}
      onDone={() => {}}
    />
  );
}

// ---- PermissionPrompt ------------------------------------------------------

describe("PermissionPrompt (inline)", () => {
  test("renders tool, summary, diff, and the option hints", async () => {
    const { client } = mockClient();
    const { lastFrame, unmount } = render(<PermissionHarness request={permRequest} client={client} />);
    await tick();
    const frame = lastFrame() ?? "";
    unmount();
    expect(frame).toContain("permission requested");
    expect(frame).toContain("bash");
    expect(frame).toContain("echo hello");
    expect(frame).toContain("+ line one");
    expect(frame).toContain("a allow once");
  });

  test("a approves once · s approves always", async () => {
    const { client, replyPermission } = mockClient();
    const { stdin, unmount } = render(<PermissionHarness request={permRequest} client={client} />);
    await tick();
    stdin.write("a");
    await tick();
    unmount();
    expect(replyPermission).toHaveBeenCalledTimes(1);
    expect(replyPermission.mock.calls[0]).toEqual(["perm_1", { status: "approved", scope: "once" }]);

    const second = mockClient();
    const secondRender = render(<PermissionHarness request={permRequest} client={second.client} />);
    await tick();
    secondRender.stdin.write("s");
    await tick();
    secondRender.unmount();
    expect(second.replyPermission.mock.calls[0]).toEqual(["perm_1", { status: "approved", scope: "always" }]);
  });

  test("ctrl chords never answer the ask (ctrl+a opens agents, not approve)", async () => {
    const { client, replyPermission } = mockClient();
    const { stdin, unmount } = render(<PermissionHarness request={permRequest} client={client} />);
    await tick();
    stdin.write("\x01"); // legacy ctrl+a
    await tick();
    stdin.write("\x1b[97;5u"); // kitty ctrl+a
    await tick();
    unmount();
    expect(replyPermission).not.toHaveBeenCalled();
  });

  test("esc in the choose stage never answers", async () => {
    const { client, replyPermission } = mockClient();
    const { stdin, unmount } = render(<PermissionHarness request={permRequest} client={client} />);
    await tick();
    stdin.write("\x1b");
    await tick();
    unmount();
    expect(replyPermission).not.toHaveBeenCalled();
  });

  test("d opens the reject stage; typed message rides the denial", async () => {
    const { client, replyPermission } = mockClient();
    const { stdin, lastFrame, unmount } = render(<PermissionHarness request={permRequest} client={client} />);
    await tick();
    stdin.write("d");
    await tick();
    expect(lastFrame() ?? "").toContain("reject — why?");
    for (const ch of "nope") {
      stdin.write(ch);
      await tick();
    }
    stdin.write("\r"); // enter
    await tick();
    unmount();
    expect(replyPermission).toHaveBeenCalledTimes(1);
    expect(replyPermission.mock.calls[0]).toEqual([
      "perm_1",
      { status: "rejected", scope: "once", message: "nope" },
    ]);
  });

  test("esc in the reject stage rejects without a message", async () => {
    const { client, replyPermission } = mockClient();
    const { stdin, unmount } = render(<PermissionHarness request={permRequest} client={client} />);
    await tick();
    stdin.write("d");
    await tick();
    stdin.write("\x1b");
    await tick();
    unmount();
    expect(replyPermission).toHaveBeenCalledTimes(1);
    expect(replyPermission.mock.calls[0]).toEqual(["perm_1", { status: "rejected", scope: "once" }]);
  });

  test("mouse SGR fragments never leak into the reject message", async () => {
    const { client, replyPermission } = mockClient();
    const { stdin, unmount } = render(<PermissionHarness request={permRequest} client={client} />);
    await tick();
    stdin.write("d");
    await tick();
    stdin.write("\x1b[<64;10;5M"); // wheel-up while typing
    await tick();
    stdin.write("\r");
    await tick();
    unmount();
    // The rejection carries NO message — the wheel fragment was dropped.
    expect(replyPermission.mock.calls[0]).toEqual(["perm_1", { status: "rejected", scope: "once" }]);
  });

  test("queued renders the queue indicator", async () => {
    const { client } = mockClient();
    const { lastFrame, unmount } = render(<PermissionHarness request={permRequest} client={client} queued={2} />);
    await tick();
    const frame = lastFrame() ?? "";
    unmount();
    expect(frame).toContain("2 more queued");
  });

  test("hoisted ui state survives unmount (the App contract)", async () => {
    const { client } = mockClient();
    const uiRef = { current: askUiFor(permRequest) };
    const first = render(<PersistPermissionHarness request={permRequest} client={client} uiRef={uiRef} />);
    await tick();
    first.stdin.write("d");
    await tick();
    for (const ch of "nope") {
      first.stdin.write(ch);
      await tick();
    }
    first.unmount();
    expect(uiRef.current.stage).toBe("reject");
    expect(uiRef.current.message).toBe("nope");

    // Fresh mount (as after a ctrl-chord dialog closes): the typed message
    // is still there — component-local state would have been lost.
    const second = render(<PersistPermissionHarness request={permRequest} client={client} uiRef={uiRef} />);
    await tick();
    const frame = second.lastFrame() ?? "";
    second.unmount();
    expect(frame).toContain("nope");
    expect(frame).toContain("enter reject");
  });

  test("consecutive asks: the next request on the SAME mounted instance is answerable", async () => {
    // The queue can pop ask 1 and append ask 2 in one commit (replied + next
    // asked between renders) — the prompt re-renders with a new `request`
    // instead of unmounting. The busy latch must die with its ask, or every
    // key on the second prompt is dead.
    const { client, replyPermission } = mockClient();
    const app = render(<PermissionHarness request={permRequest} client={client} />);
    await tick();
    app.stdin.write("a");
    await tick();
    expect(replyPermission.mock.calls[0]).toEqual(["perm_1", { status: "approved", scope: "once" }]);

    // Prop swap, no unmount: ask 2 becomes the head.
    app.rerender(<PermissionHarness request={nextPermRequest} client={client} />);
    await tick();
    app.stdin.write("s");
    await tick();
    app.unmount();
    expect(replyPermission.mock.calls[1]).toEqual(["perm_2", { status: "approved", scope: "always" }]);
  });

  test("a failed reply re-arms the prompt for retry (never bricks the keys)", async () => {
    const replyPermission = mock((_id: string, _body?: unknown) => Promise.reject(new Error("network blip")));
    const client = { replyPermission } as unknown as BaiClient;
    const { stdin, unmount } = render(<PermissionHarness request={permRequest} client={client} />);
    await tick();
    stdin.write("a"); // fails server-side — must not latch the prompt shut
    await tick();
    stdin.write("a"); // retry
    await tick();
    unmount();
    expect(replyPermission).toHaveBeenCalledTimes(2);
    expect(replyPermission.mock.calls[1]).toEqual(["perm_1", { status: "approved", scope: "once" }]);
  });
});

// ---- QuestionPrompt --------------------------------------------------------

describe("QuestionPrompt", () => {
  test("renders header, question, and options", async () => {
    const { client } = mockClient();
    const { lastFrame, unmount } = render(<QuestionHarness request={questionRequest} client={client} />);
    await tick();
    const frame = lastFrame() ?? "";
    unmount();
    expect(frame).toContain("question (1/2) · db");
    expect(frame).toContain("Which database?");
    expect(frame).toContain("postgres");
    expect(frame).toContain("sqlite");
  });

  test("enter picks per question; the last answer submits the block", async () => {
    const { client, replyQuestion } = mockClient();
    const { stdin, lastFrame, unmount } = render(<QuestionHarness request={questionRequest} client={client} />);
    await tick();
    stdin.write("\r"); // pick "postgres" → advance to question 2
    await tick();
    expect(lastFrame() ?? "").toContain("question (2/2) · confirm");
    expect(replyQuestion).not.toHaveBeenCalled();
    stdin.write("\r"); // pick "yes" → submit
    await tick();
    unmount();
    expect(replyQuestion).toHaveBeenCalledTimes(1);
    expect(replyQuestion.mock.calls[0]).toEqual(["que_1", [["postgres"], ["yes"]]]);
  });

  test("down arrow moves the highlight before picking", async () => {
    const { client, replyQuestion } = mockClient();
    const { stdin, unmount } = render(
      <QuestionHarness
        request={{ ...questionRequest, questions: [questionRequest.questions[0]!] }}
        client={client}
      />,
    );
    await tick();
    stdin.write("\x1b[B"); // down → sqlite
    await tick();
    stdin.write("\r");
    await tick();
    unmount();
    expect(replyQuestion.mock.calls[0]).toEqual(["que_1", [["sqlite"]]]);
  });

  test("c types a custom answer; enter submits it", async () => {
    const { client, replyQuestion } = mockClient();
    const { stdin, unmount } = render(
      <QuestionHarness
        request={{ ...questionRequest, questions: [questionRequest.questions[0]!] }}
        client={client}
      />,
    );
    await tick();
    stdin.write("c");
    await tick();
    for (const ch of "maybe") {
      stdin.write(ch);
      await tick();
    }
    stdin.write("\r");
    await tick();
    unmount();
    expect(replyQuestion.mock.calls[0]).toEqual(["que_1", [["maybe"]]]);
  });

  test("esc arms, then dismisses the whole block", async () => {
    const { client, rejectQuestion, replyQuestion } = mockClient();
    const { stdin, lastFrame, unmount } = render(<QuestionHarness request={questionRequest} client={client} />);
    await tick();
    stdin.write("\x1b");
    await tick();
    expect(lastFrame() ?? "").toContain("press esc again to dismiss");
    expect(rejectQuestion).not.toHaveBeenCalled();
    stdin.write("\x1b");
    await tick();
    unmount();
    expect(rejectQuestion).toHaveBeenCalledTimes(1);
    expect(replyQuestion).not.toHaveBeenCalled();
  });

  test("multiple mode: space toggles, enter confirms the set", async () => {
    const { client, replyQuestion } = mockClient();
    const { stdin, lastFrame, unmount } = render(<QuestionHarness request={multiQuestion} client={client} />);
    await tick();
    stdin.write(" "); // toggle cheese
    await tick();
    expect(lastFrame() ?? "").toContain("[x]");
    stdin.write("\x1b[B"); // down to basil
    await tick();
    stdin.write(" "); // toggle basil too
    await tick();
    stdin.write("\r"); // confirm both
    await tick();
    unmount();
    expect(replyQuestion.mock.calls[0]).toEqual(["que_2", [["cheese", "basil"]]]);
  });
});

// ---- ChatView integration: the inline slot + collision guards --------------

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

function AskHarness({
  client,
  messages: msgs,
  pendingAsks = [],
  pendingChildAsks = [],
  pendingQuestions = [],
  onEnterInput = () => {},
}: {
  client: BaiClient;
  messages: Message[];
  pendingAsks?: PermissionRequest[];
  pendingChildAsks?: PermissionRequest[];
  pendingQuestions?: QuestionRequest[];
  onEnterInput?: () => void;
}) {
  const head = pendingAsks[0] ?? pendingChildAsks[0] ?? pendingQuestions[0];
  const [ui, setUi] = useState<AskUiState>(() => (head !== undefined ? askUiFor(head) : emptyAskUi()));
  return (
    <Box flexDirection="column" width={60} height={24}>
      <Box borderStyle="round" paddingX={1}>
        <Text wrap="truncate">bai vdev · test session</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        <ChatView
          client={client}
          session={null}
          messages={msgs}
          runActive={false}
          mode="normal"
          onEnterInput={onEnterInput}
          onExitInput={() => {}}
          onSessionCreated={() => {}}
          onOpenSubagent={() => {}}
          pendingAsks={pendingAsks}
          pendingChildAsks={pendingChildAsks}
          pendingQuestions={pendingQuestions}
          askUi={ui}
          setAskUi={setUi}
          onPermissionDone={() => {}}
          onChildAskDone={() => {}}
          onQuestionDone={() => {}}
        />
      </Box>
      <Box paddingX={1}>
        <Text dimColor>footer hints</Text>
      </Box>
    </Box>
  );
}

describe("ChatView inline ask slot", () => {
  test("a pending permission renders the prompt instead of the composer; a answers it", async () => {
    const { client, replyPermission } = mockClient();
    const entered = mock(() => {});
    const { stdin, lastFrame, unmount } = render(
      <AskHarness client={client} messages={messages} pendingAsks={[permRequest]} onEnterInput={entered} />,
    );
    await tick();
    expect(lastFrame() ?? "").toContain("permission requested");
    expect(lastFrame() ?? "").toContain("msg-29"); // transcript still visible

    stdin.write("a"); // answers the ask…
    await tick();
    expect(replyPermission).toHaveBeenCalledTimes(1);
    expect(replyPermission.mock.calls[0]).toEqual(["perm_1", { status: "approved", scope: "once" }]);
    // …and does NOT enter INPUT mode (the modal-era collision).
    expect(entered).not.toHaveBeenCalled();
    unmount();
  });

  test("enter does not submit a prompt while an ask is pending", async () => {
    const { client, createSession } = mockClient();
    const entered = mock(() => {});
    const { stdin, unmount } = render(
      <AskHarness client={client} messages={messages} pendingAsks={[permRequest]} onEnterInput={entered} />,
    );
    await tick();
    stdin.write("\r");
    await tick();
    unmount();
    expect(createSession).not.toHaveBeenCalled();
    expect(entered).not.toHaveBeenCalled();
  });

  test("wheel scrolling still works while an ask is pending", async () => {
    const { client } = mockClient();
    const { stdin, lastFrame, unmount } = render(
      <AskHarness client={client} messages={messages} pendingAsks={[permRequest]} />,
    );
    await tick();
    expect(lastFrame() ?? "").toContain("msg-29");
    stdin.write("\x1b[<64;10;5M");
    await tick();
    expect(lastFrame() ?? "").not.toContain("msg-29");
    unmount();
  });

  test("a subagent ask renders with the origin tag and routes to the child queue", async () => {
    const { client, replyPermission } = mockClient();
    const { stdin, lastFrame, unmount } = render(
      <AskHarness client={client} messages={messages} pendingChildAsks={[childPermRequest]} />,
    );
    await tick();
    expect(lastFrame() ?? "").toContain("permission requested");
    stdin.write("a");
    await tick();
    unmount();
    expect(replyPermission).toHaveBeenCalledTimes(1);
  });

  test("consecutive pending asks: answering the head leaves the next one answerable", async () => {
    // App's queue transitions [ask1] → [ask2] in a single commit when the
    // replied event pops and the next asked event appends between renders.
    // The slot must hand the keyboard to a FRESH prompt for ask 2.
    const { client, replyPermission } = mockClient();
    const app = render(<AskHarness client={client} messages={messages} pendingAsks={[permRequest]} />);
    await tick();
    expect(app.lastFrame() ?? "").toContain("echo hello");
    app.stdin.write("a");
    await tick();
    expect(replyPermission).toHaveBeenCalledTimes(1);

    // Ask 1 popped, ask 2 appended — same commit in the wild; rerender here.
    app.rerender(<AskHarness client={client} messages={messages} pendingAsks={[nextPermRequest]} />);
    await tick();
    expect(app.lastFrame() ?? "").toContain("rm -rf node_modules");
    app.stdin.write("a");
    await tick();
    app.unmount();
    expect(replyPermission).toHaveBeenCalledTimes(2);
    expect(replyPermission.mock.calls[1]).toEqual(["perm_2", { status: "approved", scope: "once" }]);
  });

  test("a pending question: esc arms then dismisses; k does not scroll", async () => {
    const { client, rejectQuestion } = mockClient();
    const { stdin, lastFrame, unmount } = render(
      <AskHarness client={client} messages={messages} pendingQuestions={[questionRequest]} />,
    );
    await tick();
    expect(lastFrame() ?? "").toContain("question (1/2) · db");
    expect(lastFrame() ?? "").toContain("msg-29");

    stdin.write("k"); // would scroll up 1 row if the chat owned plain keys
    await tick();
    expect(lastFrame() ?? "").toContain("msg-29"); // no scroll — prompt owns keys

    stdin.write("\x1b"); // arm dismiss
    await tick();
    expect(lastFrame() ?? "").toContain("press esc again to dismiss");
    stdin.write("\x1b"); // dismiss
    await tick();
    unmount();
    expect(client.rejectQuestion).toHaveBeenCalledTimes(1);
  });
});

// ---- state/asks.ts units ---------------------------------------------------

describe("state/asks", () => {
  test("askUiFor sizes one answer slot per question", () => {
    expect(askUiFor(permRequest).answers).toEqual([]);
    const ui = askUiFor(questionRequest);
    expect(ui.answers).toEqual([[], []]);
    expect(ui.qIndex).toBe(0);
    expect(ui.stage).toBe("choose");
  });

  test("typedChar drops mouse SGR fragments and control chars, keeps printable", () => {
    expect(typedChar("[<64;10;5M")).toBe("");
    expect(typedChar("a")).toBe("a");
    expect(typedChar("\x1b")).toBe("");
    expect(typedChar(undefined)).toBe("");
    expect(typedChar("")).toBe("");
  });

  test("emptyAskUi is the neutral state", () => {
    const ui = emptyAskUi();
    expect(ui.stage).toBe("choose");
    expect(ui.message).toBe("");
    expect(ui.custom).toBeNull();
    expect(ui.dismissArmed).toBe(false);
  });

  test("askIndexFrom counts pending asks per session (session-less skipped)", () => {
    const index = askIndexFrom({
      pendingPermissions: [permRequest, { ...childPermRequest }, { ...permRequest, id: "perm_3" as PermissionRequest["id"], sessionId: undefined }],
      pendingQuestions: [questionRequest],
    });
    // perm_1 + perm_3-with-no-session → ses_1 counts only perm_1 + question…
    expect(index.get("ses_1")).toBe(2); // perm_1 + que_1
    expect(index.get("ses_child")).toBe(1); // perm_2
    expect(index.size).toBe(2);
  });

  test("applyAskIndexEvent: asked +1, replied −1, floored, other events untouched", () => {
    let index: AskIndex = new Map([["ses_1", 1]]);
    const askEvt = { type: "permission.asked", sessionId: "ses_1", payload: {} } as unknown as Event;
    const replyEvt = { type: "permission.replied", sessionId: "ses_1", payload: {} } as unknown as Event;

    index = applyAskIndexEvent(index, askEvt);
    expect(index.get("ses_1")).toBe(2);

    index = applyAskIndexEvent(index, replyEvt);
    expect(index.get("ses_1")).toBe(1);

    // One reply below zero floors at 0 and drops the entry (no churn for
    // already-empty sessions — the same object comes back).
    index = applyAskIndexEvent(index, replyEvt);
    expect(index.has("ses_1")).toBe(false);
    expect(applyAskIndexEvent(index, replyEvt)).toBe(index);

    // Question events count the same way.
    index = applyAskIndexEvent(index, { type: "question.asked", sessionId: "ses_2", payload: {} } as unknown as Event);
    expect(index.get("ses_2")).toBe(1);
    index = applyAskIndexEvent(index, { type: "question.rejected", sessionId: "ses_2", payload: {} } as unknown as Event);
    expect(index.has("ses_2")).toBe(false);

    // Unrelated events return the same map.
    const before = index;
    expect(applyAskIndexEvent(index, { type: "message.created", sessionId: "ses_1", payload: {} } as unknown as Event)).toBe(before);
    // Session-less asks can't be attributed — ignored.
    expect(applyAskIndexEvent(index, { type: "permission.asked", payload: {} } as unknown as Event)).toBe(before);
  });
});