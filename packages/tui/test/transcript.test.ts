import { describe, expect, test } from "bun:test";
import type { Message, MessageId, Part, PartId, SessionId } from "@bai/shared";
import { buildTranscriptItems } from "../src/state/sync";

/** Build one part with a stable id. */
function part(ord: number, kind: Part["kind"], payload: unknown): Part {
  return { id: `p${ord}` as PartId, messageId: "m" as MessageId, ord, kind, payload };
}

function msg(i: number, role: Message["role"], parts: Part[]): Message {
  return {
    id: `m${String(i).padStart(2, "0")}` as MessageId,
    sessionId: "ses_1" as SessionId,
    role,
    createdAt: "t",
    parts,
  };
}

describe("buildTranscriptItems (node-level transcript)", () => {
  test("user messages flatten to one item; assistant messages to thought/tools/text", () => {
    const messages = [
      msg(0, "user", [part(0, "text", { text: "do the thing" })]),
      msg(1, "assistant", [
        part(0, "thinking", { text: "reasoning line 1\nline 2" }),
        part(1, "tool_call", { callId: "c1", name: "fs.read", args: '{"path":"a.txt"}' }),
        part(2, "tool_result", { callId: "c1", content: "contents" }),
        part(3, "tool_call", { callId: "c2", name: "task", args: '{"description":"Explore","prompt":"p","subagent_type":"plan"}' }),
        part(4, "tool_result", { callId: "c2", content: "ok", subagent: { sessionId: "ses_child", agent: "plan" } }),
        part(5, "text", { text: "all done" }),
      ]),
    ];
    const items = buildTranscriptItems(messages);
    expect(items.map((i) => i.kind)).toEqual(["user", "thought", "tool", "tool", "text"]);
    const task = items[3];
    expect(task?.kind === "tool" && task.call.name).toBe("task");
    expect(task?.kind === "tool" && task.rawArgs).toContain("Explore");
  });

  test("messages with nothing renderable are skipped", () => {
    const messages = [
      msg(0, "assistant", [part(0, "text", { text: "" })]),
      msg(1, "user", [part(0, "text", { text: "  " })]),
      msg(2, "assistant", [part(0, "text", { text: "visible" })]),
    ];
    const items = buildTranscriptItems(messages);
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe("text");
    expect(items[0]?.messageIndex).toBe(2);
  });

  test("tool items carry the paired view (status/result) in call order", () => {
    const messages = [
      msg(0, "assistant", [
        part(0, "tool_call", { callId: "b", name: "bash", args: '{"command":"ls"}' }),
        part(1, "tool_result", { callId: "b", content: "out", isError: true }),
        part(2, "tool_call", { callId: "a", name: "fs.read", args: '{"path":"x"}' }),
      ]),
    ];
    const items = buildTranscriptItems(messages);
    expect(items.map((i) => (i.kind === "tool" ? i.call.callId : ""))).toEqual(["b", "a"]);
    const first = items[0];
    expect(first?.kind === "tool" && first.call.status).toBe("error");
    expect(first?.kind === "tool" && (first.call.result?.isError ?? false)).toBe(true);
  });
});
