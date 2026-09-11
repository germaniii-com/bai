import { describe, expect, test } from "bun:test";
import { renderOutbound, type ToolCallPayload, type ToolResultPayload } from "../src/run/history";
import { toAnthropicMessages, toAnthropicTools } from "../src/provider/adapters/anthropic";
import { toOpenAiMessages, toOpenAiTools, OpenAiToolCallAccumulator } from "../src/provider/adapters/openai";
import { buildToolNameMap, sanitizeToolName } from "../src/provider/tool-names";
import type { OutboundMessage } from "../src/provider/types";
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
          // Sanitized for the provider: Anthropic rejects the "." in "fs.read".
          { type: "tool_use", id: "c1", name: "fs_read", input: { path: "a" } },
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

  test("tools map with input_schema and a provider-safe name", () => {
    const tools = toAnthropicTools([{ name: "fs.read", description: "read", schema: { type: "object" } }]);
    expect(tools).toEqual([{ name: "fs_read", description: "read", input_schema: { type: "object" } }]);
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
      { role: "assistant", content: "reading", tool_calls: [{ id: "c1", type: "function", function: { name: "fs_read", arguments: '{"path":"a"}' } }] },
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

describe("attachment lowering", () => {
  test("renderOutbound resolves attachment parts via the resolver", () => {
    const message = msg("user", [
      part(0, "text", { text: "look" }),
      part(1, "attachment", { id: "ast_1", name: "p.png", mime: "image/png", bytes: 3, kind: "image" }),
    ]);
    const out = renderOutbound([message], { resolveAttachment: () => ({ mediaType: "image/png", data: "AAA" }) });
    expect(out[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image", mediaType: "image/png", data: "AAA" },
      ],
    });
  });

  test("an unresolved attachment becomes an omission note", () => {
    const message = msg("user", [part(0, "attachment", { id: "ast_1", name: "p.png", mime: "image/png", bytes: 3, kind: "image" })]);
    const out = renderOutbound([message]);
    expect(out[0]?.content).toContain("[attachment omitted: p.png]");
  });

  test("anthropic lowers image + pdf document blocks", () => {
    const out = toAnthropicMessages([
      {
        role: "user",
        content: [
          { type: "image", mediaType: "image/png", data: "AAA" },
          { type: "file", mediaType: "application/pdf", data: "BBB", filename: "d.pdf" },
        ],
      },
    ]);
    expect(out[0]?.content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } },
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: "BBB" } },
    ]);
  });

  test("openai lowers image_url + file parts", () => {
    const out = toOpenAiMessages([
      {
        role: "user",
        content: [
          { type: "text", text: "see" },
          { type: "image", mediaType: "image/png", data: "AAA" },
          { type: "file", mediaType: "application/pdf", data: "BBB", filename: "d.pdf" },
        ],
      },
    ]);
    expect(out[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "see" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
        { type: "file", file: { file_data: "data:application/pdf;base64,BBB", filename: "d.pdf" } },
      ],
    });
  });
});

describe("provider tool-name sanitization", () => {
  test("sanitizeToolName replaces rejected characters and caps at 64", () => {
    expect(sanitizeToolName("fs.read")).toBe("fs_read");
    expect(sanitizeToolName("mcp/server-a/search")).toBe("mcp_server-a_search");
    expect(sanitizeToolName("already-ok_1")).toBe("already-ok_1");
    expect(sanitizeToolName("a".repeat(80))).toHaveLength(64);
    expect(sanitizeToolName("###")).toBe("___");
    expect(sanitizeToolName("")).toBe("tool");
  });

  test("buildToolNameMap is bidirectional and collision-free", () => {
    const map = buildToolNameMap([{ name: "fs.read" }, { name: "fs_read" }, { name: "mcp/s/x" }]);
    expect(map.toProvider.get("fs.read")).toBe("fs_read");
    // Collision with the previous alias gets a deterministic suffix.
    expect(map.toProvider.get("fs_read")).toBe("fs_read_2");
    expect(map.toProvider.get("mcp/s/x")).toBe("mcp_s_x");
    expect(map.toReal.get("fs_read")).toBe("fs.read");
    expect(map.toReal.get("fs_read_2")).toBe("fs_read");
    expect(map.toReal.get("mcp_s_x")).toBe("mcp/s/x");
  });

  test("built-in dotted/slashed names all pass the provider name pattern", () => {
    const pattern = /^[a-zA-Z0-9_-]{1,64}$/;
    const builtinNames = ["bash", "fs.edit", "fs.glob", "fs.grep", "fs.list", "fs.read", "fs.write", "task", "skills.view", "mcp/server-a/search"];
    const openai = toOpenAiTools(builtinNames.map((name) => ({ name, schema: { type: "object" } })));
    const anthropic = toAnthropicTools(builtinNames.map((name) => ({ name, schema: { type: "object" } })));
    for (const tool of openai) expect(tool.function.name).toMatch(pattern);
    for (const tool of anthropic) expect(tool.name).toMatch(pattern);
  });

  test("tool_use replay maps real names to their sent aliases", () => {
    const tools = [{ name: "fs.read", description: "read", schema: { type: "object" } }];
    const map = buildToolNameMap(tools);
    const outbound: OutboundMessage[] = [
      { role: "assistant", content: [{ type: "tool_use", callId: "c1", name: "fs.read", args: "{}" }] },
    ];
    const openai = toOpenAiMessages(outbound, { toolNames: map });
    expect(openai[0]?.tool_calls?.[0]?.function.name).toBe("fs_read");
    const anthropic = toAnthropicMessages(outbound, { toolNames: map });
    expect((anthropic[0]?.content[0] as { name?: string }).name).toBe("fs_read");
  });
});

