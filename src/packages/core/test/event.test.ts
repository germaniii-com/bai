import { describe, expect, test } from "bun:test";
import { Bus } from "../src";
import type { Event } from "@bai/shared";

function evt(seq: number, type: Event["type"] = "run.started"): Event {
  return { seq, type, ts: "2026-01-01T00:00:00Z", payload: {} } as unknown as Event;
}

describe("bus", () => {
  test("publish reaches every subscriber", () => {
    const bus = new Bus();
    const a = bus.subscribe();
    const b = bus.subscribe();
    bus.publish(evt(1));
    expect(a.take()).toHaveLength(1);
    expect(b.take()).toHaveLength(1);
    expect(a.take()).toHaveLength(0);
  });

  test("wait resolves when an event arrives", async () => {
    const bus = new Bus();
    const sub = bus.subscribe();
    const waited = sub.wait();
    bus.publish(evt(1));
    await waited;
    expect(sub.take()).toHaveLength(1);
  });

  test("slow consumers are dropped and marked stale — never silently", async () => {
    const bus = new Bus();
    const sub = bus.subscribe({ buffer: 2 });
    bus.publish(evt(1));
    bus.publish(evt(2));
    bus.publish(evt(3)); // overflows → drop + stale
    expect(sub.stale).toBe(true);
    // buffer was cleared on overflow, then the overflowing event was pushed
    expect(sub.take().map((e) => e.seq)).toEqual([3]);
  });

  test("unsubscribe stops delivery", () => {
    const bus = new Bus();
    const sub = bus.subscribe();
    bus.unsubscribe(sub.id);
    bus.publish(evt(1));
    expect(sub.take()).toHaveLength(0);
  });

  test("wait resolves on abort", async () => {
    const bus = new Bus();
    const sub = bus.subscribe();
    const ctrl = new AbortController();
    const waited = sub.wait(ctrl.signal);
    ctrl.abort();
    await waited;
  });
});
