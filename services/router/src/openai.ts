import type { ContentBlock, OutboundMessage, StreamUsage, ToolDef } from "@bai/provider";

/**
 * OpenAI wire ⇄ bai provider-neutral translation. The gateway speaks the
 * OpenAI chat-completions / images wire shape (the lingua franca of external
 * clients) and lowers it to the same `OutboundMessage[]` + `LlmRequest` the
 * in-process run loop builds — so routing semantics stay identical.
 */

export interface OpenAiToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

export interface OpenAiChatMessage {
  role?: string;
  content?: unknown;
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface OpenAiChatRequest {
  model?: string;
  messages?: OpenAiChatMessage[];
  tools?: Array<{ type?: string; function?: { name?: string; description?: string; parameters?: unknown } }>;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  reasoning_effort?: string;
  [key: string]: unknown;
}

export interface ParsedChatRequest {
  model: string;
  messages: OutboundMessage[];
  tools?: ToolDef[];
  params: Record<string, unknown>;
  stream: boolean;
}

export class RouterBadRequest extends Error {}

/** Parse + lower an OpenAI chat body. Throws `RouterBadRequest` on bad input. */
export function parseChatRequest(body: unknown): ParsedChatRequest {
  const req = (typeof body === "object" && body !== null ? body : {}) as OpenAiChatRequest;
  const model = typeof req.model === "string" ? req.model.trim() : "";
  if (model.length === 0) throw new RouterBadRequest("`model` is required");
  if (!Array.isArray(req.messages)) throw new RouterBadRequest("`messages` must be an array");
  const tools = toToolDefs(req.tools);
  return {
    model,
    messages: toOutboundMessages(req.messages),
    ...(tools.length > 0 ? { tools } : {}),
    params: toParams(req),
    stream: req.stream === true,
  };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (typeof part === "object" && part !== null && typeof (part as { text?: unknown }).text === "string") {
          return (part as { text: string }).text;
        }
        return "";
      })
      .join("");
  }
  return "";
}

function blocksOf(content: unknown): ContentBlock[] {
  if (typeof content === "string") return content.length > 0 ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  const blocks: ContentBlock[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      if (part.length > 0) blocks.push({ type: "text", text: part });
      continue;
    }
    if (typeof part !== "object" || part === null) continue;
    const rec = part as { type?: string; text?: unknown; image_url?: { url?: unknown } };
    if ((rec.type === "text" || rec.type === undefined) && typeof rec.text === "string") {
      blocks.push({ type: "text", text: rec.text });
      continue;
    }
    if (rec.type === "image_url" && typeof rec.image_url?.url === "string") {
      const decoded = parseDataUrl(rec.image_url.url);
      if (decoded !== undefined) blocks.push({ type: "image", mediaType: decoded.mediaType, data: decoded.data });
    }
  }
  return blocks;
}

/** Split `data:<mime>;base64,<payload>` into its parts, or undefined. */
export function parseDataUrl(url: string): { mediaType: string; data: string } | undefined {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (match === null) return undefined;
  return { mediaType: match[1] as string, data: match[2] as string };
}

/**
 * Lower OpenAI messages to bai's outbound shape. `role:"tool"` results are
 * batch into one synthetic user message (bai's convention — tool results ride
 * a following user turn), matching `run/history.ts`.
 */
export function toOutboundMessages(messages: OpenAiChatMessage[]): OutboundMessage[] {
  const out: OutboundMessage[] = [];
  let pendingResults: ContentBlock[] = [];
  const flush = (): void => {
    if (pendingResults.length > 0) {
      out.push({ role: "user", content: pendingResults });
      pendingResults = [];
    }
  };
  for (const msg of messages) {
    const role = typeof msg.role === "string" ? msg.role : "user";
    if (role === "tool") {
      pendingResults.push({
        type: "tool_result",
        callId: typeof msg.tool_call_id === "string" ? msg.tool_call_id : "",
        content: textOf(msg.content),
      });
      continue;
    }
    flush();
    if (role === "system" || role === "developer") {
      const text = textOf(msg.content);
      if (text.length > 0) out.push({ role: "system", content: text });
      continue;
    }
    if (role === "assistant") {
      const blocks: ContentBlock[] = [];
      const text = textOf(msg.content);
      if (text.length > 0) blocks.push({ type: "text", text });
      for (const call of msg.tool_calls ?? []) {
        const name = call.function?.name;
        if (typeof name !== "string" || name.length === 0) continue;
        blocks.push({
          type: "tool_use",
          callId: typeof call.id === "string" ? call.id : "",
          name,
          args: typeof call.function?.arguments === "string" ? call.function.arguments : "{}",
        });
      }
      out.push({ role: "assistant", content: blocks.length > 0 ? blocks : text });
      continue;
    }
    // user
    const blocks = blocksOf(msg.content);
    out.push({ role: "user", content: blocks.length > 0 ? blocks : textOf(msg.content) });
  }
  flush();
  return out;
}

export function toToolDefs(tools: OpenAiChatRequest["tools"]): ToolDef[] {
  if (!Array.isArray(tools)) return [];
  const out: ToolDef[] = [];
  for (const tool of tools) {
    const name = tool?.function?.name;
    if (typeof name !== "string" || name.length === 0) continue;
    out.push({
      name,
      ...(typeof tool.function?.description === "string" ? { description: tool.function.description } : {}),
      schema: tool.function?.parameters ?? { type: "object", properties: {} },
    });
  }
  return out;
}

/** Map OpenAI sampling/reasoning fields onto bai's `params` bag. */
export function toParams(req: OpenAiChatRequest): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  const maxTokens = typeof req.max_tokens === "number" ? req.max_tokens : req.max_completion_tokens;
  if (typeof maxTokens === "number") params.max_tokens = maxTokens;
  if (typeof req.temperature === "number") params.temperature = req.temperature;
  if (typeof req.top_p === "number") params.top_p = req.top_p;
  if (typeof req.reasoning_effort === "string") params.reasoning_effort = req.reasoning_effort;
  return params;
}

// --- response shapes -------------------------------------------------------

export interface OpenAiUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export function usageFrom(usage: StreamUsage | undefined): OpenAiUsage | undefined {
  if (usage === undefined) return undefined;
  const prompt = (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) + (usage.cacheWrite1hTokens ?? 0);
  const completion = usage.outputTokens ?? 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
  };
}

export function finishReason(stopReason: string | undefined): "stop" | "tool_calls" | "length" {
  if (stopReason === "tool_use") return "tool_calls";
  if (stopReason === "length") return "length";
  return "stop";
}
