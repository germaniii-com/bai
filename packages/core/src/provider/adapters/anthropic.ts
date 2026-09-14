import type { ModelInfo } from "@bai/shared";
import type { ContentBlock, LlmRequest, OutboundMessage, Provider, ProviderStream, StreamEvent, ToolDef } from "../types";
import { buildToolNameMap, sanitizeToolName, type ToolNameMap } from "../tool-names";

/** Anthropic's default when the request sets no cap (Go design §10). */
const DEFAULT_MAX_TOKENS = 4096;

/** Anthropic prompt-cache marker: cache the prefix up to this block (5m TTL). */
export type AnthropicCacheControl = { type: "ephemeral" };

type AnthropicBlock =
  | { type: "text"; text: string; cache_control?: AnthropicCacheControl }
  | { type: "tool_use"; id: string; name: string; input: unknown; cache_control?: AnthropicCacheControl }
  | { type: "tool_result"; tool_use_id: string; content: [{ type: "text"; text: string }]; is_error?: boolean; cache_control?: AnthropicCacheControl }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string }; cache_control?: AnthropicCacheControl }
  | { type: "document"; source: { type: "base64"; media_type: "application/pdf"; data: string }; cache_control?: AnthropicCacheControl };

export type AnthropicMessage = { role: "user" | "assistant"; content: AnthropicBlock[] };

/** A mapped tool descriptor (toAnthropicTools output) plus its optional cache marker. */
export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: unknown;
  cache_control?: AnthropicCacheControl;
}

/**
 * Outbound blocks → Anthropic content blocks (pure; unit-tested). Tool
 * results legally ride user-role messages, so user + tool_result mix is
 * valid. Thinking blocks are dropped: replaying them requires the provider's
 * signature, which bai does not persist.
 *
 * `opts.toolNames` maps a replayed `tool_use` name (a real registry name like
 * "fs.read") to the provider-safe alias the model originally saw; absent, the
 * name is sanitized standalone.
 */
export function toAnthropicMessages(messages: OutboundMessage[], opts: { toolNames?: ToolNameMap } = {}): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];
  const toolName = (name: string): string => opts.toolNames?.toProvider.get(name) ?? sanitizeToolName(name);
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
          blocks.push({ type: "tool_use", id: block.callId, name: toolName(block.name), input: parseArgs(block.args) });
        } else if (block.type === "tool_result") {
          blocks.push({
            type: "tool_result",
            tool_use_id: block.callId,
            content: [{ type: "text", text: block.content }],
            ...(block.isError === true ? { is_error: true } : {}),
          });
        } else if (block.type === "image") {
          blocks.push({ type: "image", source: { type: "base64", media_type: block.mediaType, data: block.data } });
        } else if (block.type === "file") {
          // bai only attaches PDFs as provider documents.
          blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: block.data } });
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

/**
 * Tool defs → Anthropic tool descriptors (pure; unit-tested). Names are
 * sanitized to `^[a-zA-Z0-9_-]+$`; the caller translates streamed aliases
 * back to the real registry names.
 */
export function toAnthropicTools(
  tools: ToolDef[],
  names: ToolNameMap = buildToolNameMap(tools),
): AnthropicTool[] {
  return tools.map((t) => ({
    name: names.toProvider.get(t.name) ?? sanitizeToolName(t.name),
    ...(t.description !== undefined ? { description: t.description } : {}),
    input_schema: t.schema,
  }));
}

/**
 * Apply Anthropic prompt-cache breakpoints on agentic turns (tools present):
 * the stable system block, the last tool descriptor, and — the important one —
 * the LAST cacheable block of the conversation, whatever its type. That tail
 * mark must NOT be limited to text: agentic requests end with a `tool_result`
 * user message, and without marking it the conversation tail is re-billed at
 * full input price on every step instead of being read from cache. Non-agentic
 * (chat) turns get no breakpoints — their prefix is short and less stable.
 *
 * Anthropic allows 4 breakpoints; this uses 3 (system, last tool, tail). Pure:
 * returns shallow copies and never mutates the inputs.
 */
