import type { ModelInfo, Role } from "@bai/shared";

export interface OutboundMessage {
  role: Role;
  content: string;
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
  | { type: "tool_call_delta"; id: string; name: string; argsDelta: string }
  | { type: "usage"; inputTokens?: number; outputTokens?: number }
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
