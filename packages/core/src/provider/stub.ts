import type { ModelInfo } from "@bai/shared";
import type { LlmRequest, Provider, ProviderStream, StreamEvent } from "./types";

/**
 * Phase-0 provider: echoes the last user message back as streamed deltas.
 * Proves the whole pipeline (admission → drain → parts → events) without any
 * API key. Real adapters (openai/anthropic/gemini/compat) land in Phase 1.
 */
export class EchoProvider implements Provider {
  name(): string {
    return "stub";
  }

  async models(): Promise<ModelInfo[]> {
    return [
      {
        id: "stub/echo",
        provider: "stub",
        label: "Echo (stub)",
        supportsTools: false,
      },
    ];
  }

  async stream(req: LlmRequest): Promise<ProviderStream> {
    const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
    const text = lastUser?.content ?? "";
    const chunks = chunkForStream(`Echo: ${text}`);

    async function* generate(): AsyncGenerator<StreamEvent> {
      for (const chunk of chunks) {
        yield { type: "text_delta", delta: chunk };
      }
      yield { type: "done", stopReason: "end_turn" };
    }

    const iterator = generate();
    return {
      [Symbol.asyncIterator]: () => iterator,
      close: async () => {
        // nothing to release for the stub
      },
    };
  }
}

/** Split into small word-boundary chunks so clients exercise delta coalescing. */
export function chunkForStream(text: string, target = 8): string[] {
  const tokens = text.split(/(\s+)/).filter((t) => t.length > 0);
  const chunks: string[] = [];
  let current = "";
  for (const token of tokens) {
    current += token;
    if (current.length >= target) {
      chunks.push(current);
      current = "";
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
