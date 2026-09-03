import { EventSourceParserStream } from "eventsource-parser/stream";
import type { Event } from "@bai/shared";

export interface SseMessage {
  event: string;
  data: string;
  id?: string;
}

/** Low-level SSE reader over fetch — identical behavior in browser and Bun. */
export async function* sseStream(url: string, init?: RequestInit): AsyncGenerator<SseMessage> {
  const res = await fetch(url, init);
  if (!res.ok || res.body === null) {
    throw new Error(`SSE request failed: ${res.status} ${res.statusText}`);
  }
  // EventSourceParserStream ingests strings — decode bytes first.
  const reader = res.body
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream())
    .getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    yield { event: value.event ?? "message", data: value.data, ...(value.id !== undefined ? { id: value.id } : {}) };
  }
}

/** Parsed bai event envelopes from an SSE stream (pings filtered out). */
export async function* eventStream(url: string, init?: RequestInit): AsyncGenerator<Event> {
  for await (const message of sseStream(url, init)) {
    if (message.event === "ping") continue;
    yield JSON.parse(message.data) as Event;
  }
}
