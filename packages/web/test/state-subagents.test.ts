import { describe, expect, test } from "bun:test";
import type { Event, Session, SessionId } from "@bai/shared";
import {
  applySubagentEvent,
  emptySubagentState,
  findChildForTask,
  subagentRows,
  trackSubagents,
  type SubagentState,
} from "../src/state-subagents";

/**
 * The web port of the TUI's subagent tracking reducers (state-subagents.ts)
 * — the firehose-driven live status behind the chat pane's task nodes and
 * the inline subagent transcripts. Pure reducers, no DOM.
 */

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

describe("subagent tracking (web task nodes)", () => {
  test("trackSubagents builds the child set from meta.parent and preserves activity", () => {
    const seeded = withChild(emptySubagentState, "ses_child1", "scout");
    const running = applySubagentEvent(seeded, evt("run.started", "ses_child1", {}), PARENT);

    const rebuilt = trackSubagents(
      running,
      [childSession("ses_child1"), childSession("ses_child2", "build"), childSession("ses_other") as Session].map((s, i) =>
        i === 2 ? { ...s, meta: { parent: "ses_elsewhere" } } : s,
      ),
      PARENT,
    );
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
});
