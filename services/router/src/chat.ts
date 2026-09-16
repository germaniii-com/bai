import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { mergeUsage, type StreamEvent, type StreamUsage } from "@bai/provider";
import type { RouterDeps } from "./deps";
import { finishReason, parseChatRequest, RouterBadRequest, usageFrom } from "./openai";

/** Header carrying the saved account id (bai's multi-account selector). */
export const ACCOUNT_HEADER = "x-bai-account";

const ERROR_TYPE = "invalid_request_error";

/**
 * `POST /v1/chat/completions` — OpenAI-compatible. `model` is bai's
 * `provider/model` id; `x-bai-account` selects a saved account (falls back to
 * the config default). Streams SSE chunks when `stream:true`, else returns one
 * completion object.
 */
export async function chatCompletions(c: Context, deps: RouterDeps): Promise<Response> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { message: "invalid JSON body", type: ERROR_TYPE } }, 400);
  }

  let parsed;
  try {
    parsed = parseChatRequest(body);
  } catch (err) {
    if (err instanceof RouterBadRequest) {
      return c.json({ error: { message: err.message, type: ERROR_TYPE, code: null } }, 400);
    }
    throw err;
  }

  const account = c.req.header(ACCOUNT_HEADER) ?? undefined;
  const id = `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);

  try {
    const { stream } = await deps.router.chat(parsed.model, account, parsed.messages, {
      ...(parsed.tools !== undefined ? { tools: parsed.tools } : {}),
      params: parsed.params,
      signal: c.req.raw.signal,
    });
    return parsed.stream
      ? streamResponse(c, stream, { id, created, model: parsed.model })
      : await completionResponse(c, stream, { id, created, model: parsed.model });
  } catch (err) {
    return c.json(
      { error: { message: err instanceof Error ? err.message : String(err), type: "router_error", code: null } },
      502,
    );
  }
}

interface StreamMeta {
  id: string;
  created: number;
  model: string;
}

function streamResponse(
  c: Context,
  stream: AsyncIterable<StreamEvent> & { close(): Promise<void> },
  meta: StreamMeta,
): Response {
  return streamSSE(c, async (sse) => {
    const writeDelta = async (delta: Record<string, unknown>, finish: string | null = null): Promise<void> => {
      await sse.writeSSE({
        data: JSON.stringify({
          id: meta.id,
          object: "chat.completion.chunk",
          created: meta.created,
          model: meta.model,
          choices: [{ index: 0, delta, finish_reason: finish }],
        }),
      });
    };
    const toolIndex = new Map<string, number>();
    let usage: StreamUsage | undefined;
    try {
      await writeDelta({ role: "assistant", content: "" });
      for await (const evt of stream) {
        if (evt.type === "text_delta") {
          await writeDelta({ content: evt.delta });
        } else if (evt.type === "thinking_delta") {
          await writeDelta({ reasoning_content: evt.delta });
        } else if (evt.type === "tool_call_delta") {
          let index = toolIndex.get(evt.id);
          const first = index === undefined;
          if (index === undefined) {
            index = toolIndex.size;
            toolIndex.set(evt.id, index);
          }
          await writeDelta({
            tool_calls: [
              {
                index,
                ...(first ? { id: evt.id, type: "function" } : {}),
                function: { ...(first ? { name: evt.name } : {}), arguments: evt.argsDelta },
              },
            ],
          });
        } else if (evt.type === "usage") {
          usage = mergeUsage(usage, evt);
        } else if (evt.type === "done") {
          await writeDelta({}, finishReason(evt.stopReason));
        }
      }
      const u = usageFrom(usage);
      if (u !== undefined) {
        await sse.writeSSE({
          data: JSON.stringify({
            id: meta.id,
            object: "chat.completion.chunk",
            created: meta.created,
            model: meta.model,
            choices: [],
            usage: u,
          }),
        });
      }
    } finally {
      await stream.close();
    }
    await sse.writeSSE({ data: "[DONE]" });
  });
}

async function completionResponse(
  c: Context,
  stream: AsyncIterable<StreamEvent> & { close(): Promise<void> },
  meta: StreamMeta,
): Promise<Response> {
  let content = "";
  let stopReason: string | undefined;
  let usage: StreamUsage | undefined;
  const toolCalls: Array<{ id: string; name: string; args: string }> = [];
  const byId = new Map<string, number>();
  try {
    for await (const evt of stream) {
      if (evt.type === "text_delta") {
        content += evt.delta;
      } else if (evt.type === "tool_call_delta") {
        let index = byId.get(evt.id);
        if (index === undefined) {
          index = toolCalls.length;
          byId.set(evt.id, index);
          toolCalls.push({ id: evt.id, name: evt.name, args: "" });
        }
        const call = toolCalls[index];
        if (call !== undefined) call.args += evt.argsDelta;
      } else if (evt.type === "usage") {
        usage = mergeUsage(usage, evt);
      } else if (evt.type === "done") {
        stopReason = evt.stopReason;
      }
    }
  } finally {
    await stream.close();
  }
  const message: Record<string, unknown> = {
    role: "assistant",
    content: content.length > 0 ? content : null,
    ...(toolCalls.length > 0
      ? {
          tool_calls: toolCalls.map((call) => ({
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: call.args.length > 0 ? call.args : "{}" },
          })),
        }
      : {}),
  };
  const u = usageFrom(usage);
  return c.json({
    id: meta.id,
    object: "chat.completion",
    created: meta.created,
    model: meta.model,
    choices: [{ index: 0, message, finish_reason: finishReason(stopReason) }],
    ...(u !== undefined ? { usage: u } : {}),
  });
}
