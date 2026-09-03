import { describe, expect, test } from "bun:test";
import type { Event, PermissionRequest, Session, SessionId } from "@bai/shared";
import {
  applySubagentEvent,
  cycleSubagentIndex,
  emptySubagentState,
  findChildForTask,
  subagentFocusIndex,
  subagentRows,
  trackSubagents,
  type SubagentState,
} from "../src/state/subagents";
import { applyChildAskEvent } from "../src/state/sync";

const PARENT = "ses_parent" as SessionId;

function childSession(id: string, agent = "researcher"): Session {
  return {
    id: id as SessionId,
    title: `Task (@${agent} subagent)`,
    workbench: "code",
    createdAt: "2026-09-03T00:00:00Z",
    updatedAt: "2026-09-03T00:00:00Z",
    meta: { parent: PARENT, agent },
  };
}

function evt<K extends Event["type"]>(
  type: K,
  sessionId: string | undefined,
  payload: Record<string, unknown>,
): Event {
  return { seq: 1, ts: "2026-09-03T00:00:00Z", ...(sessionId !== undefined ? { sessionId: sessionId as SessionId } : {}), type, payload } as Event;
}

function withChild(state: SubagentState, id: string, agent?: string): SubagentState {
  return applySubagentEvent(state, evt("session.created", undefined, { session: childSession(id, agent) }), PARENT);
}

