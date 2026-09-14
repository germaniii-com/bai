import { describe, expect, test } from "bun:test";
import {
  toAnthropicTools,
  withAnthropicCacheBreakpoints,
  type AnthropicMessage,
} from "../src/provider/adapters/anthropic";
import { isOpenAiEndpoint, openAiPromptCacheParams } from "../src/provider/adapters/openai";

/**
 * Prompt-caching regressions.
 *
 * Anthropic requires explicit `cache_control` breakpoints. The conversation
 * tail mark used to be limited to `text` blocks, so agentic requests — which
 * end in a `tool_result` user message — never cached the tail and re-billed
 * the whole conversation every step. These tests pin the breakpoint placement.
 * OpenAI caches automatically; its optional `prompt_cache_key` must only ride
 * `api.openai.com` requests (compat gateways may reject the field).
 */

const tool = (name: string) => ({ name, description: "d", input_schema: { type: "object" } });

function toolResult(id: string, content: string): AnthropicMessage {
  return { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text: content }] }] };
}

const EPHEMERAL = { type: "ephemeral" as const };

describe("withAnthropicCacheBreakpoints (agentic turns)", () => {
  test("marks system, the last tool, and a tool_result tail", () => {
    const messages: AnthropicMessage[] = [
      { role: "user", content: [{ type: "text", text: "go" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "fs_read", input: {} }] },
      toolResult("c1", "file contents"),
    ];
    const out = withAnthropicCacheBreakpoints({ systemText: "sys", tools: [tool("fs_read")], messages });

    expect(out.system?.[0]?.cache_control).toEqual(EPHEMERAL);
    expect(out.tools?.[0]?.cache_control).toEqual(EPHEMERAL);
    const last = out.messages.at(-1);
    expect(last?.content.at(-1)).toEqual({
      type: "tool_result",
      tool_use_id: "c1",
      content: [{ type: "text", text: "file contents" }],
      cache_control: EPHEMERAL,
    });
  });

  test("marks a text tail (first agentic step)", () => {
    const out = withAnthropicCacheBreakpoints({
      systemText: "sys",
      tools: [tool("t")],
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });
    expect(out.messages[0]?.content[0]).toEqual({ type: "text", text: "hi", cache_control: EPHEMERAL });
  });

  test("marks image/document/tool_use tails too (any cacheable block)", () => {
    const media: AnthropicMessage = {
      role: "user",
      content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } }],
    };
    const out = withAnthropicCacheBreakpoints({ systemText: "sys", tools: [tool("t")], messages: [media] });
    expect(out.messages[0]?.content[0]?.cache_control).toEqual(EPHEMERAL);

    const assistant: AnthropicMessage = {
      role: "assistant",
      content: [{ type: "tool_use", id: "c1", name: "t", input: {} }],
    };
    const out2 = withAnthropicCacheBreakpoints({ systemText: "sys", tools: [tool("t")], messages: [assistant] });
    expect(out2.messages[0]?.content[0]?.cache_control).toEqual(EPHEMERAL);
  });

  test("at most 3 breakpoints are placed", () => {
    const messages: AnthropicMessage[] = [
      { role: "user", content: [{ type: "text", text: "a" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "t", input: {} }] },
      toolResult("c1", "r"),
    ];
    const out = withAnthropicCacheBreakpoints({ systemText: "sys", tools: [tool("a"), tool("b")], messages });
    let markers = 0;
    for (const s of out.system ?? []) if (s.cache_control !== undefined) markers++;
    for (const t of out.tools ?? []) if (t.cache_control !== undefined) markers++;
    for (const m of out.messages) for (const b of m.content) if (b.cache_control !== undefined) markers++;
    expect(markers).toBe(3);
  });

  test("does not mutate the inputs and does not double-mark", () => {
    const messages: AnthropicMessage[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }];
    withAnthropicCacheBreakpoints({ systemText: "sys", tools: [tool("t")], messages });
    expect(messages[0]?.content[0]).toEqual({ type: "text", text: "hi" });

    const already: AnthropicMessage[] = [
      { role: "user", content: [{ type: "text", text: "hi", cache_control: EPHEMERAL }] },
    ];
    const out = withAnthropicCacheBreakpoints({ systemText: "sys", tools: [tool("t")], messages: already });
    expect(out.messages).toBe(already);
  });
});

describe("withAnthropicCacheBreakpoints (chat turns)", () => {
  test("no tools → no breakpoints anywhere", () => {
    const messages: AnthropicMessage[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }];
    const out = withAnthropicCacheBreakpoints({ systemText: "sys", messages });
    expect(out.system?.[0]?.cache_control).toBeUndefined();
    expect(out.tools).toBeUndefined();
    expect(out.messages[0]?.content[0]?.cache_control).toBeUndefined();
  });

  test("keeps mapped tools working as the helper input", () => {
    const tools = toAnthropicTools([{ name: "fs.read", description: "read", schema: { type: "object" } }]);
    const out = withAnthropicCacheBreakpoints({
      systemText: "sys",
      tools,
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });
    expect(out.tools?.[0]).toEqual({ name: "fs_read", description: "read", input_schema: { type: "object" }, cache_control: EPHEMERAL });
  });
});

describe("OpenAI prompt_cache_key gate", () => {
  test("isOpenAiEndpoint only accepts the real OpenAI host (or the SDK default)", () => {
    expect(isOpenAiEndpoint(undefined)).toBe(true);
    expect(isOpenAiEndpoint("")).toBe(true);
    expect(isOpenAiEndpoint("https://api.openai.com/v1")).toBe(true);
    expect(isOpenAiEndpoint("https://openrouter.ai/api/v1")).toBe(false);
    expect(isOpenAiEndpoint("https://api.groq.com/openai/v1")).toBe(false);
    expect(isOpenAiEndpoint("not a url")).toBe(false);
  });

  test("key is sent only for api.openai.com with a session id", () => {
    expect(openAiPromptCacheParams({ sessionId: "ses_1" })).toEqual({ prompt_cache_key: "ses_1" });
    expect(openAiPromptCacheParams({ sessionId: "ses_1", auth: { baseUrl: "https://api.openai.com/v1" } })).toEqual({
      prompt_cache_key: "ses_1",
    });
    expect(
      openAiPromptCacheParams({ sessionId: "ses_1", auth: { baseUrl: "https://openrouter.ai/api/v1" } }),
    ).toEqual({});
    expect(openAiPromptCacheParams({})).toEqual({});
  });
});
