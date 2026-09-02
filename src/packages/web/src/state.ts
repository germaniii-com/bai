import type { Dispatch, SetStateAction } from "react";
import type { Event, Message, Part, SessionId } from "@bai/shared";

/** Pure reducer applying session-stream events to the message list (mirrors the TUI's semantics). */
export function applyEvent(setMessages: Dispatch<SetStateAction<Message[]>>, evt: Event): void {
  switch (evt.type) {
    case "message.created": {
      const { messageId, role } = evt.payload;
      setMessages((prev) => [
        ...prev,
        {
          id: messageId,
          sessionId: (evt.sessionId ?? "") as SessionId,
          role,
          createdAt: evt.ts,
          parts: [],
        },
      ]);
      return;
    }
    case "message.part.delta": {
      const { messageId, partId, delta } = evt.payload;
      setMessages((prev) =>
        prev.map((m) => (m.id === messageId ? { ...m, parts: appendDelta(m, partId, delta) } : m)),
      );
      return;
    }
    case "message.part.updated": {
      const { messageId, partId, kind, payload } = evt.payload;
      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId
            ? {
                ...m,
                parts: m.parts.some((p) => p.id === partId)
                  ? m.parts.map((p) => (p.id === partId ? { ...p, kind, payload } : p))
                  : [...m.parts, { id: partId, messageId, ord: m.parts.length, kind, payload }],
              }
            : m,
        ),
      );
      return;
    }
    default:
      return;
  }
}

/**
 * Coalesce adjacent deltas into the part (mirrors the TUI's kind-aware
 * reducer): text/thinking append to `payload.text`, streaming tool calls
 * append to `payload.args` (raw JSON text).
 */
function appendDelta(message: Message, partId: Part["id"], delta: string): Part[] {
  const existing = message.parts.find((p) => p.id === partId);
  if (existing !== undefined) {
    if (existing.kind === "tool_call") {
      const payload = (existing.payload ?? {}) as Record<string, unknown>;
      return message.parts.map((p) =>
        p.id === partId ? { ...p, payload: { ...payload, args: ((payload.args as string | undefined) ?? "") + delta } } : p,
      );
    }
    const current = (existing.payload as { text?: string } | null)?.text ?? "";
    return message.parts.map((p) =>
      p.id === partId ? { ...p, payload: { text: current + delta } } : p,
    );
  }
  return [
    ...message.parts,
    {
      id: partId,
      messageId: message.id,
      ord: message.parts.length,
      kind: "text",
      payload: { text: delta },
    },
  ];
}

export function messageText(message: Message): string {
  return message.parts
    .map((p) => (p.kind === "text" ? ((p.payload as { text?: string } | null)?.text ?? "") : ""))
    .join("");
}

/** Flatten a message's reasoning (thinking) parts — shown behind the reveal panel. */
export function thinkingText(message: Message): string {
  return message.parts
    .filter((p) => p.kind === "thinking")
    .map((p) => (p.payload as { text?: string } | null)?.text ?? "")
    .join("");
}

export interface ToolCallView {
  callId: string;
  name: string;
  argsPreview: string;
  status: "running" | "done" | "error";
  result?: { content: string; isError: boolean };
}

/** Pair tool_call parts with their tool_result parts for rendering. */
export function toolCalls(message: Message): ToolCallView[] {
  const results = new Map<string, { content: string; isError: boolean }>();
  for (const p of message.parts) {
    if (p.kind !== "tool_result") continue;
    const payload = p.payload as { callId?: string; content?: string; isError?: boolean } | null;
    if (payload?.callId === undefined) continue;
    results.set(payload.callId, { content: payload.content ?? "", isError: payload.isError === true });
  }
  const views: ToolCallView[] = [];
  for (const p of message.parts) {
    if (p.kind !== "tool_call") continue;
    const payload = p.payload as { callId?: string; name?: string; args?: string } | null;
    if (payload?.callId === undefined || payload.name === undefined) continue;
    const result = results.get(payload.callId);
    views.push({
      callId: payload.callId,
      name: payload.name,
      argsPreview: argsDigest(payload.name, payload.args ?? ""),
      status: result === undefined ? "running" : result.isError ? "error" : "done",
      ...(result !== undefined ? { result } : {}),
    });
  }
  return views;
}

/** One-line args digest: first string-ish field (path/pattern/input). */
function argsDigest(name: string, args: string): string {
  try {
    const parsed = JSON.parse(args) as Record<string, unknown>;
    const interesting = parsed.path ?? parsed.pattern ?? parsed.input ?? parsed.command;
    if (typeof interesting === "string" && interesting.length > 0) {
      return interesting.length > 60 ? `${interesting.slice(0, 60)}…` : interesting;
    }
    return Object.keys(parsed).slice(0, 3).join(", ");
  } catch {
    const flat = args.replaceAll(/\s+/g, " ").trim();
    return flat.length > 60 ? `${flat.slice(0, 60)}…` : flat;
  }
}
