import type { ModelInfo } from "@bai/shared";
import type { ContentBlock, LlmRequest, OutboundMessage, Provider, ProviderStream, StreamEvent, ToolDef } from "../types";

/**
 * OpenAI wire-protocol adapter over the official `openai` SDK — serves
 * api.openai.com AND every compatible endpoint (OpenRouter, Groq, Ollama,
 * LM Studio, DeepSeek, …) via `req.auth.baseUrl`. Credentials arrive
 * per request (`req.auth`); the instance itself is stateless and shared by
 * all accounts of all openai-shaped providers.
 *
 * Vendor SDK types are isolated in this file (ARCHITECTURE.md §10 / D17).
 */

export interface OpenAiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

/**
 * Outbound messages → OpenAI chat messages (pure; unit-tested). Tool calls
 * ride the assistant message as `tool_calls`; each result becomes a
 * `role:"tool"` message with the matching `tool_call_id`. Thinking blocks
 * are dropped (reasoning replay is not part of the chat-completions wire).
 */
export function toOpenAiMessages(messages: OutboundMessage[]): OpenAiMessage[] {
  const out: OpenAiMessage[] = [];
  for (const msg of messages) {
    if (msg.role === "system") {
      const text = typeof msg.content === "string" ? msg.content : msg.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      if (text.length > 0) out.push({ role: "system", content: text });
      continue;
    }

    if (typeof msg.content === "string") {
      out.push({ role: msg.role === "assistant" ? "assistant" : "user", content: msg.content });
      continue;
    }

    let text = "";
    const toolCalls: NonNullable<OpenAiMessage["tool_calls"]> = [];
    const toolResults: OpenAiMessage[] = [];
    for (const block of msg.content as ContentBlock[]) {
      if (block.type === "text") {
        text += (text.length > 0 ? "\n" : "") + block.text;
      } else if (block.type === "tool_use") {
        toolCalls.push({ id: block.callId, type: "function", function: { name: block.name, arguments: block.args } });
      } else if (block.type === "tool_result") {
        toolResults.push({ role: "tool", tool_call_id: block.callId, content: block.content });
      }
      // thinking: dropped (see doc comment)
    }

    if (msg.role === "assistant") {
      out.push({
        role: "assistant",
        content: text.length > 0 || toolCalls.length === 0 ? text : null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
    } else {
      if (text.length > 0) out.push({ role: "user", content: text });
      out.push(...toolResults);
    }
  }
  return out;
}

/** Tool defs → OpenAI function-tool descriptors (pure; unit-tested). */
export function toOpenAiTools(tools: ToolDef[]): { type: "function"; function: { name: string; description?: string; parameters: unknown } }[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: { name: t.name, ...(t.description !== undefined ? { description: t.description } : {}), parameters: t.schema },
  }));
}

/** One streaming tool-call fragment as the SDK delivers it. */
export interface OpenAiToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

/** A grouped tool call: stable id + accumulated name, fed by fragments. */
export interface GroupedToolCall {
  id: string;
  name: string;
  argsDelta: string;
}

/**
 * Groups streaming `delta.tool_calls` fragments into stable tool calls.
 *
 * The OpenAI wire contract identifies a tool call by `index` across chunks;
 * `id` and `name` usually arrive only on that index's first chunk. Some
 * OpenAI-compatible servers (GLM gateways, etc.) instead bump `index` per
 * fragment and omit id/name on later chunks — without grouping, every JSON
 * fragment of the arguments becomes a separate "unknown" tool call.
 *
 * Resolution rule per fragment:
 *   - has id/name            → (re)open the call at its index, record identity
 *   - index already seen     → continuation of that call (proper servers)
 *   - new index, no identity → continuation of the most recent call
 *                              (broken servers that bump index per fragment)
 */
export class OpenAiToolCallAccumulator {
  private byIndex = new Map<number, { id: string; name: string }>();
  private last: { id: string; name: string } | undefined;
  private nextIndex = 0;