describe("subagent tracking (tui inspector)", () => {
  test("trackSubagents builds the child set from meta.parent and preserves activity", () => {
    const seeded = withChild(emptySubagentState, "ses_child1", "scout");
    const running = applySubagentEvent(seeded, evt("run.started", "ses_child1", {}), PARENT);

    const rebuilt = trackSubagents(running, [childSession("ses_child1"), childSession("ses_child2", "build"), childSession("ses_other") as Session].map((s, i) => (i === 2 ? { ...s, meta: { parent: "ses_elsewhere" } } : s)), PARENT);
    expect(rebuilt.children.size).toBe(2);
    // Live activity survived the rebuild.
    expect(rebuilt.children.get("ses_child1")?.running).toBe(true);
    expect(rebuilt.children.get("ses_child2")?.agent).toBe("build");
  });

  test("trackSubagents clears when no session is active", () => {
    const seeded = withChild(emptySubagentState, "ses_child1");
    expect(trackSubagents(seeded, [childSession("ses_child1")], undefined).children.size).toBe(0);
  });

  test("session.created adds only children of the active parent, without duplicates", () => {
    const state = applySubagentEvent(emptySubagentState, evt("session.created", undefined, { session: childSession("ses_c1") }), PARENT);
    expect(state.children.size).toBe(1);
    // Not a child of the active parent → ignored.
    const stranger = { ...childSession("ses_x"), meta: { parent: "ses_other" } };
    expect(applySubagentEvent(state, evt("session.created", undefined, { session: stranger }), PARENT).children.size).toBe(1);
    // Duplicate → unchanged.
    expect(applySubagentEvent(state, evt("session.created", undefined, { session: childSession("ses_c1") }), PARENT).children.size).toBe(1);
  });

  test("run lifecycle flips running; events for unknown sessions are ignored", () => {
    const state = withChild(emptySubagentState, "ses_c1");
    const running = applySubagentEvent(state, evt("run.started", "ses_c1", {}), PARENT);
    expect(running.children.get("ses_c1")?.running).toBe(true);
    const done = applySubagentEvent(running, evt("run.finished", "ses_c1", {}), PARENT);
    expect(done.children.get("ses_c1")?.running).toBe(false);
    expect(applySubagentEvent(state, evt("run.started", "ses_unknown", {}), PARENT)).toBe(state);
  });

  test("tool_call and tool_result updates compose the tool status line", () => {
    let state = withChild(emptySubagentState, "ses_c1");
    state = applySubagentEvent(state, evt("run.started", "ses_c1", {}), PARENT);
    state = applySubagentEvent(
      state,
      evt("message.part.updated", "ses_c1", { messageId: "m1", partId: "p1", kind: "tool_call", payload: { callId: "c1", name: "fs.read", args: '{"path":"note.txt"}' } }),
      PARENT,
    );
    expect(state.children.get("ses_c1")?.tool).toContain("fs.read");
    expect(state.children.get("ses_c1")?.tool).toContain("note.txt");
    state = applySubagentEvent(
      state,
      evt("message.part.updated", "ses_c1", { messageId: "m1", partId: "p2", kind: "tool_result", payload: { callId: "c1", content: "ok" } }),
      PARENT,
    );
    expect(state.children.get("ses_c1")?.tool).toBe("✓ fs.read");
  });

  test("text tail streams from deltas of unseen part ids; tool-arg deltas are ignored", () => {
    let state = withChild(emptySubagentState, "ses_c1");
    state = applySubagentEvent(state, evt("run.started", "ses_c1", {}), PARENT);
    // A tool_call part announces itself: its deltas must not touch the tail.
    state = applySubagentEvent(
      state,
      evt("message.part.updated", "ses_c1", { messageId: "m1", partId: "p_tool", kind: "tool_call", payload: { callId: "c1", name: "bash", args: "" } }),
      PARENT,
    );
    state = applySubagentEvent(state, evt("message.part.delta", "ses_c1", { messageId: "m1", partId: "p_tool", delta: '{"command":"rm -rf /"}' }), PARENT);
    expect(state.children.get("ses_c1")?.textTail).toBeUndefined();
    // An unseen part id is text (text parts never announce themselves).
    state = applySubagentEvent(state, evt("message.part.delta", "ses_c1", { messageId: "m1", partId: "p_text", delta: "partial " }), PARENT);
    state = applySubagentEvent(state, evt("message.part.delta", "ses_c1", { messageId: "m1", partId: "p_text", delta: "answer" }), PARENT);
    expect(state.children.get("ses_c1")?.textTail).toBe("partial answer");
    // A new message resets the tail.
    state = applySubagentEvent(state, evt("message.created", "ses_c1", { messageId: "m2", role: "assistant" }), PARENT);
    expect(state.children.get("ses_c1")?.textTail).toBeUndefined();
  });

  test("permission asks surface and clear; asks sort first in the rows", () => {
    let state = withChild(emptySubagentState, "ses_c1");
    state = withChild(state, "ses_c2", "build");
    state = applySubagentEvent(state, evt("permission.asked", "ses_c2", { request: { id: "pr1" } }), PARENT);
    state = applySubagentEvent(state, evt("run.started", "ses_c1", {}), PARENT);
    const rows = subagentRows(state);
    expect(rows[0]?.sessionId).toBe("ses_c2"); // ask pending → first
    expect(rows[0]?.needsApproval).toBe(true);
    expect(rows[1]?.sessionId).toBe("ses_c1");
    state = applySubagentEvent(state, evt("permission.replied", "ses_c2", { requestId: "pr1", status: "approved" }), PARENT);
    expect(state.children.get("ses_c2")?.needsApproval).toBe(false);
  });

  test("subagentFocusIndex: by id → first active → first; -1 when empty", () => {
    let state = withChild(emptySubagentState, "ses_done");
    state = withChild(state, "ses_running", "build");
    state = withChild(state, "ses_asking", "scout");
    state = applySubagentEvent(state, evt("run.started", "ses_done", {}), PARENT);
    state = applySubagentEvent(state, evt("run.finished", "ses_done", {}), PARENT);
    state = applySubagentEvent(state, evt("run.started", "ses_asking", {}), PARENT);
    state = applySubagentEvent(state, evt("permission.asked", "ses_asking", { request: { id: "pr" } }), PARENT);
    const rows = subagentRows(state); // asking first; done tier sorted by id
    expect(rows.map((r) => r.sessionId)).toEqual(["ses_asking", "ses_done", "ses_running"]);
    expect(subagentFocusIndex(rows, "ses_done")).toBe(1); // known id wins
    expect(subagentFocusIndex(rows, "ses_ghost")).toBe(0); // unknown → first active (asking)
    expect(subagentFocusIndex(rows, undefined)).toBe(0);
    // All idle → first row.
    const idle = rows.map((r) => ({ ...r, running: false, needsApproval: false }));
    expect(subagentFocusIndex(idle, undefined)).toBe(0);
    expect(subagentFocusIndex([], "ses_x")).toBe(-1);
  });

  test("cycleSubagentIndex wraps around and clamps", () => {
    expect(cycleSubagentIndex(0, 1, 3)).toBe(1);
    expect(cycleSubagentIndex(2, 1, 3)).toBe(0); // wrap forward
    expect(cycleSubagentIndex(0, -1, 3)).toBe(2); // wrap backward
    expect(cycleSubagentIndex(1, -1, 3)).toBe(0);
    expect(cycleSubagentIndex(0, 1, 1)).toBe(0); // single row
    expect(cycleSubagentIndex(0, 1, 0)).toBe(0); // empty guard
  });

  test("findChildForTask: result link first, then exact title match for running tasks", () => {
    const state = withChild(emptySubagentState, "ses_c1", "plan");
    const child = state.children.get("ses_c1");
    expect(child?.title).toBe("Task (@plan subagent)");
    // Result link wins when present.
    expect(findChildForTask(state.children, '{"description":"Task","subagent_type":"plan"}', "ses_c1")).toBe(child);
    // No result yet → title match resolves the RUNNING task's child.
    expect(findChildForTask(state.children, '{"description":"Task","prompt":"p","subagent_type":"plan"}', undefined)).toBe(child);
    // Different description → no match.
    expect(findChildForTask(state.children, '{"description":"Other","subagent_type":"plan"}', undefined)).toBeUndefined();
    // Partial (streaming) args → no match, no throw.
    expect(findChildForTask(state.children, '{"description":"Ta', undefined)).toBeUndefined();
  });

  test("applyChildAskEvent: tracked-child asks queue; others ignored; replied drops", () => {
    const ask = (id: string): PermissionRequest => ({
      id: id as PermissionRequest["id"],
      tool: "bash",
      argsDigest: "x",
      status: "pending",
      createdAt: "t",
    });
    const isChild = (id: string): boolean => id === "ses_child";
    const tracked = applyChildAskEvent([], evt("permission.asked", "ses_child", { request: ask("pr1") }), isChild);
    expect(tracked.map((r) => r.id as string)).toEqual(["pr1"]);
    // Not a child of the active parent → ignored.
    expect(applyChildAskEvent([], evt("permission.asked", "ses_stranger", { request: ask("pr2") }), isChild)).toEqual([]);
    // Dedup on replay.
    expect(applyChildAskEvent(tracked, evt("permission.asked", "ses_child", { request: ask("pr1") }), isChild)).toHaveLength(1);
    // Replied (from any surface) drops it.
    expect(applyChildAskEvent(tracked, evt("permission.replied", "ses_child", { requestId: "pr1", status: "approved" }), isChild)).toEqual([]);
  });
});
