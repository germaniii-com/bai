import type { ModelInfo, Role } from "@bai/shared";

/**
 * One content block of an outbound message. Text-only turns stay plain
 * strings; agentic turns carry tool calls (assistant) and results (user
 * side). Adapters lower blocks to the vendor wire format.
 */
export type ContentBlock =
  | { type: "text"; text: string }
  /** Reasoning text — replayed natively by Anthropic, dropped by OpenAI-compat. */
  | { type: "thinking"; text: string }
  | { type: "tool_use"; callId: string; name: string; /** Raw JSON text of the arguments. */ args: string }
  | { type: "tool_result"; callId: string; content: string; isError?: boolean };

export interface OutboundMessage {
  role: Role;
  content: string | ContentBlock[];
}

export interface ToolDef {
  name: string;
  description?: string;
  /** JSON Schema for the tool's arguments. */
  schema: unknown;
}

export interface LlmRequest {
  /** Catalog id, e.g. "stub/echo". */
  model: string;
  messages: OutboundMessage[];
  tools?: ToolDef[];
  params?: Record<string, unknown>;
  /**
   * Request-scoped credentials, resolved by the registry from the account
   * store (multi-account support). Adapters stay stateless — no per-key
   * client caching, key rotation applies to the very next call.
   */
  auth?: { apiKey?: string; baseUrl?: string };
  /**
   * Stable id of the conversation this request belongs to (the bai session
   * id). Sent as `x-opencode-session` by adapters so gateways/proxies can
   * attribute traffic per conversation. Optional — background jobs
   * (summarizers) may omit it.
   */
  sessionId?: string;
  /**
   * Abort signal from the run coordinator — interrupts must cancel the
   * in-flight HTTP request, not just stop consuming chunks (a provider that
   * withholds its first token would otherwise hold the drain hostage).
   */
  signal?: AbortSignal;
}

export type StreamEvent =
  | { type: "text_delta"; delta: string }
  /** Reasoning tokens (chain of thought) — rendered behind a click-to-reveal panel. */
  | { type: "thinking_delta"; delta: string }
  | { type: "tool_call_delta"; id: string; name: string; argsDelta: string }
  | ({ type: "usage" } & StreamUsage)
  /** stopReason: "end_turn" | "tool_use" | "length" | "unknown" */
  | { type: "done"; stopReason?: string };

/**
 * Provider-reported token usage for one request. All fields optional —
 * providers (and proxies) vary in what they report. Components are DISJOINT:
 * `inputTokens` excludes cache reads/writes (adapters normalize — OpenAI's
 * prompt_tokens includes them, Anthropic's input_tokens does not).
 * `reasoningTokens` is a SUBSET of `outputTokens` (both vendors bill thinking
 * inside completion output), never added on top. Cache reads are prompt
 * tokens served from the provider's cache; cache writes are prompt tokens
 * that created cache entries (Anthropic splits them by TTL — the 1h portion
 * is billed at a different multiple, so it rides its own field).
 */
export interface StreamUsage {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cacheWrite1hTokens?: number;
}

/** Merge consecutive usage events (adapters may report input and output in
 *  separate chunks) — later defined values win, undefined passes through. */
export function mergeUsage(a: StreamUsage | undefined, evt: StreamUsage): StreamUsage {
  return {
    inputTokens: evt.inputTokens ?? a?.inputTokens,
    outputTokens: evt.outputTokens ?? a?.outputTokens,
    reasoningTokens: evt.reasoningTokens ?? a?.reasoningTokens,
    cacheReadTokens: evt.cacheReadTokens ?? a?.cacheReadTokens,
    cacheWriteTokens: evt.cacheWriteTokens ?? a?.cacheWriteTokens,
    cacheWrite1hTokens: evt.cacheWrite1hTokens ?? a?.cacheWrite1hTokens,
  };
}

export interface ProviderStream extends AsyncIterable<StreamEvent> {
  close(): Promise<void>;
}

/**
 * Thin interface over LLM vendors — deliberately no agent framework.
 * Adapters isolate vendor SDK types inside their own files.
 */
export interface Provider {
  name(): string;
  models(): Promise<ModelInfo[]>;
  stream(req: LlmRequest): Promise<ProviderStream>;
}
