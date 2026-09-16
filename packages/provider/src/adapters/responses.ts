import type { ModelInfo } from "@bai/shared";
import type { ContentBlock, LlmRequest, OutboundMessage, Provider, ProviderStream, StreamEvent, ToolDef } from "../types";
import { buildToolNameMap, sanitizeToolName, type ToolNameMap } from "../tool-names";
import { decodeJwtClaims } from "../oauth/jwt";

/**
 * OpenAI Responses API adapter — serves ChatGPT/Codex
 * (`chatgpt.com/backend-api/codex`), xAI's Responses surface, and any other
 * Responses-speaking endpoint. The `openai` SDK appends `/responses` to the
 * configured base URL.
 *
 * Auth is Bearer (the OAuth access token or an API key). Codex additionally
 * needs `originator`, a JWT-derived `ChatGPT-Account-ID`, and per-request
 * `session_id` / `x-client-request-id` headers. Vendor types stay in this file.
 */

export type ResponsesInputItem =
  | { role: "user" | "assistant"; content: ResponsesInputContent[] }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

export type ResponsesInputContent =
  | { type: "input_text"; text: string }
  | { type: "output_text"; text: string }
  | { type: "input_image"; image_url: string };

export interface ResponsesTool {
  type: "function";
  name: string;
  description?: string;
  strict: boolean;
  parameters: unknown;
}

/** True when the base URL is the ChatGPT/Codex backend. */
export function isCodexEndpoint(baseUrl: string | undefined): boolean {
  if (baseUrl === undefined || baseUrl.length === 0) return false;
  try {
    return new URL(baseUrl).hostname === "chatgpt.com";
  } catch {
    return false;
  }
}

/** `chatgpt_account_id` claim used for the ChatGPT-Account-ID header. */
export function codexAccountId(accessToken: string | undefined): string | undefined {
  if (accessToken === undefined || accessToken.length === 0) return undefined;
  const claims = decodeJwtClaims(accessToken);
  const auth = claims?.["https://api.openai.com/auth"];
  if (auth !== null && typeof auth === "object") {
    const id = (auth as { chatgpt_account_id?: unknown }).chatgpt_account_id;
    if (typeof id === "string" && id.length > 0) return id;
  }
  return undefined;
}

/**
 * Outbound messages → Responses `input` items (pure; unit-tested). System
 * messages are extracted separately as `instructions`. Tool calls become
 * `function_call` items and tool results `function_call_output` items.
 */
export function toResponsesInput(
  messages: OutboundMessage[],
  opts: { toolNames?: ToolNameMap } = {},
): ResponsesInputItem[] {
  const out: ResponsesInputItem[] = [];
  const toolName = (name: string): string => opts.toolNames?.toProvider.get(name) ?? sanitizeToolName(name);
  for (const msg of messages) {
    if (msg.role === "system") continue; // handled as instructions
    const items: ResponsesInputItem[] = [];
    const content: ResponsesInputContent[] = [];
    const pushContent = (): void => {
      if (content.length > 0) {
        items.push({ role: msg.role === "assistant" ? "assistant" : "user", content: [...content] });
        content.length = 0;
      }
    };
    if (typeof msg.content === "string") {
      if (msg.content.length > 0) {
        content.push({ type: msg.role === "assistant" ? "output_text" : "input_text", text: msg.content });
      }
    } else {
      for (const block of msg.content as ContentBlock[]) {
        if (block.type === "text") {
          if (block.text.length > 0) {
            content.push({ type: msg.role === "assistant" ? "output_text" : "input_text", text: block.text });
          }
        } else if (block.type === "tool_use") {
          pushContent();
          items.push({ type: "function_call", call_id: block.callId, name: toolName(block.name), arguments: block.args || "{}" });
        } else if (block.type === "tool_result") {
          pushContent();
          items.push({ type: "function_call_output", call_id: block.callId, output: block.content });
        } else if (block.type === "image") {
          content.push({ type: "input_image", image_url: `data:${block.mediaType};base64,${block.data}` });
        }
        // file/thinking: not part of the Responses input surface
      }
    }
    pushContent();
    out.push(...items);
  }
  return out;
}

/** Tool defs → Responses function tools (pure; unit-tested). */
export function toResponsesTools(
  tools: ToolDef[],
  names: ToolNameMap = buildToolNameMap(tools),
): ResponsesTool[] {
  return tools.map((t) => ({
    type: "function" as const,
    name: names.toProvider.get(t.name) ?? sanitizeToolName(t.name),
    ...(t.description !== undefined ? { description: t.description } : {}),
    strict: false,
    parameters: t.schema,
  }));
}

/** System messages → a single `instructions` string. */
export function instructionsFrom(messages: OutboundMessage[]): string {
  return messages
    .filter((m) => m.role === "system")
    .map((m) => (typeof m.content === "string" ? m.content : m.content.filter((b) => b.type === "text").map((b) => b.text).join("\n")))
    .filter((t) => t.length > 0)
    .join("\n");
}

/** One streaming tool call accumulated from `function_call_arguments` deltas. */
interface PendingCall {
  callId: string;
  name: string;
}