export function withAnthropicCacheBreakpoints(input: {
  systemText?: string | undefined;
  tools?: AnthropicTool[] | undefined;
  messages: AnthropicMessage[];
}): {
  system: { type: "text"; text: string; cache_control?: AnthropicCacheControl }[] | undefined;
  tools: AnthropicTool[] | undefined;
  messages: AnthropicMessage[];
} {
  const tools = input.tools;
  const agentic = tools !== undefined && tools.length > 0;
  if (!agentic) {
    return {
      system: input.systemText !== undefined ? [{ type: "text" as const, text: input.systemText }] : undefined,
      tools,
      messages: input.messages,
    };
  }

  const cache: AnthropicCacheControl = { type: "ephemeral" };
  const system =
    input.systemText !== undefined
      ? [{ type: "text" as const, text: input.systemText, cache_control: cache }]
      : undefined;
  const markedTools = tools.map((t, i) => (i === tools.length - 1 ? { ...t, cache_control: cache } : { ...t }));

  return { system, tools: markedTools, messages: markTailCacheBreakpoint(input.messages, cache) };
}

/** Mark the last block of the last message (any type); already-marked or empty
 *  conversations pass through unchanged (no double marker). */
function markTailCacheBreakpoint(messages: AnthropicMessage[], cache: AnthropicCacheControl): AnthropicMessage[] {
  const lastIndex = messages.length - 1;
  if (lastIndex < 0) return messages;
  const last = messages[lastIndex] as AnthropicMessage;
  const blockIndex = last.content.length - 1;
  if (blockIndex < 0) return messages;
  const block = last.content[blockIndex] as AnthropicBlock;
  if (block.cache_control !== undefined) return messages;

  const content = last.content.slice();
  content[blockIndex] = { ...block, cache_control: cache };
  const out = messages.slice();
  out[lastIndex] = { ...last, content };
  return out;
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

    // Provider-safe aliases (dotted/slashed registry names are rejected);
    // the same map translates the model's echoed aliases back below.
    const names = req.tools !== undefined && req.tools.length > 0 ? buildToolNameMap(req.tools) : undefined;
    const tools = req.tools !== undefined && names !== undefined ? toAnthropicTools(req.tools, names) : undefined;
    const systemText = req.messages
      .filter((m) => m.role === "system")
      .map((m) => (typeof m.content === "string" ? m.content : m.content.filter((b) => b.type === "text").map((b) => b.text).join("\n")))
      .join("\n") || undefined;

    const bodyMessages = toAnthropicMessages(
      req.messages.filter((m) => m.role !== "system"),
      names !== undefined ? { toolNames: names } : {},
    );

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

    // Prompt-cache breakpoints (pi/anthropic-messages pattern): stable system
    // + tools cached once, and the conversation tail re-cached per turn — the
    // tail mark covers tool_result blocks too, so agentic steps read the prior
    // conversation from cache instead of re-billing it. Applied only on
    // agentic turns, where the prefix is genuinely stable.
    const cached = withAnthropicCacheBreakpoints({ systemText, tools, messages: bodyMessages });

    const stream = client.messages.stream(
      {
        model: req.model,
        max_tokens: maxTokens,
        // Media blocks carry `media_type: string` locally; the SDK expects its
        // literal union — the registry only ever passes canonical MIME types.
        messages: cached.messages as unknown as NonNullable<Parameters<typeof client.messages.stream>[0]>["messages"],
        ...(cached.system !== undefined ? { system: cached.system } : {}),
        ...(thinking !== undefined ? { thinking } : {}),
        ...(cached.tools !== undefined && cached.tools.length > 0
          ? { tools: cached.tools as unknown as NonNullable<Parameters<typeof client.messages.stream>[0]["tools"]> }
          : {}),
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
            // Alias → real registry name (unknown aliases pass through and
            // fail the gate as "unknown tool").
            const name = names?.toReal.get(evt.content_block.name) ?? evt.content_block.name;
            currentTool = { id: evt.content_block.id, name };
            yield { type: "tool_call_delta", id: evt.content_block.id, name, argsDelta: "" };
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
          // Full prompt-side usage lands here: input tokens plus the cache
          // split (reads = hits, creation = writes; the 1h-TTL portion is
          // billed at a different multiple and rides its own field).
          yield {
            type: "usage",
            inputTokens: evt.message.usage?.input_tokens,
            cacheReadTokens: evt.message.usage?.cache_read_input_tokens ?? undefined,
            cacheWriteTokens: evt.message.usage?.cache_creation_input_tokens ?? undefined,
            cacheWrite1hTokens: evt.message.usage?.cache_creation?.ephemeral_1h_input_tokens ?? undefined,
          };
        } else if (evt.type === "message_delta") {
          yield {
            type: "usage",
            outputTokens: evt.usage.output_tokens,
            // Reasoning (thinking) tokens — a subset of output, per the SDK's
            // OutputTokensDetails; mergeUsage keeps the first defined report.
            reasoningTokens: evt.usage.output_tokens_details?.thinking_tokens,
          };
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
