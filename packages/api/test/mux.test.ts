import { describe, expect, test } from "bun:test";
import type { Event } from "@bai/shared";
import { EventMux } from "../src/client/mux";

const evt = (n: number, type = "config.updated"): Event =>
  ({ seq: 0, ts: "t", type, payload: {} }) as unknown as Event;

/** A controllable fake firehose: yields scripted events, then holds until aborted. */
function fakeFirehose(): {
  open: (signal: AbortSignal) => AsyncGenerator<Event>;
  /** Push an event to the current (or next) connection. */
  emit: (evt: Event) => Promise<void>;
  /** Fail the current connection (simulates a drop). */
  drop: (err?: unknown) => void;
  /** How many times a connection was opened. */
  connections: () => number;
} {
  let resolveWait: (() => void) | null = null;
  let rejectWait: ((err: unknown) => void) | null = null;
  let queue: Event[] = [];
  let connections = 0;

  const open = (signal: AbortSignal): AsyncGenerator<Event> => {
    return (async function* () {
      connections++;
      while (!signal.aborted) {
        // Take from the queue, or suspend until emit/drop/abort wakes us.
        const e =
          queue.length > 0
            ? queue.shift()
            : await new Promise<Event | null>((resolve, reject) => {
                resolveWait = () => resolve(queue.shift() as Event);
                rejectWait = reject;
                signal.addEventListener("abort", () => resolve(null as unknown as Event), { once: true });
              });
        if (e === null || e === undefined) return; // aborted
        yield e;
      }
    })();
  };

  return {
    open,
    emit: async (e) => {
      queue.push(e);
      resolveWait?.();
      resolveWait = null;
      rejectWait = null;
      await new Promise((r) => setTimeout(r, 5));
    },
    drop: (err = new Error("drop")) => {
      rejectWait?.(err);
      rejectWait = null;
      resolveWait = null;
    },
    connections: () => connections,
  };
}

const tick = () => new Promise((r) => setTimeout(r, 20));

describe("EventMux", () => {
  test("fans every event out to all subscribers", async () => {
    const firehose = fakeFirehose();
    const mux = new EventMux(firehose.open);
    const seen1: Event[] = [];
    const seen2: Event[] = [];
    const off1 = mux.subscribe((e) => seen1.push(e));
    mux.subscribe((e) => seen2.push(e));
    await tick();

    await firehose.emit(evt(1));
    await firehose.emit(evt(2));
    expect(seen1).toHaveLength(2);
    expect(seen2).toHaveLength(2);

    off1();
    await firehose.emit(evt(3));
    expect(seen1).toHaveLength(2); // unsubscribed — no more delivery
    expect(seen2).toHaveLength(3);
  });

  test("opens the connection on first subscribe, closes on last unsubscribe", async () => {
    const firehose = fakeFirehose();
    const mux = new EventMux(firehose.open);
    expect(firehose.connections()).toBe(0);

    const off = mux.subscribe(() => {});
    await tick();
    expect(firehose.connections()).toBe(1);

    off();
    await tick();
    // Re-subscribing opens a fresh connection.
    mux.subscribe(() => {});
    await tick();
    expect(firehose.connections()).toBe(2);
  });

  test("reconnects after a drop and keeps delivering", async () => {
    const firehose = fakeFirehose();
    const mux = new EventMux(firehose.open);
    const seen: Event[] = [];
    mux.subscribe((e) => seen.push(e));
    await tick();

    await firehose.emit(evt(1));
    firehose.drop(); // connection dies
    await tick(); // backoff (500ms) + reconnect
    await new Promise((r) => setTimeout(r, 600));
    expect(firehose.connections()).toBeGreaterThanOrEqual(2);

    await firehose.emit(evt(2));
    expect(seen.map((e) => e.type)).toEqual(["config.updated", "config.updated"]);
  });

  test("a throwing subscriber is isolated — the stream survives for others", async () => {
    const firehose = fakeFirehose();
    const mux = new EventMux(firehose.open);
    const seen: Event[] = [];
    mux.subscribe(() => {
      throw new Error("bad subscriber");
    });
    mux.subscribe((e) => seen.push(e));
    await tick();

    await firehose.emit(evt(1));
    await firehose.emit(evt(2));
    expect(seen).toHaveLength(2);
    expect(firehose.connections()).toBe(1); // no reconnect churn
  });

  test("unsubscribing the last subscriber aborts the held stream", async () => {
    const firehose = fakeFirehose();
    const mux = new EventMux(firehose.open);
    const off = mux.subscribe(() => {});
    await tick();
    off();
    await tick();
    // The loop stopped: a new subscribe opens a NEW connection (not resumed).
    mux.subscribe(() => {});
    await tick();
    expect(firehose.connections()).toBe(2);
  });
});
