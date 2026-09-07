import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src";

describe("store", () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bai-store-"));
    store = new Store(join(dir, "test.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("sessions roundtrip", () => {
    const created = store.sessions.insert({ title: "hello", workbench: "chat", now: "2026-01-01T00:00:00Z" });
    expect(created.id.startsWith("ses_")).toBe(true);
    const fetched = store.sessions.get(created.id);
    expect(fetched?.title).toBe("hello");
    expect(fetched?.workbench).toBe("chat");

    const updated = store.sessions.update(created.id, { title: "renamed", now: "2026-01-01T00:01:00Z" });
    expect(updated?.title).toBe("renamed");
    expect(store.sessions.list(10, 0)).toHaveLength(1);
  });

  test("messages + parts history is ordered", () => {
    const ses = store.sessions.insert({ workbench: "chat", now: "2026-01-01T00:00:00Z" });
    const m1 = store.messages.append(ses.id, "user", "2026-01-01T00:00:01Z");
    store.parts.append(m1.id, 0, "text", { text: "first" });
    const m2 = store.messages.append(ses.id, "assistant", "2026-01-01T00:00:02Z");
    store.parts.append(m2.id, 0, "text", { text: "second" });

    const history = store.messages.history(ses.id);
    expect(history).toHaveLength(2);
    expect(history[0]?.role).toBe("user");
    expect((history[0]?.parts[0]?.payload as { text: string }).text).toBe("first");
    expect(history[1]?.role).toBe("assistant");
    expect((history[1]?.parts[0]?.payload as { text: string }).text).toBe("second");
  });

  test("inputs admit → promote steers (atomic)", () => {
    const ses = store.sessions.insert({ workbench: "chat", now: "2026-01-01T00:00:00Z" });
    store.inputs.admit(ses.id, { text: "one" }, "2026-01-01T00:00:01Z");
    store.inputs.admit(ses.id, { text: "two" }, "2026-01-01T00:00:02Z");

    const promoted = store.inputs.promoteSteers(ses.id);
    expect(promoted).toHaveLength(2);
    expect(promoted.every((i) => i.state === "promoted")).toBe(true);
    // second call is empty — nothing left admitted
    expect(store.inputs.promoteSteers(ses.id)).toHaveLength(0);
  });

  test("inputs delivery modes: steers and queued promote separately", () => {
    const ses = store.sessions.insert({ workbench: "chat", now: "2026-01-01T00:00:00Z" });
    const steer = store.inputs.admit(ses.id, { text: "steer" }, "2026-01-01T00:00:01Z");
    const q1 = store.inputs.admit(ses.id, { text: "q1", queue: true }, "2026-01-01T00:00:02Z");
    const q2 = store.inputs.admit(ses.id, { text: "q2", queue: true }, "2026-01-01T00:00:03Z");
    expect(steer.queued).toBe(false);
    expect(q1.queued).toBe(true);
    expect(q2.queued).toBe(true);

    // Steers promote only steers; queued stay pending.
    const promotedSteers = store.inputs.promoteSteers(ses.id);
    expect(promotedSteers.map((i) => i.id)).toEqual([steer.id]);
    expect(store.inputs.hasPendingQueued(ses.id)).toBe(true);
    expect(store.inputs.hasPendingSteers(ses.id)).toBe(false);

    // Queued promote ONE at a time, oldest first.
    const first = store.inputs.promoteNextQueued(ses.id);
    expect(first?.id).toBe(q1.id);
    expect(first?.state).toBe("promoted");
    const second = store.inputs.promoteNextQueued(ses.id);
    expect(second?.id).toBe(q2.id);
    expect(store.inputs.promoteNextQueued(ses.id)).toBeUndefined();
    expect(store.inputs.pendingBySession(ses.id)).toHaveLength(0);
  });

  test("inputs sendNow flips queued → steer; cancelInput cancels one", () => {
    const ses = store.sessions.insert({ workbench: "chat", now: "2026-01-01T00:00:00Z" });
    const q1 = store.inputs.admit(ses.id, { text: "q1", queue: true }, "2026-01-01T00:00:01Z");
    const q2 = store.inputs.admit(ses.id, { text: "q2", queue: true }, "2026-01-01T00:00:02Z");

    // Send-now: the input stays admitted but steers at the next boundary.
    const flipped = store.inputs.sendNow(ses.id, q1.id);
    expect(flipped?.queued).toBe(false);
    expect(flipped?.state).toBe("admitted");
    expect(store.inputs.hasPendingSteers(ses.id)).toBe(true);
    expect(store.inputs.hasPendingQueued(ses.id)).toBe(true);

    // Cancel removes exactly one pending input.
    const cancelled = store.inputs.cancelInput(ses.id, q2.id);
    expect(cancelled?.state).toBe("cancelled");
    expect(store.inputs.pendingBySession(ses.id).map((i) => i.id)).toEqual([q1.id]);

    // Non-pending / unknown ids are undefined (mapped to 409 upstream).
    expect(store.inputs.sendNow(ses.id, q2.id)).toBeUndefined();
    expect(store.inputs.cancelInput(ses.id, "inp_unknown" as never)).toBeUndefined();
  });

  test("durable events allocate monotonic seq per aggregate", () => {
    const ses = store.sessions.insert({ workbench: "chat", now: "2026-01-01T00:00:00Z" });
    const e1 = store.events.append(ses.id, "run.started", {}, "2026-01-01T00:00:01Z");
    const e2 = store.events.append(ses.id, "run.finished", { aborted: false }, "2026-01-01T00:00:02Z");
    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(2);

    const replay = store.events.replay(ses.id, 0);
    expect(replay.map((e) => e.seq)).toEqual([1, 2]);
    expect(store.events.replay(ses.id, 1)).toHaveLength(1);
    expect(store.events.latestSeq(ses.id)).toBe(2);
  });

  test("jobs + assets", () => {
    const job = store.jobs.insert({ kind: "image.generate", input: { prompt: "x" }, now: "2026-01-01T00:00:00Z" });
    expect(store.jobs.nextQueued()?.id).toBe(job.id);
    store.jobs.update(job.id, { status: "running", now: "2026-01-01T00:00:01Z" });
    expect(store.jobs.nextQueued()).toBeUndefined();

    const asset = store.assets.insert({
      kind: "image",
      mime: "image/png",
      path: "/tmp/x.png",
      bytes: 10,
      jobId: job.id,
      now: "2026-01-01T00:00:02Z",
    });
    expect(store.assets.byJob(job.id)).toHaveLength(1);
    expect(store.assets.get(asset.id)?.kind).toBe("image");
  });

  test("kv get/set/delete", () => {
    expect(store.kv.get("missing")).toBeUndefined();
    store.kv.set("k", { v: 42 });
    expect(store.kv.get("k")).toEqual({ v: 42 });
    store.kv.delete("k");
    expect(store.kv.get("k")).toBeUndefined();
  });

  test("messages.removeFrom deletes the boundary and everything after, parts included", () => {
    const ses = store.sessions.insert({ workbench: "chat", now: "2026-01-01T00:00:00Z" });
    const m1 = store.messages.append(ses.id, "user", "2026-01-01T00:00:01Z");
    store.parts.append(m1.id, 0, "text", { text: "keep" });
    const m2 = store.messages.append(ses.id, "assistant", "2026-01-01T00:00:02Z");
    store.parts.append(m2.id, 0, "text", { text: "drop" });
    const m3 = store.messages.append(ses.id, "user", "2026-01-01T00:00:03Z");
    store.parts.append(m3.id, 0, "text", { text: "drop too" });

    const removed = store.messages.removeFrom(ses.id, m2.id);
    expect(removed).toEqual([m2.id, m3.id]);

    const history = store.messages.history(ses.id);
    expect(history).toHaveLength(1);
    expect(history[0]?.id).toBe(m1.id);
    expect((history[0]?.parts[0]?.payload as { text: string }).text).toBe("keep");
    // Unknown boundary → nothing removed.
    expect(store.messages.removeFrom(ses.id, "msg_nonexistent" as never)).toEqual([]);
    expect(store.messages.history(ses.id)).toHaveLength(1);
  });

  test("messages.copyRange copies before the boundary with fresh ids, preserving content", () => {
    const src = store.sessions.insert({ workbench: "chat", now: "2026-01-01T00:00:00Z" });
    const dst = store.sessions.insert({ workbench: "chat", now: "2026-01-01T00:00:00Z" });
    const m1 = store.messages.append(src.id, "user", "2026-01-01T00:00:01Z");
    store.parts.append(m1.id, 0, "text", { text: "one" });
    store.parts.append(m1.id, 1, "patch", { hash: "tree1", files: ["a.txt"] });
    const m2 = store.messages.append(src.id, "assistant", "2026-01-01T00:00:02Z");
    store.parts.append(m2.id, 0, "text", { text: "two" });
    const m3 = store.messages.append(src.id, "user", "2026-01-01T00:00:03Z");
    store.parts.append(m3.id, 0, "text", { text: "boundary" });

    const idMap = store.messages.copyRange(src.id, dst.id, m3.id);
    expect(idMap.size).toBe(2); // m3 (the boundary) excluded
    expect(idMap.get(m1.id)).toBeDefined();
    expect(idMap.get(m1.id)).not.toBe(m1.id);
    expect(idMap.get(m2.id)).not.toBe(m2.id);

    const copied = store.messages.history(dst.id);
    expect(copied).toHaveLength(2);
    expect(copied[0]?.id).toBe(idMap.get(m1.id));
    expect(copied[0]?.createdAt).toBe("2026-01-01T00:00:01Z");
    expect(copied[0]?.sessionId).toBe(dst.id);
    expect((copied[0]?.parts[0]?.payload as { text: string }).text).toBe("one");
    // Parts (including patch parts) copied with fresh ids, same ord/kind.
    expect(copied[0]?.parts[1]?.kind).toBe("patch");
    expect(copied[0]?.parts[1]?.ord).toBe(1);
    expect(copied[0]?.parts[1]?.id).not.toBe(store.messages.history(src.id)[0]?.parts[1]?.id);

    // No boundary → everything copies (opencode's fork-all semantics).
    const all = store.messages.copyRange(src.id, dst.id);
    expect(all.size).toBe(3);
    expect(store.messages.history(dst.id)).toHaveLength(5);
  });

  test("reopen runs no migrations again and keeps data", () => {
    const ses = store.sessions.insert({ workbench: "chat", now: "2026-01-01T00:00:00Z" });
    store.close();
    const reopened = new Store(join(dir, "test.db"));
    expect(reopened.sessions.get(ses.id)?.id).toBe(ses.id);
    reopened.close();
  });
});
