import type { ModelInfo } from "@bai/shared";
import type { LlmRequest, Provider, ProviderStream, StreamEvent } from "./types";

/**
 * Phase-0 provider: echoes the last user message back as streamed deltas.
 * Proves the whole pipeline (admission → drain → parts → events) without any
 * API key. Real adapters (openai/anthropic/gemini/compat) land in Phase 1.
 *
 * `stub/fs-demo` is a scripted sibling for demos and e2e tests of tool-driven
 * UI: the prompt is a JSON body `{path, content}` and the model emits ONE
 * real `fs.write` call with it (fragmented args exercise delta coalescing),
 * then ends after the result turn. Everything runs through the genuine
 * pipeline — tool gating, execution, patch parts, firehose.
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
      {
        id: "stub/fs-demo",
        provider: "stub",
        label: "FS demo (stub)",
        supportsTools: true,
      },
    ];
  }

  async stream(req: LlmRequest): Promise<ProviderStream> {
    // The registry strips the provider prefix — the vendor-side model id
    // here is "fs-demo" (full id "stub/fs-demo").
    if (req.model === "fs-demo") return this.fsDemoStream(req);
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

  /**
   * The scripted fs.write turn: prompt JSON `{path, content}` → one fs.write
   * call (args streamed in fragments); the result turn replies with a short
   * text and ends the run. Unparseable prompts fall back to the echo.
   */
  private fsDemoStream(req: LlmRequest): ProviderStream {
    const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
    const blocks = Array.isArray(lastUser?.content) ? lastUser.content : [];
    const events: StreamEvent[] = [];
    if (blocks.some((b) => b.type === "tool_result")) {
      // Second turn: the fs.write result came back — end the run.
      events.push({ type: "text_delta", delta: "Wrote the file." });
      events.push({ type: "done", stopReason: "end_turn" });
    } else {
      const text =
        blocks.find((b) => b.type === "text")?.text ?? (typeof lastUser?.content === "string" ? lastUser.content : "");
      let parsed: { path?: unknown; content?: unknown } = {};
      try {
        parsed = JSON.parse(text) as { path?: unknown; content?: unknown };
      } catch {
        // not a demo prompt — echo it back instead
      }
      if (typeof parsed.path === "string" && typeof parsed.content === "string") {
        const readArgs = JSON.stringify({ path: parsed.path });
        const writeArgs = JSON.stringify({ path: parsed.path, content: parsed.content });
        events.push({ type: "text_delta", delta: `Updating ${parsed.path}…` });
        // fs.read rides the same batch ahead of fs.write — the write guard
        // refuses to overwrite a file that was not read in this process.
        for (const fragment of fragmentArgs(readArgs)) {
          events.push({ type: "tool_call_delta", id: "demo_fs_read", name: "fs.read", argsDelta: fragment });
        }
        for (const fragment of fragmentArgs(writeArgs)) {
          events.push({ type: "tool_call_delta", id: "demo_fs_write", name: "fs.write", argsDelta: fragment });
        }
        events.push({ type: "done", stopReason: "tool_use" });
      } else {
        for (const chunk of chunkForStream(`Echo: ${text}`)) {
          events.push({ type: "text_delta", delta: chunk });
        }
        events.push({ type: "done", stopReason: "end_turn" });
      }
    }

    async function* generate(): AsyncGenerator<StreamEvent> {
      for (const evt of events) yield evt;
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

/** Fixed-size slices — JSON args have no reliable whitespace to chunk on. */
function fragmentArgs(args: string, size = 24): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += size) out.push(args.slice(i, i + size));
  return out;
}