export class ResponsesProvider implements Provider {
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
    const codex = this.providerId === "openai-codex" || isCodexEndpoint(req.auth?.baseUrl);
    const accountId = req.auth?.oauthAccountId ?? codexAccountId(req.auth?.apiKey);

    const defaultHeaders: Record<string, string> = {
      ...(req.auth?.headers ?? {}),
      ...(codex ? { originator: "bai" } : {}),
    };
    if (codex && accountId !== undefined) defaultHeaders["ChatGPT-Account-ID"] = accountId;

    const client = new OpenAI({
      apiKey: req.auth?.apiKey ?? "keyless",
      ...(req.auth?.baseUrl !== undefined ? { baseURL: req.auth.baseUrl } : {}),
      defaultHeaders,
    });

    const names = req.tools !== undefined && req.tools.length > 0 ? buildToolNameMap(req.tools) : undefined;
    const tools = req.tools !== undefined && names !== undefined ? toResponsesTools(req.tools, names) : undefined;
    const input = toResponsesInput(req.messages, names !== undefined ? { toolNames: names } : {});
    const instructions = instructionsFrom(req.messages);
    const reasoning = responsesReasoning(this.providerId, req.params);

    const body: Record<string, unknown> = {
      model: req.model,
      ...(instructions.length > 0 ? { instructions } : {}),
      input,
      store: false,
      stream: true,
      ...(tools !== undefined && tools.length > 0
        ? { tools, tool_choice: "auto", parallel_tool_calls: true }
        : {}),
      ...(reasoning !== undefined ? { reasoning } : {}),
      ...(codex ? { include: ["reasoning.encrypted_content"] } : {}),
      ...(!codex && typeof req.params?.max_tokens === "number" ? { max_output_tokens: req.params.max_tokens } : {}),
      ...(codex && req.sessionId !== undefined ? { prompt_cache_key: req.sessionId } : {}),
    };

    const extraHeaders: Record<string, string> = {};
    if (codex && req.sessionId !== undefined) {
      extraHeaders["session_id"] = req.sessionId;
      extraHeaders["x-client-request-id"] = String(body.prompt_cache_key ?? req.sessionId);
    }

    const stream = await responsesApi(client).create(body as never, {
      ...(req.signal !== undefined ? { signal: req.signal } : {}),
      ...(Object.keys(extraHeaders).length > 0 ? { headers: extraHeaders } : {}),
    });

    async function* generate(): AsyncGenerator<StreamEvent> {
      let stopReason = "end_turn";
      const pending = new Map<string, PendingCall>();
      // Per-call arguments already forwarded as deltas, so the `.done` event
      // (which carries the complete JSON) only contributes the suffix.
      const streamedArgs = new Map<string, string>();
      let currentItemKey = "";
      // The SDK's stream is an async iterable of typed events.
      for await (const raw of stream as unknown as AsyncIterable<Record<string, unknown>>) {
        const type = typeof raw.type === "string" ? raw.type : "";
        if (type === "error") {
          const err = raw.error;
          const message =
            err !== null && typeof err === "object" && typeof (err as { message?: unknown }).message === "string"
              ? (err as { message: string }).message
              : "Responses stream error";
          throw new Error(message);
        }
        if (type.includes("output_text.delta") && typeof raw.delta === "string") {
          yield { type: "text_delta", delta: raw.delta as string };
          continue;
        }
        if (type.includes("reasoning") && type.endsWith(".delta") && typeof raw.delta === "string") {
          yield { type: "thinking_delta", delta: raw.delta as string };
          continue;
        }
        if (type === "response.output_item.added") {
          const item = raw.item;
          if (item !== null && typeof item === "object" && (item as { type?: unknown }).type === "function_call") {
            const fc = item as { id?: unknown; call_id?: unknown; name?: unknown };
            const callId = typeof fc.call_id === "string" && fc.call_id.length > 0 ? fc.call_id : typeof fc.id === "string" ? fc.id : "";
            const rawName = typeof fc.name === "string" ? fc.name : "";
            const name = names?.toReal.get(rawName) ?? rawName;
            const key = typeof fc.id === "string" ? fc.id : callId;
            currentItemKey = key;
            pending.set(key, { callId, name });
            if (callId.length > 0 || name.length > 0) {
              yield { type: "tool_call_delta", id: callId, name, argsDelta: "" };
            }
          }
          continue;
        }
        if (type === "response.function_call_arguments.delta" && typeof raw.delta === "string") {
          const call = resolvePending(pending, raw, currentItemKey);
          if (call !== undefined) {
            streamedArgs.set(call.callId, (streamedArgs.get(call.callId) ?? "") + (raw.delta as string));
            yield { type: "tool_call_delta", id: call.callId, name: call.name, argsDelta: raw.delta as string };
          }
          continue;
        }
        if (type === "response.function_call_arguments.done" && typeof raw.arguments === "string") {
          const call = resolvePending(pending, raw, currentItemKey);
          if (call !== undefined) {
            // `done.arguments` is the COMPLETE arguments JSON, not a delta:
            // the `.delta` events above already streamed it. run.ts appends
            // every argsDelta, so re-emitting the full string duplicates the
            // payload (the `{"path":"a"}{"path":"a"}` malformed-JSON bug).
            // Emit only the un-streamed suffix; a server that skips the delta
            // events still gets the full string (alreadyStreamed is "").
            const already = streamedArgs.get(call.callId) ?? "";
            const missing = functionCallArgsDelta(already, raw.arguments as string);
            streamedArgs.set(call.callId, raw.arguments as string);
            if (missing.length > 0) {
              yield { type: "tool_call_delta", id: call.callId, name: call.name, argsDelta: missing };
            }
          }
          continue;
        }
        if (type === "response.completed" || type === "response.incomplete" || type === "response.failed") {
          const response = raw.response;
          if (response !== null && typeof response === "object") {
            const r = response as Record<string, unknown>;
            const usage = r.usage;
            const u = usageEvent(usage);
            if (u !== undefined) yield u;
            if (type !== "response.completed") stopReason = "length";
            const status = r.status;
            if (status === "incomplete") stopReason = "length";
          }
          break;
        }
      }
      yield { type: "done", stopReason };
    }

