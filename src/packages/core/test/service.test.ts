import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeCore, sleep, waitForEvent, type TestCore } from "./harness";

describe("service + run coordinator", () => {
  let t: TestCore;

  beforeEach(() => {
    t = makeCore();
  });

  afterEach(() => {
    t.store.close();
    rmSync(t.dir, { recursive: true, force: true });
  });

  test("create → submit → drain → history (echo provider)", async () => {
    const finished = waitForEvent(t.bus, "run.finished");
    const session = t.core.createSession({ title: "test", workbench: "chat" });
    t.core.submitPrompt(session.id, { text: "hello world" });
    await finished;

    const history = t.core.history(session.id);
    expect(history).toHaveLength(2);
    expect(history[0]?.role).toBe("user");
    expect((history[0]?.parts[0]?.payload as { text: string }).text).toBe("hello world");
    expect(history[1]?.role).toBe("assistant");
    expect((history[1]?.parts[0]?.payload as { text: string }).text).toContain("Echo: hello world");
  });

  test("durable event log records the full run", async () => {
    const finished = waitForEvent(t.bus, "run.finished");
    const session = t.core.createSession({ workbench: "chat" });
    t.core.submitPrompt(session.id, { text: "hi" });
    await finished;

    const replay = t.log.replay(session.id, 0);
    const types = replay.map((e) => e.type);
    expect(types).toContain("session.created");
    expect(types).toContain("input.admitted");
    expect(types).toContain("run.started");
    expect(types.filter((x) => x === "message.created")).toHaveLength(2);
    expect(types.filter((x) => x === "message.part.delta").length).toBeGreaterThan(0);
    expect(types[types.length - 1]).toBe("run.finished");
    // seq is monotonic per session
    const seqs = replay.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  test("cursor replay: events after N only", async () => {
    const finished = waitForEvent(t.bus, "run.finished");
    const session = t.core.createSession({ workbench: "chat" });
    t.core.submitPrompt(session.id, { text: "hi" });
    await finished;

    const all = t.log.replay(session.id, 0);
    const mid = all[Math.floor(all.length / 2)]?.seq ?? 0;
    const after = t.log.replay(session.id, mid);
    expect(after[0]?.seq).toBe(mid + 1);
  });

  test("interrupt on idle session is safe", () => {
    const session = t.core.createSession({ workbench: "chat" });
    expect(() => t.core.interrupt(session.id)).not.toThrow();
  });

  test("unknown session submit throws", () => {
    expect(() => t.core.submitPrompt("ses_nope" as never, { text: "x" })).toThrow(/Unknown session/);
  });

  test("rename + archive emit session.updated", async () => {
    const session = t.core.createSession({ workbench: "chat" });
    const updated = waitForEvent(t.bus, "session.updated");
    t.core.renameSession(session.id, "new name");
    await updated;
    expect(t.core.getSession(session.id)?.title).toBe("new name");

    const archived = waitForEvent(t.bus, "session.updated");
    t.core.archiveSession(session.id);
    await archived;
    expect(t.core.getSession(session.id)?.meta.archived).toBe(true);
  });

  test("steering: second prompt during a drain still lands", async () => {
    const finished = waitForEvent(t.bus, "run.finished", { timeoutMs: 5000 });
    const session = t.core.createSession({ workbench: "chat" });
    t.core.submitPrompt(session.id, { text: "first" });
    await sleep(20); // let the drain start
    t.core.submitPrompt(session.id, { text: "second" }); // steer
    await finished;
    await sleep(50); // allow the coalesced wake to drain too

    const history = t.core.history(session.id);
    const userTexts = history
      .filter((m) => m.role === "user")
      .map((m) => (m.parts[0]?.payload as { text: string }).text);
    expect(userTexts).toContain("first");
    expect(userTexts).toContain("second");
  });
});
