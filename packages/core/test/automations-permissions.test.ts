import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Store } from "../src/store/store";
import { Bus } from "../src/event/bus";
import { EventLog } from "../src/event/log";
import { PermissionGate } from "../src/permissions/ask";
import { systemClock } from "@bai/shared";

describe("permission gate — automation auto-approve", () => {
  let store: Store;
  let gate: PermissionGate;

  beforeEach(() => {
    store = new Store(":memory:");
    const bus = new Bus();
    const log = new EventLog(store.events);
    gate = new PermissionGate({
      store,
      bus,
      log,
      clock: systemClock,
      // Config-level deny that auto-approve must override for automation sessions.
      config: () => ({ permissions: { bash: "deny" } }),
    });
  });

  afterEach(() => {
    store.close();
  });

  test("meta.autoApprove allows every tool (overriding config deny) without asking", async () => {
    const session = store.sessions.insert({
      workbench: "chat",
      meta: { autoApprove: true },
      now: new Date().toISOString(),
    });
    const result = await gate.authorize({ tool: "bash", sessionId: session.id });
    expect(result.allowed).toBe(true);
    expect(result.ask).toBeUndefined();
    // No permission row was raised.
    expect(store.permissions.pendingBySession(session.id)).toHaveLength(0);
  });

  test("a normal session still honors config deny", async () => {
    const session = store.sessions.insert({
      workbench: "chat",
      meta: {},
      now: new Date().toISOString(),
    });
    const result = await gate.authorize({ tool: "bash", sessionId: session.id });
    expect(result.allowed).toBe(false);
  });
});
