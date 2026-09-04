import type { Dispatch, SetStateAction } from "react";
import type { AskOutcome, Event, Message, Part, PermissionRequest, QuestionRequest, QuestionReview, SessionId } from "@bai/shared";

/** Pure reducer applying session-stream events to the message list. */
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
        prev.map((m) =>
          m.id === messageId ? { ...m, parts: appendDelta(m, partId, delta) } : m,
        ),
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
                  : [
                      ...m.parts,
                      { id: partId, messageId, ord: m.parts.length, kind, payload },
                    ],
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
 * Coalesce adjacent deltas into the part (the render-tick buffer). Kind
 * aware: text/thinking parts append to `payload.text`; streaming tool calls
 * append to `payload.args` (the args are raw JSON text).
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

/** Flatten a message's text parts for display. */
export function messageText(message: Message): string {
  return message.parts
    .map((p) => (p.kind === "text" ? ((p.payload as { text?: string } | null)?.text ?? "") : ""))
    .join("");
}

/**
 * Pure reducer for the pending-permission queue over session-stream events:
 * asked → append (dedup — reconnect replay may redeliver), replied → drop.
 * Everything else passes through unchanged.
 */
export function applyPermissionEvent(list: PermissionRequest[], evt: Event): PermissionRequest[] {
  if (evt.type === "permission.asked") {
    const request = (evt.payload as { request: PermissionRequest }).request;
    return list.some((r) => r.id === request.id) ? list : [...list, request];
  }
  if (evt.type === "permission.replied") {
    const requestId = (evt.payload as { requestId: PermissionRequest["id"] }).requestId;
    return list.filter((r) => r.id !== requestId);
  }
  return list;
}

/**
 * Pure reducer for the pending-question queue over session-stream events:
 * asked → append (dedup — replay may redeliver), replied/rejected → drop.
 */
export function applyQuestionEvent(list: QuestionRequest[], evt: Event): QuestionRequest[] {
  if (evt.type === "question.asked") {
    const request = (evt.payload as { request: QuestionRequest }).request;
    return list.some((r) => r.id === request.id) ? list : [...list, request];
  }
  if (evt.type === "question.replied" || evt.type === "question.rejected") {
    const requestId = (evt.payload as { requestId: QuestionRequest["id"] }).requestId;
    return list.filter((r) => r.id !== requestId);
  }
  return list;
}

/**
 * Pure reducer for the pending-SUBAGENT-ask queue over firehose events:
 * a child session's permission ask pops the same modal a parent ask gets
 * (the firehose carries every session's events; `isTrackedChild` gates
 * which asks belong to the active session's subagents). asked → append
 * (dedup), replied → drop by id (whichever surface answered).
 */
export function applyChildAskEvent(
  list: PermissionRequest[],
  evt: Event,
  isTrackedChild: (sessionId: string) => boolean,
): PermissionRequest[] {
  if (evt.type === "permission.asked") {
    const request = (evt.payload as { request: PermissionRequest }).request;
    const sessionId = evt.sessionId;
    if (sessionId === undefined || !isTrackedChild(sessionId)) return list;
    return list.some((r) => r.id === request.id) ? list : [...list, request];
  }
  if (evt.type === "permission.replied") {
    const requestId = (evt.payload as { requestId: PermissionRequest["id"] }).requestId;
    return list.filter((r) => r.id !== requestId);
  }
  return list;
}

/** Flatten a message's reasoning (thinking) parts — shown behind the reveal panel. */
export function thinkingText(message: Message): string {
  return message.parts
    .filter((p) => p.kind === "thinking")
    .map((p) => (p.payload as { text?: string } | null)?.text ?? "")
    .join("");
}

// --- transcript items: one focusable/clickable node per renderable piece ---

/**
 * One focusable transcript node. Every assistant message flattens into up
 * to three node kinds — its thought, each tool call, and its text — so
 * ctrl+j/k highlights and clicks target NODES, not whole messages
 * (thought and task highlight independently; every tool call is its own
 * expandable node).
 */
