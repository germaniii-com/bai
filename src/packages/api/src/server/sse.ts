import type { SSEStreamingApi } from "hono/streaming";
import type { Event } from "@bai/shared";
import type { Bus, EventLog } from "@bai/core";

const HEARTBEAT_MS = 15_000;

export function helloEvent(version: string): Event {
  return { seq: 0, type: "server.hello", ts: new Date().toISOString(), payload: { version } };
}

async function writeEvent(stream: SSEStreamingApi, evt: Event, withId: boolean): Promise<void> {
  await stream.writeSSE({
    ...(withId ? { id: String(evt.seq) } : {}),
    data: JSON.stringify(evt),
  });
}

/**
 * Durable per-session stream: replay rows after the cursor, then live-tail.
 * The DB is re-read on every wake — gaps are impossible because the database
 * is the buffer. Heartbeats keep intermediaries from closing idle streams.
 */
export async function runDurableStream(
  stream: SSEStreamingApi,
  opts: { sessionId: string; after: number; bus: Bus; log: EventLog },
): Promise<void> {
  let cursor = opts.after;
  await stream.writeSSE({ event: "server.hello", data: JSON.stringify(helloEvent("bai")) });
  const sub = opts.bus.subscribe({ buffer: 1024 });
  let stopped = false;
  const stop = () => {
    stopped = true;
    sub.close();
  };
  stream.onAbort(stop);
  try {
    while (!stopped && !stream.aborted) {
      const rows = opts.log.replay(opts.sessionId, cursor);
      for (const evt of rows) {
        cursor = Math.max(cursor, evt.seq);
        await writeEvent(stream, evt, true);
      }
      if (rows.length > 0) continue;
      await Promise.race([sub.wait(), stream.sleep(HEARTBEAT_MS)]);
      if (sub.take().length === 0 && !stopped && !stream.aborted) {
        await stream.writeSSE({ event: "ping", data: "{}" });
      }
    }
  } finally {
    stop();
  }
}

/** Global live firehose — best-effort; clients heal via snapshot on server.hello. */
export async function runFirehose(
  stream: SSEStreamingApi,
  opts: { bus: Bus; version: string },
): Promise<void> {
  await stream.writeSSE({ event: "server.hello", data: JSON.stringify(helloEvent(opts.version)) });
  const sub = opts.bus.subscribe({ buffer: 1024 });
  let stopped = false;
  const stop = () => {
    stopped = true;
    sub.close();
  };
  stream.onAbort(stop);
  try {
    while (!stopped && !stream.aborted) {
      const events = sub.take();
      if (events.length === 0) {
        await Promise.race([sub.wait(), stream.sleep(HEARTBEAT_MS)]);
        if (sub.take().length === 0 && !stopped && !stream.aborted) {
          await stream.writeSSE({ event: "ping", data: "{}" });
        }
        continue;
      }
      for (const evt of events) await writeEvent(stream, evt, false);
    }
  } finally {
    stop();
  }
}
