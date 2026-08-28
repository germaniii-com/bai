import type { ModelInfo } from "@bai/shared";
import type { LlmRequest, Provider, ProviderStream, StreamEvent } from "../types";

/** Anthropic's default when the request sets no cap (Go design §10). */
const DEFAULT_MAX_TOKENS = 4096;

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

    const system = req.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n") || undefined;
    const messages = req.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role === "assistant" ? ("assistant" as const) : ("user" as const), content: m.content }));

    const stream = client.messages.stream(
      {
        model: req.model,
        max_tokens: typeof req.params?.max_tokens === "number" ? req.params.max_tokens : DEFAULT_MAX_TOKENS,
        messages,
        ...(system !== undefined ? { system } : {}),
      },
      // Interrupts cancel the in-flight request itself.
      { ...(req.signal !== undefined ? { signal: req.signal } : {}) },
    );

    async function* generate(): AsyncGenerator<StreamEvent> {
      for await (const evt of stream) {
        if (evt.type === "content_block_delta" && evt.delta.type === "text_delta") {
          yield { type: "text_delta", delta: evt.delta.text };
        } else if (evt.type === "message_start") {
          yield { type: "usage", inputTokens: evt.message.usage?.input_tokens };
        } else if (evt.type === "message_delta") {
          yield {
            type: "usage",
            outputTokens: evt.usage.output_tokens,
          };
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
