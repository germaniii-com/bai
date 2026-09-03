import type { ModelInfo } from "@bai/shared";
import type { ContentBlock, LlmRequest, OutboundMessage, Provider, ProviderStream, StreamEvent, ToolDef } from "../types";

/** Anthropic's default when the request sets no cap (Go design §10). */
const DEFAULT_MAX_TOKENS = 4096;

type AnthropicBlock =
  | { type: "text"; text: string; cache_control?: { type: "ephemeral" } }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: [{ type: "text"; text: string }]; is_error?: boolean };

type AnthropicMessage = { role: "user" | "assistant"; content: AnthropicBlock[] };

/**
 * Outbound blocks → Anthropic content blocks (pure; unit-tested). Tool
 * results legally ride user-role messages, so user + tool_result mix is
 * valid. Thinking blocks are dropped: replaying them requires the provider's
 * signature, which bai does not persist.
 */
export function toAnthropicMessages(messages: OutboundMessage[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];
  for (const msg of messages) {
    const role = msg.role === "assistant" ? "assistant" : "user";
    const blocks: AnthropicBlock[] = [];
    if (typeof msg.content === "string") {
      if (msg.content.length > 0) blocks.push({ type: "text", text: msg.content });
    } else {
      for (const block of msg.content as ContentBlock[]) {
        if (block.type === "text") {
          if (block.text.length > 0) blocks.push({ type: "text", text: block.text });
        } else if (block.type === "tool_use") {
          blocks.push({ type: "tool_use", id: block.callId, name: block.name, input: parseArgs(block.args) });
        } else if (block.type === "tool_result") {
          blocks.push({
            type: "tool_result",
            tool_use_id: block.callId,
            content: [{ type: "text", text: block.content }],
            ...(block.isError === true ? { is_error: true } : {}),
          });
        }
        // thinking: dropped (see doc comment)
      }
    }
    if (blocks.length === 0) continue;
    const prev = out[out.length - 1];
    if (prev !== undefined && prev.role === role) {
      prev.content.push(...blocks); // Anthropic requires strictly alternating roles
    } else {
      out.push({ role, content: blocks });
    }
  }
  return out;
}

/** Tool defs → Anthropic tool descriptors (pure; unit-tested). */
export function toAnthropicTools(tools: ToolDef[]): { name: string; description?: string; input_schema: unknown }[] {
  return tools.map((t) => ({ name: t.name, ...(t.description !== undefined ? { description: t.description } : {}), input_schema: t.schema }));
}

/**
 * Anthropic Messages API adapter over the official `@anthropic-ai/sdk`.
 * Credentials arrive per request (`req.auth`); the instance is stateless.
 * Vendor SDK types are isolated in this file (ARCHITECTURE.md §10 / D17).
 */
export class AnthropicProvider implements Provider {
  constructor(private providerId: string) {}

  name(): string {
    return this.providerId;
  }

  /** Catalog-driven; the registry supplies models, not the adapter. */
  async models(): Promise<ModelInfo[]> {
    return [];
  }

