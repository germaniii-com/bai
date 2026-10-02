import { describe, expect, test } from "bun:test";
import type { Dispatch, SetStateAction } from "react";
import type { Event, Message, MessageId, Part, PartId, SessionId } from "@bai/shared";
import { applyEvent, buildTranscriptItems } from "../src/state/sync";

/** Build one part with a stable id. */
function part(ord: number, kind: Part["kind"], payload: unknown): Part {
  return { id: `p${ord}` as PartId, messageId: "m" as MessageId, ord, kind, payload };
}

function msg(i: number, role: Message["role"], parts: Part[]): Message {
  return {
    id: `m${String(i).padStart(2, "0")}` as MessageId,
    sessionId: "ses_1" as SessionId,
    role,
    createdAt: "t",
    parts,
  };
}

/** An assistant message carrying engine-stamped attribution. */
function attributed(i: number, parts: Part[], attribution: Partial<Pick<Message, "agent" | "provider" | "model">> = {}): Message {
  return {
    ...msg(i, "assistant", parts),
    agent: attribution.agent ?? "chat",
    provider: attribution.provider ?? "anthropic",
    model: attribution.model ?? "claude-sonnet-4-5",
  };
}

describe("buildTranscriptItems (node-level transcript)", () => {
  test("user messages flatten to one item; assistant messages to thought/tools/text", () => {
    const messages = [
      msg(0, "user", [part(0, "text", { text: "do the thing" })]),
      msg(1, "assistant", [
        part(0, "thinking", { text: "reasoning line 1\nline 2" }),
        part(1, "tool_call", { callId: "c1", name: "fs.read", args: '{"path":"a.txt"}' }),
        part(2, "tool_result", { callId: "c1", content: "contents" }),
        part(3, "tool_call", { callId: "c2", name: "task", args: '{"description":"Explore","prompt":"p","subagent_type":"plan"}' }),
        part(4, "tool_result", { callId: "c2", content: "ok", subagent: { sessionId: "ses_child", agent: "plan" } }),
        part(5, "text", { text: "all done" }),
      ]),
    ];
    const items = buildTranscriptItems(messages);
    expect(items.map((i) => i.kind)).toEqual(["user", "thought", "tool", "tool", "text"]);
    const task = items[3];
    expect(task?.kind === "tool" && task.call.name).toBe("task");
    expect(task?.kind === "tool" && task.rawArgs).toContain("Explore");
  });

  test("messages with nothing renderable are skipped", () => {
    const messages = [
      msg(0, "assistant", [part(0, "text", { text: "" })]),
      msg(1, "user", [part(0, "text", { text: "  " })]),
      msg(2, "assistant", [part(0, "text", { text: "visible" })]),
    ];
    const items = buildTranscriptItems(messages);
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe("text");
    expect(items[0]?.messageIndex).toBe(2);
  });

  test("tool items carry the paired view (status/result) in call order", () => {
    const messages = [
      msg(0, "assistant", [
        part(0, "tool_call", { callId: "b", name: "bash", args: '{"command":"ls"}' }),
        part(1, "tool_result", { callId: "b", content: "out", isError: true }),
        part(2, "tool_call", { callId: "a", name: "fs.read", args: '{"path":"x"}' }),
      ]),
    ];
    const items = buildTranscriptItems(messages);
    expect(items.map((i) => (i.kind === "tool" ? i.call.callId : ""))).toEqual(["b", "a"]);
    const first = items[0];
    expect(first?.kind === "tool" && first.call.status).toBe("error");
    expect(first?.kind === "tool" && (first.call.result?.isError ?? false)).toBe(true);
  });

  test("attribution flattens to a byline node above the message's other nodes", () => {
    const messages = [
      msg(0, "user", [part(0, "text", { text: "do it" })]),
      attributed(1, [
        part(0, "tool_call", { callId: "c1", name: "fs.read", args: '{"path":"a"}' }),
        part(1, "text", { text: "done" }),
      ]),
    ];
    const items = buildTranscriptItems(messages);
    expect(items.map((i) => i.kind)).toEqual(["user", "attribution", "tool", "text"]);
    const byline = items[1];
    expect(byline?.kind === "attribution" && byline.label).toBe("chat . anthropic/claude-sonnet-4-5");
  });

  test("the byline uses the provider display name when the catalog resolved one", () => {
    const messages = [attributed(0, [part(0, "text", { text: "hi" })])];
    const items = buildTranscriptItems(messages, { anthropic: "Anthropic" });
    expect(items[0]?.kind === "attribution" && items[0].label).toBe("chat . Anthropic/claude-sonnet-4-5");
  });

  test("messages with no attribution produce no byline node (pre-migration history)", () => {
    const messages = [msg(0, "assistant", [part(0, "text", { text: "legacy reply" })])];
    const items = buildTranscriptItems(messages);
    expect(items.map((i) => i.kind)).toEqual(["text"]);
  });

  test("an attributed turn cancelled before its first token still renders its byline", () => {
    // No parts at all — the empty assistant message a cancelled turn leaves.
    // It used to be skipped entirely, which made the turn invisible.
    const messages = [attributed(0, [])];
    const items = buildTranscriptItems(messages);
    expect(items.map((i) => i.kind)).toEqual(["attribution"]);
    expect(items[0]?.kind === "attribution" && items[0].label).toBe("chat . anthropic/claude-sonnet-4-5");
  });

  test("a user message never gets a byline, even with stray attribution fields", () => {
    const messages: Message[] = [
      { ...msg(0, "user", [part(0, "text", { text: "hi" })]), agent: "chat", provider: "anthropic", model: "claude-4" },
    ];
    const items = buildTranscriptItems(messages);
    expect(items.map((i) => i.kind)).toEqual(["user"]);
  });
});

describe("applyEvent (message.created attribution)", () => {
  function capture() {
    let messages: Message[] = [];
    const setMessages = ((update: (prev: Message[]) => Message[]) => {
      messages = update(messages);
    }) as Dispatch<SetStateAction<Message[]>>;
    return { setMessages, get: () => messages };
  }

  const createdEvent = (role: Message["role"], attribution?: Record<string, string>): Event =>
    ({
      seq: 1,
      ts: "t",
      sessionId: "ses_1",
      type: "message.created",
      payload: { messageId: "m1", role, ...attribution },
    }) as unknown as Event;

  test("an assistant turn keeps the engine-stamped attribution", () => {
    const { setMessages, get } = capture();
    applyEvent(setMessages, createdEvent("assistant", { agent: "chat", provider: "anthropic", model: "claude-4" }));
    expect(get()[0]?.agent).toBe("chat");
    expect(get()[0]?.provider).toBe("anthropic");
    expect(get()[0]?.model).toBe("claude-4");
  });

  test("a user turn gets no attribution keys invented for it", () => {
    const { setMessages, get } = capture();
    applyEvent(setMessages, createdEvent("user"));
    expect(get()[0]?.agent).toBeUndefined();
    expect(get()[0]?.provider).toBeUndefined();
    expect(get()[0]?.model).toBeUndefined();
  });
});