    const iterator = generate();
    return {
      [Symbol.asyncIterator]: () => iterator,
      close: async () => {
        try {
          (stream as { controller?: { abort?: () => void } }).controller?.abort?.();
        } catch {
          // best effort
        }
      },
    };
  }
}

/** Narrow access to `client.responses.create` without depending on SDK generics. */
function responsesApi(client: unknown): { create: (body: unknown, opts?: unknown) => Promise<unknown> } {
  const api = (client as { responses?: { create?: unknown } }).responses;
  if (api === undefined || typeof api.create !== "function") {
    throw new Error("installed openai SDK does not expose the Responses API");
  }
  return api as { create: (body: unknown, opts?: unknown) => Promise<unknown> };
}

/** Codex always sends reasoning params; other Responses endpoints only when asked. */function responsesReasoning(
  providerId: string,
  params: Record<string, unknown> | undefined,
): { effort: string; summary?: string } | undefined {
  if (providerId === "openai-codex") {
    const effort = typeof params?.reasoning_effort === "string" ? params.reasoning_effort : "medium";
    return { effort, summary: "auto" };
  }
  if (typeof params?.reasoning_effort === "string") return { effort: params.reasoning_effort };
  return undefined;
}

/**
 * The un-streamed suffix of a Responses `function_call_arguments.done`
 * payload. Responses streams `...arguments.delta` fragments and then a
 * `...arguments.done` event whose `arguments` is the COMPLETE JSON. Since the
 * consumer (run.ts) appends every argsDelta, re-emitting the whole payload
 * duplicates the arguments and produces malformed JSON. Returns only what the
 * deltas have not already carried: the full string when nothing streamed, the
 * suffix when `done.arguments` extends it, and "" when it was already sent.
 */
export function functionCallArgsDelta(alreadyStreamed: string, doneArguments: string): string {
  if (alreadyStreamed.length === 0) return doneArguments;
  return doneArguments.startsWith(alreadyStreamed) ? doneArguments.slice(alreadyStreamed.length) : "";
}

function resolvePending(
  pending: Map<string, PendingCall>,
  raw: Record<string, unknown>,
  fallbackKey: string,
): PendingCall | undefined {
  const itemId = typeof raw.item_id === "string" ? raw.item_id : typeof raw.itemId === "string" ? raw.itemId : undefined;
  if (itemId !== undefined && pending.has(itemId)) return pending.get(itemId);
  if (pending.has(fallbackKey)) return pending.get(fallbackKey);
  const first = pending.values().next();
  return first.done ? undefined : first.value;
}

function usageEvent(usage: unknown): StreamEvent | undefined {
  if (usage === null || typeof usage !== "object") return undefined;
  const u = usage as {
    input_tokens?: unknown;
    output_tokens?: unknown;
    input_tokens_details?: { cached_tokens?: unknown; cache_write_tokens?: unknown };
    output_tokens_details?: { reasoning_tokens?: unknown };
  };
  if (typeof u.input_tokens !== "number" && typeof u.output_tokens !== "number") return undefined;
  const cacheRead = typeof u.input_tokens_details?.cached_tokens === "number" ? u.input_tokens_details.cached_tokens : undefined;
  const cacheWrite = typeof u.input_tokens_details?.cache_write_tokens === "number" ? u.input_tokens_details.cache_write_tokens : undefined;
  const input = typeof u.input_tokens === "number" ? Math.max(0, u.input_tokens - (cacheRead ?? 0) - (cacheWrite ?? 0)) : undefined;
  return {
    type: "usage",
    ...(input !== undefined ? { inputTokens: input } : {}),
    ...(typeof u.output_tokens === "number" ? { outputTokens: u.output_tokens } : {}),
    ...(typeof u.output_tokens_details?.reasoning_tokens === "number"
      ? { reasoningTokens: u.output_tokens_details.reasoning_tokens }
      : {}),
    ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWriteTokens: cacheWrite } : {}),
  };
}