describe("OpenAiToolCallAccumulator (streaming tool-call grouping)", () => {
  test("proper server: stable index, id/name only on the first chunk", () => {
    const acc = new OpenAiToolCallAccumulator();
    const events = [
      ...acc.map([{ index: 0, id: "call_x", function: { name: "question", arguments: "" } }]),
      ...acc.map([{ index: 0, function: { arguments: "{" } }]),
      ...acc.map([{ index: 0, function: { arguments: '"questions"' } }]),
      ...acc.map([{ index: 0, function: { arguments: "}" } }]),
    ];
    expect(events).toEqual([
      { id: "call_x", name: "question", argsDelta: "" },
      { id: "call_x", name: "question", argsDelta: "{" },
      { id: "call_x", name: "question", argsDelta: '"questions"' },
      { id: "call_x", name: "question", argsDelta: "}" },
    ]);
  });

  test("broken server: index bumps per fragment, no id/name after the first", () => {
    // The GLM-gateway pattern that produced "✗ unknown <json fragment>" spam.
    const acc = new OpenAiToolCallAccumulator();
    const events = [
      ...acc.map([{ index: 0, id: "call_x", function: { name: "question", arguments: "{" } }]),
      ...acc.map([{ index: 1, function: { arguments: '"questions"' } }]),
      ...acc.map([{ index: 2, function: { arguments: ":" } }]),
      ...acc.map([{ index: 3, function: { arguments: "[" } }]),
      ...acc.map([{ index: 4, function: { arguments: "}" } }]),
    ];
    // All fragments collapse into ONE call with the real name.
    expect(events).toEqual([
      { id: "call_x", name: "question", argsDelta: "{" },
      { id: "call_x", name: "question", argsDelta: '"questions"' },
      { id: "call_x", name: "question", argsDelta: ":" },
      { id: "call_x", name: "question", argsDelta: "[" },
      { id: "call_x", name: "question", argsDelta: "}" },
    ]);
  });

  test("proper server with parallel tool calls stays separate", () => {
    const acc = new OpenAiToolCallAccumulator();
    const events = [
      ...acc.map([{ index: 0, id: "a", function: { name: "web.search", arguments: "" } }]),
      ...acc.map([{ index: 1, id: "b", function: { name: "web.fetch", arguments: "" } }]),
      ...acc.map([{ index: 0, function: { arguments: '{"q":"x"}' } }]),
      ...acc.map([{ index: 1, function: { arguments: '{"url":"y"}' } }]),
    ];
    expect(events.map((e) => e.id)).toEqual(["a", "b", "a", "b"]);
    expect(events[2]).toEqual({ id: "a", name: "web.search", argsDelta: '{"q":"x"}' });
    expect(events[3]).toEqual({ id: "b", name: "web.fetch", argsDelta: '{"url":"y"}' });
  });

  test("no index at all: fragments merge into the last call", () => {
    const acc = new OpenAiToolCallAccumulator();
    const events = [
      ...acc.map([{ id: "c1", function: { name: "todo", arguments: "" } }]),
      ...acc.map([{ function: { arguments: "{" } }]),
      ...acc.map([{ function: { arguments: "}" } }]),
    ];
    expect(events).toEqual([
      { id: "c1", name: "todo", argsDelta: "" },
      { id: "c1", name: "todo", argsDelta: "{" },
      { id: "c1", name: "todo", argsDelta: "}" },
    ]);
  });

  test("empty fragments are dropped", () => {
    const acc = new OpenAiToolCallAccumulator();
    expect(acc.map([{ index: 0, function: { arguments: "" } }])).toEqual([]);
  });
});