export type TranscriptItem =
  | { kind: "user"; messageIndex: number; messageId: string }
  | { kind: "thought"; messageIndex: number; messageId: string }
  | { kind: "tool"; messageIndex: number; messageId: string; call: ToolCallView; rawArgs: string }
  | { kind: "text"; messageIndex: number; messageId: string };

/**
 * Flatten messages into focusable transcript items, in render order:
 * user message → one item; assistant message → thought (when present),
 * one item per tool call, then the text (when non-empty). Messages with
 * nothing renderable are skipped.
 */
export function buildTranscriptItems(messages: Message[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const m = messages[messageIndex];
    if (m === undefined) continue;
    if (m.role === "user") {
      if (messageText(m).trim().length > 0) {
        items.push({ kind: "user", messageIndex, messageId: m.id });
      }
      continue;
    }
    if (thinkingText(m).length > 0) {
      items.push({ kind: "thought", messageIndex, messageId: m.id });
    }
    for (const call of toolCalls(m)) {
      const callPart = m.parts.find((p) => p.kind === "tool_call" && (p.payload as { callId?: string } | null)?.callId === call.callId);
      const rawArgs = (callPart?.payload as { args?: string } | null)?.args ?? "";
      items.push({ kind: "tool", messageIndex, messageId: m.id, call, rawArgs });
    }
    if (messageText(m).trim().length > 0) {
      items.push({ kind: "text", messageIndex, messageId: m.id });
    }
  }
  return items;
}

export interface ToolCallView {
  callId: string;
  name: string;
  /** Compact args digest for the collapsed line (e.g. a path). */
  argsPreview: string;
  status: "running" | "done" | "error";
  /** Present once the result part landed. */
  result?: { content: string; isError: boolean };
  /** Answered permission ask retained on the result (transcript review). */
  permission?: AskOutcome;
  /** Retained Q&A (question tool) — rendered as a re-openable review. */
  questions?: QuestionReview[];
}

/** Pair tool_call parts with their tool_result parts for rendering. */
export function toolCalls(message: Message): ToolCallView[] {
  const results = new Map<string, { content: string; isError: boolean; permission?: AskOutcome; questions?: QuestionReview[] }>();
  for (const p of message.parts) {
    if (p.kind !== "tool_result") continue;
    const payload = p.payload as {
      callId?: string;
      content?: string;
      isError?: boolean;
      permission?: AskOutcome;
      questions?: QuestionReview[];
    } | null;
    if (payload?.callId === undefined) continue;
    results.set(payload.callId, {
      content: payload.content ?? "",
      isError: payload.isError === true,
      ...(payload.permission !== undefined &&
      typeof payload.permission === "object" &&
      typeof (payload.permission as AskOutcome).status === "string"
        ? { permission: payload.permission as AskOutcome }
        : {}),
      ...(Array.isArray(payload.questions) && payload.questions.length > 0 ? { questions: payload.questions as QuestionReview[] } : {}),
    });
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
      ...(result?.permission !== undefined ? { permission: result.permission } : {}),
      ...(result?.questions !== undefined ? { questions: result.questions } : {}),
    });
  }
  return views;
}

/** One-line args digest: first string-ish field (path/pattern/input). */
export function argsDigest(name: string, args: string): string {
  try {
    const parsed = JSON.parse(args) as Record<string, unknown>;
    // task: the description + which agent runs (opencode's task card).
    if (name === "task") {
      const description = typeof parsed.description === "string" ? parsed.description : "";
      const agent = typeof parsed.subagent_type === "string" ? parsed.subagent_type : "?";
      const digest = `${description} (@${agent})`.trim();
      return digest.length > 60 ? `${digest.slice(0, 60)}…` : digest;
    }
    const interesting = parsed.path ?? parsed.pattern ?? parsed.input ?? parsed.command;
    if (typeof interesting === "string" && interesting.length > 0) {
      return interesting.length > 60 ? `${interesting.slice(0, 60)}…` : interesting;
    }
    return Object.keys(parsed).slice(0, 3).join(", ");
  } catch {
    // Args may still be streaming (partial JSON) — show what we have.
    const flat = args.replaceAll(/\s+/g, " ").trim();
    return flat.length > 60 ? `${flat.slice(0, 60)}…` : flat;
  }
}
