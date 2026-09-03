import { describe, expect, test } from "bun:test";
import { makeCore, waitForEvent, type TestCore } from "./harness";

/**
 * The permission gate's abort wiring: an interrupted run must never park on
 * an unanswered ask (the esc/ctrl+c stall the task tool's child sessions
 * made reachable mid-drain — QuestionService already had this; the gate
 * needed it too).
 */
describe("permission gate abort", () => {
  let t: TestCore;

  test("authorize resolves cancelled on abort; row flips to rejected; surfaces notified", async () => {
    t = makeCore();
    const session = t.core.createSession({ workbench: "code" });
    const ctrl = new AbortController();
    // Subscribe FIRST: the ask event publishes synchronously inside the
    // authorize() call (no await before the emit).
    const askArrived = waitForEvent(t.bus, "permission.asked", { timeoutMs: 3000 });
    const pending = t.core.permissions.authorize({ tool: "bash", sessionId: session.id, signal: ctrl.signal });

    const askEvt = await askArrived;
    expect(askEvt.payload.request.status).toBe("pending");
    expect(t.store.permissions.pendingBySession(session.id)).toHaveLength(1);

    // The replied event also publishes synchronously inside abort().
    const repliedArrived = waitForEvent(t.bus, "permission.replied", { timeoutMs: 3000 });
    ctrl.abort();
    expect(await pending).toEqual({ allowed: false, cancelled: true });
    expect(t.store.permissions.pendingBySession(session.id)).toHaveLength(0);
    expect(t.store.permissions.get(askEvt.payload.request.id)?.status).toBe("rejected");
    const replied = await repliedArrived;
    expect(replied.payload.requestId).toBe(askEvt.payload.request.id);
    expect(replied.payload.status).toBe("rejected");
    t.store.close();
  });

  test("a pre-aborted signal resolves immediately without a dangling ask", async () => {
    t = makeCore();
    const session = t.core.createSession({ workbench: "code" });
    const ctrl = new AbortController();
    ctrl.abort();
    const result = await t.core.permissions.authorize({ tool: "bash", sessionId: session.id, signal: ctrl.signal });
    expect(result).toEqual({ allowed: false, cancelled: true });
    expect(t.store.permissions.pendingBySession(session.id)).toHaveLength(0);
    t.store.close();
  });

  test("a real reply wins when it lands before the abort; a late abort is a no-op", async () => {
    t = makeCore();
    const session = t.core.createSession({ workbench: "code" });
    const ctrl = new AbortController();
    const askArrived = waitForEvent(t.bus, "permission.asked", { timeoutMs: 3000 });
    const pending = t.core.permissions.authorize({ tool: "bash", sessionId: session.id, signal: ctrl.signal });
    const askEvt = await askArrived;

    t.core.replyPermission(askEvt.payload.request.id, "approved", "once");
    expect(await pending).toEqual({ allowed: true });

    ctrl.abort(); // late abort after the verdict consumed the entry: no double-settle
    expect(t.store.permissions.get(askEvt.payload.request.id)?.status).toBe("approved");
    t.store.close();
  });
});

describe("pendingAll / pendingAsks (global ask index seed)", () => {
  test("returns every pending ask across sessions; answered rows drop out", async () => {
    const t = makeCore();
    const a = t.core.createSession({ workbench: "code" });
    const b = t.core.createSession({ workbench: "code" });

    // Subscribe FIRST: ask events publish synchronously inside authorize().
    const sub = t.bus.subscribe();
    // Two asks in session a, one in b — the authorize promises park until
    // replied (that's the point; we only need the rows).
    const parked = [
      t.core.permissions.authorize({ tool: "bash", sessionId: a.id }),
      t.core.permissions.authorize({ tool: "bash", sessionId: a.id }),
      t.core.permissions.authorize({ tool: "bash", sessionId: b.id }),
    ];
    const asked = sub
      .take()
      .filter((e) => e.type === "permission.asked")
      .map((e) => (e.payload as { request: { id: string } }).request.id);
    expect(asked).toHaveLength(3);
    expect(t.core.pendingAsks().pendingPermissions).toHaveLength(3);

    // A parked question block counts too (memory-only, same index).
    const questionParking = t.core.questions.ask({
      sessionId: a.id,
      questions: [{ question: "Proceed?", header: "go", options: [{ label: "Yes", description: "y" }] }],
    });
    expect(t.core.pendingAsks().pendingQuestions).toHaveLength(1);

    // Answer one of a's permission asks: the index drops to 2 and keeps
    // both sessions.
    t.core.replyPermission(asked[0]!, "approved", "once");
    const remaining = t.core.pendingAsks().pendingPermissions;
    expect(remaining).toHaveLength(2);
    expect(remaining.map((r) => r.sessionId)).toContain(a.id);
    expect(remaining.map((r) => r.sessionId)).toContain(b.id);

    // Settle everything: deny the rest, answer the question.
    t.core.replyPermission(asked[1]!, "rejected", "once");
    t.core.replyPermission(asked[2]!, "rejected", "once");
    t.core.questions.reply((t.core.pendingAsks().pendingQuestions[0] as { id: string }).id, [["Yes"]]);
    await Promise.allSettled([...parked, questionParking]);
    expect(t.core.pendingAsks().pendingPermissions).toHaveLength(0);
    expect(t.core.pendingAsks().pendingQuestions).toHaveLength(0);
    t.store.close();
  });
});
