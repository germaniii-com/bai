import type { Dispatch, SetStateAction } from "react";
import type { AskOutcome, Event, Input, Message, Part, PermissionRequest, QuestionRequest, QuestionReview, Session, SessionId } from "@bai/shared";

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

/**
 * Coalesce per-token `message.part.delta` frames into one state update.
 * Streaming produces dozens of deltas per second; applying each via its own
 * `setMessages(prev => prev.map(...))` is O(N) per token + a full-tree
 * re-render per token. Buffer for `flushMs` and flush once: N tokens →
 * one array copy + one render.
 *
 * Non-delta events bypass the buffer — callers must `flush()` first so a
 * `message.part.updated` (full payload) never lands before buffered deltas
 * for the same part.
 */
export interface BufferedDelta {
  messageId: string;
  partId: string;
  delta: string;
}

export function createDeltaBuffer(opts: {
  flushMs?: number;
  onFlush: (deltas: BufferedDelta[]) => void;
} = { onFlush: () => {} }): {
  push: (messageId: string, partId: string, delta: string) => void;
  flush: () => void;
  dispose: () => void;
  pending: () => number;
} {
  const flushMs = opts.flushMs ?? 75;
  const onFlush = opts.onFlush;
  const pending = new Map<string, BufferedDelta>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending.size === 0) return;
    const batch = [...pending.values()];
    pending.clear();
    onFlush(batch);
  };
  return {
    push: (messageId, partId, delta) => {
      const key = `${messageId}:${partId}`;
      const existing = pending.get(key);
      if (existing !== undefined) existing.delta += delta;
      else pending.set(key, { messageId, partId, delta });
      if (timer === null) timer = setTimeout(flush, flushMs);
    },
    flush,
    dispose: () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      pending.clear();
    },
    pending: () => pending.size,
  };
}

/**
 * Apply a whole batch of coalesced deltas in a SINGLE message-array pass.
 * One `prev.map` for the batch (not one per token), and one parts-array
 * rebuild per touched message. Unmentioned messages keep their reference —
 * memoized rows below skip them.
 */
export function applyDeltaBatch(
  setMessages: Dispatch<SetStateAction<Message[]>>,
  deltas: BufferedDelta[],
): void {
  if (deltas.length === 0) return;
  const byMessage = new Map<string, Map<string, string>>();
  for (const d of deltas) {
    let parts = byMessage.get(d.messageId);
    if (parts === undefined) {
      parts = new Map();
      byMessage.set(d.messageId, parts);
    }
    parts.set(d.partId, (parts.get(d.partId) ?? "") + d.delta);
  }
  setMessages((prev) =>
    prev.map((m) => {
      const parts = byMessage.get(m.id as string);
      if (parts === undefined) return m;
      let changed = false;
      const nextParts = m.parts.map((p) => {
        const delta = parts.get(p.id as string);
        if (delta === undefined) return p;
        changed = true;
        if (p.kind === "tool_call") {
          const payload = (p.payload ?? {}) as Record<string, unknown>;
          return { ...p, payload: { ...payload, args: ((payload.args as string | undefined) ?? "") + delta } };
        }
        const current = (p.payload as { text?: string } | null)?.text ?? "";
        return { ...p, payload: { text: current + delta } };
      });
      // Part not yet created (first delta for a new part) → append per part.
      // appendDelta handles the missing-part case; run it once per new part.
      let extra = nextParts;
      for (const [partId] of parts) {
        if (!m.parts.some((p) => (p.id as string) === partId)) {
          extra = appendDelta({ ...m, parts: extra }, partId as Part["id"], parts.get(partId) ?? "");
          changed = true;
        }
      }
      return changed ? { ...m, parts: extra } : m;
    }),
  );
}

/** Flatten a message's text parts for display. */
export function messageText(message: Message): string {
  return message.parts
    .map((p) => (p.kind === "text" ? ((p.payload as { text?: string } | null)?.text ?? "") : ""))
    .join("");
}

