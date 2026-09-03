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
  | { type: "usage"; inputTokens?: number; outputTokens?: number }
  /** stopReason: "end_turn" | "tool_use" | "length" | "unknown" */
  | { type: "done"; stopReason?: string };

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
