import type { ModelInfo } from "@bai/shared";
import type { LlmRequest, Provider, ProviderStream, StreamEvent } from "../types";

/**
 * OpenAI wire-protocol adapter over the official `openai` SDK — serves
 * api.openai.com AND every compatible endpoint (OpenRouter, Groq, Ollama,
 * LM Studio, DeepSeek, …) via `req.auth.baseUrl`. Credentials arrive
 * per request (`req.auth`); the instance itself is stateless and shared by
 * all accounts of all openai-shaped providers.
 *
 * Vendor SDK types are isolated in this file (ARCHITECTURE.md §10 / D17).
 */
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

    const system = req.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n") || undefined;
    const conversation = req.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role === "assistant" ? ("assistant" as const) : ("user" as const), content: m.content }));
    const messages = system !== undefined ? [{ role: "system" as const, content: system }, ...conversation] : conversation;

    const stream = await client.chat.completions.create({
      model: req.model,
      // Anthropic-style default kept for parity with the Go design (§10).
      max_tokens: typeof req.params?.max_tokens === "number" ? req.params.max_tokens : 4096,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    });

    async function* generate(): AsyncGenerator<StreamEvent> {
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content;
        if (typeof delta === "string" && delta.length > 0) {
          yield { type: "text_delta", delta };
        }
        if (chunk.usage !== undefined && chunk.usage !== null) {
          yield {
            type: "usage",
            inputTokens: chunk.usage.prompt_tokens,
            outputTokens: chunk.usage.completion_tokens,
          };
        }
      }
      yield { type: "done", stopReason: "end_turn" };
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