/**
 * Compact markers for a message's image attachments — the TUI has no image
 * rendering, so each `attachment` part becomes `[image: name]`
 * (`[omitted: name]` once context discipline has dropped its bytes).
 */
export function attachmentMarkers(message: Message): string[] {
  return message.parts
    .filter((p) => p.kind === "attachment")
    .map((p) => {
      const payload = p.payload as { name?: unknown; kind?: unknown; omitted?: unknown } | null;
      const name = typeof payload?.name === "string" ? payload.name : "file";
      const kind = typeof payload?.kind === "string" ? payload.kind : "file";
      return `[${payload?.omitted === true ? "omitted" : kind}: ${name}]`;
    });
}

/**
 * The pending two-phase revert boundary of a session (`meta.revert.messageId`)
 * when one exists — the transcript hides that message and everything after it
 * until restore or the next prompt commits the deletion.
 */
export function revertBoundary(session: Session | null): string | undefined {
  const revert = session?.meta.revert;
  if (revert === null || typeof revert !== "object") return undefined;
  const messageId = (revert as { messageId?: unknown }).messageId;
  return typeof messageId === "string" ? messageId : undefined;
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
 * (message-queue feature, mirrors the web's helper): an admitted QUEUED
 * input appends as a pending node (dedup — replay may redeliver); a
 * send-now flip (`input.updated` with queued: false) marks it sending IN
 * PLACE (no vanish-then-reshow gap); promoted/cancelled drop it. Steer
 * admissions (input.admitted with queued: false) are ignored — they
 * promote within one drain cycle and a flash node on every normal submit
 * would be noise.
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

/**
 * Collapsed tool-output preview (opencode parity: 3 lines generic, 10 lines
 * expanded preview). Collapsed nodes mount ZERO output rows; expanded nodes
 * mount at most `maxLines` preview rows — a 10k-line `bash` result no longer
 * becomes 10k `<Text>` nodes + 10k Yoga measures. Full content stays in the
 * DB (second expand stage renders a bounded full view).
 */
export const TOOL_PREVIEW_LINES = 3;
export const TOOL_EXPANDED_LINES = 10;
export const TOOL_EXPANDED_CHARS = 2000;
export const TOOL_FULL_LINES = 500;
export const TOOL_FULL_CHARS = 50_000;

export interface ToolPreview {
  preview: string;
  totalLines: number;
  truncated: boolean;
  omittedLines: number;
  omittedChars: number;
}

export function collapseToolOutput(output: string, maxLines: number, maxChars: number): ToolPreview {
  const lines = output.split("\n");
  const totalLines = lines.length;
  const previewLines = lines.slice(0, maxLines).join("\n");
  if (lines.length <= maxLines && Array.from(output).length <= maxChars) {
    return { preview: output, totalLines, truncated: false, omittedLines: 0, omittedChars: 0 };
  }
  let preview = previewLines;
  // Enforce the char budget on top of the line budget (codepoints, not UTF-16).
  if (Array.from(preview).length > maxChars) {
    preview = Array.from(preview).slice(0, maxChars).join("");
  }
  const omittedLines = Math.max(0, totalLines - preview.split("\n").length);
  const omittedChars = Math.max(0, Array.from(output).length - Array.from(preview).length);
  return { preview, totalLines, truncated: true, omittedLines, omittedChars };
}

const argsDigestCache = new Map<string, string>();

/** One-line args digest: first string-ish field (path/pattern/input). Cached
 *  by name+args — stable older calls skip JSON.parse per render; streaming
 *  partial args naturally miss until they settle. Bounded (cleared past 1k). */
export function argsDigest(name: string, args: string): string {
  const cacheKey = `${name}:${args}`;
  const hit = argsDigestCache.get(cacheKey);
  if (hit !== undefined) return hit;
  const digest = argsDigestUncached(name, args);
  argsDigestCache.set(cacheKey, digest);
  if (argsDigestCache.size > 1000) argsDigestCache.clear();
  return digest;
}

function argsDigestUncached(name: string, args: string): string {
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