  map(deltas: OpenAiToolCallDelta[]): GroupedToolCall[] {
    const out: GroupedToolCall[] = [];
    for (const call of deltas) {
      const index = call.index ?? this.nextIndex++;
      const id = typeof call.id === "string" ? call.id : "";
      const name = typeof call.function?.name === "string" ? call.function.name : "";
      const hasIdentity = id.length > 0 || name.length > 0;

      let acc: { id: string; name: string };
      if (hasIdentity) {
        acc = this.byIndex.get(index) ?? { id: "", name: "" };
        this.byIndex.set(index, acc);
        if (id.length > 0) acc.id = id;
        if (name.length > 0) acc.name = name;
      } else if (this.byIndex.has(index)) {
        acc = this.byIndex.get(index) as { id: string; name: string }; // proper server: same index continues
      } else {
        acc = this.last ?? { id: "", name: "" }; // broken server: new index, no identity → keep going
        this.byIndex.set(index, acc);
      }
      this.last = acc;

      const argsDelta = call.function?.arguments ?? "";
      if (acc.id.length > 0 || acc.name.length > 0 || argsDelta.length > 0) {
        out.push({ id: acc.id.length > 0 ? acc.id : `__idx_${index}`, name: acc.name, argsDelta });
      }
    }
    return out;
  }
}

export class OpenAiCompatProvider implements Provider {
  constructor(private providerId: string) {}

  name(): string {
    return this.providerId;
  }

  /** Catalog-driven; the registry supplies models, not the adapter. */
  async models(): Promise<ModelInfo[]> {
    return [];
  }

  async stream(req: LlmRequest): Promise<ProviderStream> {
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({
      apiKey: req.auth?.apiKey ?? "keyless",
      ...(req.auth?.baseUrl !== undefined ? { baseURL: req.auth.baseUrl } : {}),
    });

    const system = toOpenAiMessages(req.messages.filter((m) => m.role === "system"));
    const conversation = toOpenAiMessages(req.messages.filter((m) => m.role !== "system"));
    const messages = [...system, ...conversation] as unknown as Parameters<typeof client.chat.completions.create>[0]["messages"];

    const apiTools =
      req.tools !== undefined && req.tools.length > 0
        ? (toOpenAiTools(req.tools) as unknown as NonNullable<Parameters<typeof client.chat.completions.create>[0]["tools"]>)
        : undefined;

    const stream = await client.chat.completions.create(
      {
        model: req.model,
        // Anthropic-style default kept for parity with the Go design (§10).
        max_tokens: typeof req.params?.max_tokens === "number" ? req.params.max_tokens : 4096,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        ...(apiTools !== undefined && apiTools.length > 0 ? { tools: apiTools } : {}),
      },
      // Interrupts cancel the in-flight request itself.
      { ...(req.signal !== undefined ? { signal: req.signal } : {}) },
    );

    async function* generate(): AsyncGenerator<StreamEvent> {
      let stopReason = "end_turn";
      // Groups tool-call fragments by index (see OpenAiToolCallAccumulator) —
      // without this, servers that omit id/name on later chunks would turn
      // every JSON fragment into a separate "unknown" tool call.
      const toolAccum = new OpenAiToolCallAccumulator();
      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        const delta = choice?.delta;
        // Reasoning models (DeepSeek R1, OpenRouter reasoning, …) stream
        // chain-of-thought in non-standard fields before the answer.
        const ext = delta as unknown as { reasoning_content?: unknown; reasoning?: unknown } | undefined;
        const reasoning = ext?.reasoning_content ?? ext?.reasoning;
        if (typeof reasoning === "string" && reasoning.length > 0) {
          yield { type: "thinking_delta", delta: reasoning };
        }
        if (typeof delta?.content === "string" && delta.content.length > 0) {
          yield { type: "text_delta", delta: delta.content };
        }
        if (delta?.tool_calls !== undefined) {
          for (const grouped of toolAccum.map(delta.tool_calls as OpenAiToolCallDelta[])) {
            yield { type: "tool_call_delta", id: grouped.id, name: grouped.name, argsDelta: grouped.argsDelta };
          }
        }
        if (choice?.finish_reason !== undefined && choice.finish_reason !== null) {
          stopReason = mapFinishReason(choice.finish_reason);
        }
        if (chunk.usage !== undefined && chunk.usage !== null) {
          yield {
            type: "usage",
            inputTokens: chunk.usage.prompt_tokens,
            outputTokens: chunk.usage.completion_tokens,
          };
        }
      }
      yield { type: "done", stopReason };
    }

    const iterator = generate();
    return {
      [Symbol.asyncIterator]: () => iterator,
      close: async () => {
        stream.controller.abort();
      },
    };
  }
}

function mapFinishReason(reason: string): string {
  if (reason === "tool_calls" || reason === "function_call") return "tool_use";
  if (reason === "length") return "length";
  return "end_turn";
}
