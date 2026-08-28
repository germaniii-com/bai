import type { EventType, EventPayloads } from "./enums";
import type { SessionId } from "./ids";

interface EventBase {
  seq: number;
  ts: string;
  sessionId?: SessionId;
}

/**
 * The wire envelope for both live (firehose) and durable (per-session log)
 * events. `seq` is the per-aggregate monotonic sequence; live-only events
 * (config.updated, server.hello) use seq 0.
 *
 * Distributive by design: `Event` (no type arg) is a discriminated union, so
 * `switch (evt.type)` narrows the payload in every consumer.
 */
export type Event<K extends EventType = EventType> = K extends EventType
  ? EventBase & { type: K; payload: EventPayloads[K] }
  : never;

/** Narrow an event to a specific type at the consumer edge. */
export function eventIs<K extends EventType>(evt: Event, type: K): evt is Event<K> {
  return evt.type === type;
}
