import type { Dispatch, SetStateAction } from "react";
import type {
  AskOutcome,
  Event,
  Input,
  Message,
  Part,
  PermissionRequest,
  QuestionRequest,
  QuestionReview,
  Session,
  SessionId,
} from "@bai/shared";
import { unwrapTaskOutput } from "@bai/shared";

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
    case "message.removed": {
      // Revert cleanup hard-deleted the tail — drop it from the transcript.
      const { messageId } = evt.payload;
      setMessages((prev) => prev.filter((m) => m.id !== messageId));
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

/**
 * The two-phase revert boundary of a session (`meta.revert.messageId`) when
 * one is pending — the transcript hides that message and everything after it
 * (opencode derives visibility from the session marker the same way).
 */
export function revertBoundary(session: Session | null): string | undefined {
  const revert = session?.meta.revert;
  if (revert === null || typeof revert !== "object") return undefined;
  const messageId = (revert as { messageId?: unknown }).messageId;
  return typeof messageId === "string" ? messageId : undefined;
}

/**
 * Pure reducer for the pending-permission queue over session-stream events
 * (mirrors the TUI's helper): asked → append (dedup — replay may redeliver),
 * replied → drop, anything else passes through.
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
 * Pure reducer for the pending-SUBAGENT-ask queue over firehose events
 * (mirrors the TUI's helper): a child session's permission ask pops the
 * same modal a parent ask gets. `isTrackedChild` gates which asks belong
 * to the active session's subagents; asked → append (dedup), replied →
 * drop by id (whichever surface answered).
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

/**
 * Pure reducer for the pending-question queue over session-stream events
 * (mirrors the TUI's helper): asked → append (dedup), replied/rejected →
 * drop, anything else passes through.
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
 * The queued-message list state (message-queue feature): pending inputs in
 * admission order, plus the ids flipped to steer by send-now — those stay
 * in the list (rendered in place with a "sending…" chip) until the
 * `input.promoted` event lands them as real transcript messages, so a
 * send-now never makes the message vanish mid-flight.
 */
export interface QueuedInputsState {
  inputs: Input[];
  sendingIds: string[];
}

export function emptyQueuedInputs(): QueuedInputsState {
  return { inputs: [], sendingIds: [] };
}

/**
 * Pure reducer for the queued-message list over session-stream events
 * (message-queue feature): an admitted QUEUED input appends as a pending
 * node (dedup — replay may redeliver); a send-now flip (`input.updated`
 * with queued: false) marks it sending IN PLACE (no vanish-then-reshow
 * gap); promoted/cancelled drop it. Steer admissions (input.admitted with
 * queued: false) are ignored — they promote within one drain cycle and a
 * flash node on every normal submit would be noise.
 */
export function applyQueuedInputEvent(state: QueuedInputsState, evt: Event): QueuedInputsState {
  if (evt.type === "input.admitted") {
    const { inputId, text, queued } = evt.payload;
    if (!queued) return state;
    if (state.inputs.some((i) => i.id === inputId)) return state;
    return {
      ...state,
      inputs: [
        ...state.inputs,
        {
          id: inputId,
          sessionId: (evt.sessionId ?? "") as SessionId,
          payload: { text, queue: true },
          state: "admitted",
          queued: true,
          createdAt: evt.ts,
        },
      ],
    };
  }
  if (evt.type === "input.updated") {
    const { inputId, queued } = evt.payload;
    if (queued) return state;
    if (!state.inputs.some((i) => i.id === inputId)) return state; // no text to render
    if (state.sendingIds.includes(inputId)) return state;
    return { ...state, sendingIds: [...state.sendingIds, inputId] };
  }
  if (evt.type === "input.promoted" || evt.type === "input.cancelled") {
    const { inputId } = evt.payload;
    return {
      inputs: state.inputs.filter((i) => i.id !== inputId),
      sendingIds: state.sendingIds.filter((id) => id !== inputId),
    };
  }
  return state;
}

/** Seed the queued state from a session snapshot's pending inputs. */
export function queuedInputsFromSnapshot(pending: Input[] | undefined): QueuedInputsState {
  const inputs = pending ?? [];
  return {
    inputs,
    sendingIds: inputs.filter((i) => !i.queued).map((i) => i.id),
  };
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
  /** Raw (possibly still-streaming) args JSON — running task → child matching. */
  rawArgs: string;
  result?: { content: string; isError: boolean };
  /** Answered permission ask retained on the result (transcript review). */
  permission?: AskOutcome;
  /** Retained Q&A (question tool) — rendered as a re-openable review. */
  questions?: QuestionReview[];
  /** For `task` calls: the child session this result came from. */
  subagent?: { sessionId: string; agent: string };
}

/** Pair tool_call parts with their tool_result parts for rendering. */
export function toolCalls(message: Message): ToolCallView[] {
  const results = new Map<
    string,
    {
      content: string;
      isError: boolean;
      subagent?: { sessionId: string; agent: string };
      permission?: AskOutcome;
      questions?: QuestionReview[];
    }
  >();
  for (const p of message.parts) {
    if (p.kind !== "tool_result") continue;
    const payload = p.payload as {
      callId?: string;
      content?: string;
      isError?: boolean;
      subagent?: { sessionId?: unknown; agent?: unknown };
      permission?: AskOutcome;
      questions?: QuestionReview[];
    } | null;
    if (payload?.callId === undefined) continue;
    const subagent =
      payload.subagent !== undefined &&
      typeof payload.subagent === "object" &&
      typeof payload.subagent.sessionId === "string" &&
      typeof payload.subagent.agent === "string"
        ? { sessionId: payload.subagent.sessionId, agent: payload.subagent.agent }
        : undefined;
    // Task results carry a <task> envelope — show the child's actual output.
    const rawContent = payload.content ?? "";
    const content = subagent !== undefined ? (unwrapTaskOutput(rawContent)?.text ?? rawContent) : rawContent;
    const permission =
      payload.permission !== undefined &&
      typeof payload.permission === "object" &&
      typeof (payload.permission as AskOutcome).status === "string"
        ? (payload.permission as AskOutcome)
        : undefined;
    const questions =
      Array.isArray(payload.questions) && payload.questions.length > 0
        ? (payload.questions as QuestionReview[])
        : undefined;
    results.set(payload.callId, {
      content,
      isError: payload.isError === true,
      ...(subagent !== undefined ? { subagent } : {}),
      ...(permission !== undefined ? { permission } : {}),
      ...(questions !== undefined ? { questions } : {}),
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
      rawArgs: payload.args ?? "",
      ...(result !== undefined
        ? {
            result: { content: result.content, isError: result.isError },
            ...(result.subagent !== undefined ? { subagent: result.subagent } : {}),
            ...(result.permission !== undefined ? { permission: result.permission } : {}),
            ...(result.questions !== undefined ? { questions: result.questions } : {}),
          }
        : {}),
    });
  }
  return views;
}

/** One-line args digest: first string-ish field (path/pattern/input). */
export function argsDigest(name: string, args: string): string {
  try {
    const parsed = JSON.parse(args) as Record<string, unknown>;
    // Skills tools: the skill name IS the identity (plus the linked file
    // when one is requested) — "skills.view research" reads as a skill
    // load, not the generic "name" key.
    if (name.startsWith("skills.") && typeof parsed.name === "string") {
      const skill =
        typeof parsed.path === "string" && parsed.path.length > 0
          ? `${parsed.name}/${parsed.path}`
          : parsed.name;
      return skill.length > 60 ? `${skill.slice(0, 60)}…` : skill;
    }
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
