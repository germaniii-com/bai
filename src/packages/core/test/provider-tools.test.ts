import { describe, expect, test } from "bun:test";
import { renderOutbound, type ToolCallPayload, type ToolResultPayload } from "../src/run/history";
import { toAnthropicMessages, toAnthropicTools } from "../src/provider/adapters/anthropic";
import { toOpenAiMessages, toOpenAiTools } from "../src/provider/adapters/openai";
import type { Message, MessageId, Part, PartId, SessionId } from "@bai/shared";

function part(ord: number, kind: Part["kind"], payload: unknown): Part {
  return { id: `part_${ord}` as PartId, messageId: "msg_1" as MessageId, ord, kind, payload };
}

function msg(role: Message["role"], parts: Part[]): Message {
  return { id: "msg_1" as MessageId, sessionId: "ses_1" as SessionId, role, createdAt: "t", parts };
}

describe("history renderer", () => {
  test("text-only history stays plain strings", () => {
    const out = renderOutbound([
      msg("user", [part(0, "text", { text: "hi" })]),
      msg("assistant", [part(0, "text", { text: "hello" })]),
    ]);
    expect(out).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
  });

  test("system prompt leads as one message", () => {
    const out = renderOutbound([msg("user", [part(0, "text", { text: "hi" })])], { system: ["persona", "env"] });
    expect(out[0]).toEqual({ role: "system", content: "persona\n\nenv" });
  });

  test("tool calls ride the assistant; results move to a following user message", () => {
    const call: ToolCallPayload = { callId: "call_1", name: "fs.read", args: '{"path":"a.ts"}' };
    const result: ToolResultPayload = { callId: "call_1", content: "file text" };
    const out = renderOutbound([
      msg("user", [part(0, "text", { text: "read a.ts" })]),
      msg("assistant", [part(0, "tool_call", call), part(1, "tool_result", result)]),
    ]);
    expect(out).toHaveLength(3);
    expect(out[1]).toEqual({
      role: "assistant",
      content: [{ type: "tool_use", callId: "call_1", name: "fs.read", args: '{"path":"a.ts"}' }],
    });
    expect(out[2]).toEqual({
      role: "user",
      content: [{ type: "tool_result", callId: "call_1", content: "file text" }],
    });
  });

  test("dangling tool calls are closed with a synthetic error result", () => {
    const call: ToolCallPayload = { callId: "call_9", name: "fs.edit", args: "{}" };
    const out = renderOutbound([msg("assistant", [part(0, "tool_call", call)])]);
    expect(out).toHaveLength(2);
    const results = out[1]?.content as { type: string; callId: string; isError?: boolean }[];
    expect(results[0]?.callId).toBe("call_9");
    expect(results[0]?.isError).toBe(true);
  });
});

describe("anthropic adapter mapping", () => {
  test("blocks lower to Anthropic content; tool_result becomes user block", () => {
    const out = toAnthropicMessages([
      { role: "user", content: "read it" },
      { role: "assistant", content: [{ type: "text", text: "reading" }, { type: "tool_use", callId: "c1", name: "fs.read", args: '{"path":"a"}' }] },
      { role: "user", content: [{ type: "tool_result", callId: "c1", content: "contents" }] },
    ]);
    expect(out).toEqual([
      { role: "user", content: [{ type: "text", text: "read it" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "reading" },
          { type: "tool_use", id: "c1", name: "fs.read", input: { path: "a" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: [{ type: "text", text: "contents" }] }] },
    ]);
  });

  test("error results carry is_error; thinking blocks are dropped", () => {
    const out = toAnthropicMessages([
      {
        role: "user",
        content: [
          { type: "thinking", text: "should be dropped" },
          { type: "tool_result", callId: "c1", content: "denied", isError: true },
        ],
      },
    ]);
    expect(out[0]?.content).toEqual([
      { type: "tool_result", tool_use_id: "c1", content: [{ type: "text", text: "denied" }], is_error: true },
    ]);
  });

  test("consecutive same-role messages merge (strict alternation)", () => {
    const out = toAnthropicMessages([
      { role: "user", content: "a" },
      { role: "user", content: [{ type: "tool_result", callId: "c", content: "r" }] },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.content).toHaveLength(2);
  });

  test("tools map with input_schema", () => {
    const tools = toAnthropicTools([{ name: "fs.read", description: "read", schema: { type: "object" } }]);
    expect(tools).toEqual([{ name: "fs.read", description: "read", input_schema: { type: "object" } }]);
  });
});

describe("openai adapter mapping", () => {
  test("assistant tool_calls + role:tool results", () => {
    const out = toOpenAiMessages([
      { role: "user", content: "read it" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "reading" },
          { type: "tool_use", callId: "c1", name: "fs.read", args: '{"path":"a"}' },
        ],
      },
      { role: "user", content: [{ type: "tool_result", callId: "c1", content: "contents" }] },
    ]);
    expect(out).toEqual([
      { role: "user", content: "read it" },
      { role: "assistant", content: "reading", tool_calls: [{ id: "c1", type: "function", function: { name: "fs.read", arguments: '{"path":"a"}' } }] },
      { role: "tool", tool_call_id: "c1", content: "contents" },
    ]);
  });

  test("tool-only assistant turns send null content", () => {
    const out = toOpenAiMessages([
      { role: "assistant", content: [{ type: "tool_use", callId: "c1", name: "t", args: "{}" }] },
    ]);
    expect(out[0]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c1", type: "function", function: { name: "t", arguments: "{}" } }],
    });
  });

  test("system messages stay first; thinking dropped", () => {
    const out = toOpenAiMessages([
      { role: "system", content: "sys" },
      { role: "user", content: [{ type: "thinking", text: "drop" }, { type: "text", text: "keep" }] },
    ]);
    expect(out).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "keep" },
    ]);
  });

  test("tools map to function descriptors", () => {
    const tools = toOpenAiTools([{ name: "t", description: "d", schema: { type: "object" } }]);
    expect(tools).toEqual([{ type: "function", function: { name: "t", description: "d", parameters: { type: "object" } } }]);
  });
});
