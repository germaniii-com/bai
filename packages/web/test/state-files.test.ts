import { describe, expect, test } from "bun:test";
import type { Event, SessionId } from "@bai/shared";
import { applyFileWatch, emptyFileWatch, type FileWatchState } from "../src/state-files";

/**
 * The live file-change detection reducer (state-files.ts) — the firehose
 * signal behind the workspace file viewer's change dots, preview refresh,
 * and file-tree refresh. Pure, no DOM.
 */

const ROOT = "/ws/demo";
const SESSION = "ses_ws" as SessionId;

const ctx = {
  root: ROOT,
  sessionCwd: (id: string) => (id === SESSION ? ROOT : undefined),
};

function evt<K extends Event["type"]>(
  type: K,
  sessionId: string | undefined,
  payload: Record<string, unknown>,
): Event {
  return {
    seq: 1,
    ts: "2026-09-07T00:00:00Z",
    ...(sessionId !== undefined ? { sessionId: sessionId as SessionId } : {}),
    type,
    payload,
  } as Event;
}

/** Drive one fs.write/fs.edit call through announce → arg deltas → result. */
function runToolCall(
  state: FileWatchState,
  opts: { callId: string; name: string; args: string; isError?: boolean; fragments?: string[] },
): string[] {
  const partId = `part_${opts.callId}`;
  let changed = applyFileWatch(
    state,
    evt("message.part.updated", SESSION, { messageId: "m1", partId, kind: "tool_call", payload: { callId: opts.callId, name: opts.name, args: "" } }),
    ctx,
  );
  const fragments = opts.fragments ?? [opts.args];
  for (const fragment of fragments) {
    changed = applyFileWatch(state, evt("message.part.delta", SESSION, { messageId: "m1", partId, delta: fragment }), ctx);
  }
  changed = applyFileWatch(
    state,
    evt("message.part.updated", SESSION, { messageId: "m1", partId: `res_${opts.callId}`, kind: "tool_result", payload: { callId: opts.callId, content: "ok", ...(opts.isError ? { isError: true } : {}) } }),
    ctx,
  );
  return changed;
}

describe("file-change detection (workspace viewer)", () => {
  test("patch part: relative paths resolve against the session cwd, inside-root only", () => {
    const changed = applyFileWatch(
      emptyFileWatch,
      evt("message.part.updated", SESSION, { messageId: "m1", partId: "p1", kind: "patch", payload: { hash: "h", files: ["src/a.ts", "b.md", "../outside.txt", "/abs/other.txt"] } }),
      ctx,
    );
    expect(changed).toEqual([`${ROOT}/src/a.ts`, `${ROOT}/b.md`]);
  });

  test("patch part: absolute paths inside the root pass through normalized", () => {
    const changed = applyFileWatch(
      emptyFileWatch,
      evt("message.part.updated", SESSION, { messageId: "m1", partId: "p1", kind: "patch", payload: { hash: "h", files: ["/ws/demo/nested/new file.txt"] } }),
      ctx,
    );
    expect(changed).toEqual([`${ROOT}/nested/new file.txt`]);
  });

  test("fs.write tool result: path extracted from streamed (fragmented) args", () => {
    const changed = runToolCall(emptyFileWatch, {
      callId: "c1",
      name: "fs.write",
      args: '{"path":"notes/idea.md","content":"hello"}',
      fragments: ['{"path":"notes/id', 'ea.md","content":', '"hello"}'],
    });
    expect(changed).toEqual([`${ROOT}/notes/idea.md`]);
  });

  test("fs.edit tool result detected; error results and other tools ignored", () => {
    const edited = runToolCall(emptyFileWatch, { callId: "c1", name: "fs.edit", args: '{"path":"a.ts","oldString":"x","newString":"y"}' });
    expect(edited).toEqual([`${ROOT}/a.ts`]);

    const failed = runToolCall(emptyFileWatch, { callId: "c2", name: "fs.write", args: '{"path":"a.ts","content":"z"}', isError: true });
    expect(failed).toEqual([]);

    const read = runToolCall(emptyFileWatch, { callId: "c3", name: "fs.read", args: '{"path":"a.ts"}' });
    expect(read).toEqual([]);
  });

  test("relative paths resolve against the OWNING session's cwd (subagent inheritance)", () => {
    const child = "ses_child" as SessionId;
    const childCtx = {
      root: ROOT,
      sessionCwd: (id: string) => (id === child ? ROOT : undefined),
    };
    const changed = applyFileWatch(
      emptyFileWatch,
      evt("message.part.updated", child, { messageId: "m1", partId: "p1", kind: "patch", payload: { hash: "h", files: ["kid.txt"] } }),
      childCtx,
    );
    expect(changed).toEqual([`${ROOT}/kid.txt`]);
  });

  test("changes outside the viewed workspace are filtered", () => {
    const other = "ses_other" as SessionId;
    const changed = applyFileWatch(
      emptyFileWatch,
      evt("message.part.updated", other, { messageId: "m1", partId: "p1", kind: "patch", payload: { hash: "h", files: ["x.txt"] } }),
      { root: ROOT, sessionCwd: (id) => (id === other ? "/ws/other" : undefined) },
    );
    expect(changed).toEqual([]);
  });

  test("unknown session cwd falls back to the viewed root", () => {
    const changed = applyFileWatch(
      emptyFileWatch,
      evt("message.part.updated", "ses_unknown" as SessionId, { messageId: "m1", partId: "p1", kind: "patch", payload: { hash: "h", files: ["f.txt"] } }),
      { root: ROOT, sessionCwd: () => undefined },
    );
    expect(changed).toEqual([`${ROOT}/f.txt`]);
  });

  test("null root (no workspace selected) reports nothing", () => {
    const changed = applyFileWatch(
      emptyFileWatch,
      evt("message.part.updated", SESSION, { messageId: "m1", partId: "p1", kind: "patch", payload: { hash: "h", files: ["f.txt"] } }),
      { root: null, sessionCwd: () => ROOT },
    );
    expect(changed).toEqual([]);
  });

  test("run.finished clears the session's tracked calls (aborted runs don't leak)", () => {
    const state = emptyFileWatch;
    applyFileWatch(state, evt("message.part.updated", SESSION, { messageId: "m1", partId: "p1", kind: "tool_call", payload: { callId: "c1", name: "fs.write", args: "" } }), ctx);
    expect(state.calls.size).toBe(1);
    applyFileWatch(state, evt("run.finished", SESSION, {}), ctx);
    expect(state.calls.size).toBe(0);
    expect(state.parts.size).toBe(0);
  });

  test("args deltas for unknown parts and non-string payloads are ignored", () => {
    const state = emptyFileWatch;
    expect(applyFileWatch(state, evt("message.part.delta", SESSION, { messageId: "m1", partId: "ghost", delta: "{}" }), ctx)).toEqual([]);
    expect(
      applyFileWatch(state, evt("message.part.updated", SESSION, { messageId: "m1", partId: "p1", kind: "text", payload: { text: "hi" } }), ctx),
    ).toEqual([]);
  });
});