  async stream(req: LlmRequest): Promise<ProviderStream> {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({
      apiKey: req.auth?.apiKey ?? "",
      ...(req.auth?.baseUrl !== undefined ? { baseURL: req.auth.baseUrl } : {}),
    });

    const tools = req.tools !== undefined && req.tools.length > 0 ? toAnthropicTools(req.tools) : undefined;
    const systemText = req.messages
      .filter((m) => m.role === "system")
      .map((m) => (typeof m.content === "string" ? m.content : m.content.filter((b) => b.type === "text").map((b) => b.text).join("\n")))
      .join("\n") || undefined;

    const bodyMessages = toAnthropicMessages(req.messages.filter((m) => m.role !== "system"));

    // Extended thinking is a chat-mode feature: agentic turns (tools present)
    // skip it — replaying thinking blocks needs provider signatures we don't
    // persist, and Anthropic requires them alongside tool_use.
    const thinking = tools === undefined ? (req.params?.thinking as { type: "enabled"; budget_tokens: number } | undefined) : undefined;
    const maxTokens =
      typeof req.params?.max_tokens === "number"
        ? req.params.max_tokens
        : thinking !== undefined
          ? Math.max(8192, thinking.budget_tokens + 6144)
          : DEFAULT_MAX_TOKENS;

    // Prompt-cache breakpoints (pi/anthropic-messages pattern): stable
    // system + tools cached once, conversation tail re-cached per turn.
    // Applied only on agentic turns, where the prefix is genuinely stable.
    const system =
      systemText !== undefined
        ? [tools !== undefined ? { type: "text" as const, text: systemText, cache_control: { type: "ephemeral" as const } } : { type: "text" as const, text: systemText }]
        : undefined;
    const apiTools =
      tools !== undefined
        ? (tools.map((t, i) => ({ ...t, ...(i === tools.length - 1 ? { cache_control: { type: "ephemeral" as const } } : {}) })) as unknown as NonNullable<Parameters<typeof client.messages.stream>[0]["tools"]>)
        : undefined;
    if (bodyMessages.length > 0 && tools !== undefined) {
      const last = bodyMessages[bodyMessages.length - 1] as AnthropicMessage;
      const lastBlock = last.content[last.content.length - 1] as AnthropicBlock | undefined;
      if (lastBlock !== undefined && lastBlock.type === "text") {
        last.content[last.content.length - 1] = { ...lastBlock, cache_control: { type: "ephemeral" as const } };
      }
    }

    const stream = client.messages.stream(
      {
        model: req.model,
        max_tokens: maxTokens,
        messages: bodyMessages,
        ...(system !== undefined ? { system } : {}),
        ...(thinking !== undefined ? { thinking } : {}),
        ...(apiTools !== undefined && apiTools.length > 0 ? { tools: apiTools } : {}),
      },
      // Interrupts cancel the in-flight request itself.
      { ...(req.signal !== undefined ? { signal: req.signal } : {}) },
    );

    // Streaming state: one tool call may span many input_json_delta chunks.
    let currentTool: { id: string; name: string } | undefined;

    async function* generate(): AsyncGenerator<StreamEvent> {
      for await (const evt of stream) {
        if (evt.type === "content_block_start") {
          currentTool = undefined;
          if (evt.content_block.type === "tool_use") {
            currentTool = { id: evt.content_block.id, name: evt.content_block.name };
            yield { type: "tool_call_delta", id: evt.content_block.id, name: evt.content_block.name, argsDelta: "" };
          }
        } else if (evt.type === "content_block_delta") {
          if (evt.delta.type === "text_delta") {
            yield { type: "text_delta", delta: evt.delta.text };
          } else if (evt.delta.type === "thinking_delta") {
            yield { type: "thinking_delta", delta: evt.delta.thinking };
          } else if (evt.delta.type === "input_json_delta" && currentTool !== undefined) {
            yield { type: "tool_call_delta", id: currentTool.id, name: currentTool.name, argsDelta: evt.delta.partial_json };
          }
        } else if (evt.type === "message_start") {
          yield { type: "usage", inputTokens: evt.message.usage?.input_tokens };
        } else if (evt.type === "message_delta") {
          yield { type: "usage", outputTokens: evt.usage.output_tokens };
          yield { type: "done", stopReason: mapStopReason(evt.delta.stop_reason) };
          return;
        }
      }
      yield { type: "done", stopReason: "end_turn" };
    }

    const iterator = generate();
    return {
      [Symbol.asyncIterator]: () => iterator,
      close: async () => {
        stream.abort();
      },
    };
  }
}

function mapStopReason(reason: string | null | undefined): string {
  if (reason === "tool_use") return "tool_use";
  if (reason === "max_tokens") return "length";
  return "end_turn";
}

function parseArgs(args: string): unknown {
  if (args.length === 0) return {};
  try {
    return JSON.parse(args);
  } catch {
    return {};
  }
}
