import type { Event, PermissionRequest, QuestionRequest } from "@bai/shared";

/**
 * UI-only state for the inline ask prompt (stage, typing buffers,
 * multi-question progress). Hoisted to App and reset whenever the head
 * ask's id changes, so the prompt can unmount — ctrl-chord dialogs swap
 * the render branch, view switches hide the chat — without losing
 * mid-answer progress. Pure helpers; App applies them via useState.
 */

export interface AskUiState {
  /** Permission prompt: "choose" = the three options; "reject" = feedback input. */
  stage: "choose" | "reject";
  /** Permission reject stage: the optional feedback message being typed. */
  message: string;
  /** Question prompt: one label-array per question, filled in as the user steps. */
  answers: string[][];
  /** Question prompt: current question index. */
  qIndex: number;
  /** Question prompt: highlighted option index (within the current question). */
  highlight: number;
  /** Question prompt: non-null while a custom answer is being typed. */
  custom: string | null;
  /** Question prompt: esc armed for the two-stage dismissal. */
  dismissArmed: boolean;
}

export function emptyAskUi(): AskUiState {
  return {
    stage: "choose",
    message: "",
    answers: [],
    qIndex: 0,
    highlight: 0,
    custom: null,
    dismissArmed: false,
  };
}

/**
 * Fresh UI state sized for the given request — question prompts pre-fill
 * one (empty) answer slot per question. Keyed by request id upstream: the
 * id change IS the reset.
 */
export function askUiFor(request: PermissionRequest | QuestionRequest): AskUiState {
  if ("questions" in request) {
    return { ...emptyAskUi(), answers: request.questions.map(() => []) };
  }
  return emptyAskUi();
}

/**
 * A single typable character for the prompt's text stages (reject reason,
 * custom answer). Ink delivers mouse SGR sequences (`[<64;10;5M` — the ESC
 * prefix is stripped by ink's parser) and other multi-char control noise as
 * `ch`; requiring exactly one printable char drops all of it.
 */
export function typedChar(ch: string | undefined): string {
  if (ch === undefined || ch.length !== 1) return "";
  const code = ch.charCodeAt(0);
  if (code < 0x20 || code === 0x7f) return "";
  return ch;
}

// --- global ask index (sessions-list indicator) -----------------------------

/**
 * Session id → pending-ask count across ALL sessions — the sessions-picker
 * indicator (and any other surface that wants a per-session
 * blocked-run signal). Seeded from GET /api/permission (authoritative) and
 * kept live by firehose ask/reply events; re-seeded on every server.hello
 * (the firehose is live-only, so events missed during drops heal there).
 */
export type AskIndex = Map<string, number>;

/** Seed the index from the pendingAsks endpoint (session-less asks skipped). */
export function askIndexFrom(lists: {
  pendingPermissions: PermissionRequest[];
  pendingQuestions: QuestionRequest[];
}): AskIndex {
  const index: AskIndex = new Map();
  for (const request of [...lists.pendingPermissions, ...lists.pendingQuestions]) {
    if (request.sessionId === undefined) continue;
    index.set(request.sessionId, (index.get(request.sessionId) ?? 0) + 1);
  }
  return index;
}

/**
 * Apply one firehose event to the index. asked → +1, replied/rejected → −1
 * (floored at 0 — a reply for an untracked session is a no-op). Everything
 * else passes through. Pure: returns the same map when nothing changed.
 */
export function applyAskIndexEvent(index: AskIndex, evt: Event): AskIndex {
  const sessionId = evt.sessionId;
  if (sessionId === undefined) return index;
  let delta = 0;
  if (evt.type === "permission.asked" || evt.type === "question.asked") delta = 1;
  else if (evt.type === "permission.replied" || evt.type === "question.replied" || evt.type === "question.rejected") delta = -1;
  else return index;
  const next = (index.get(sessionId) ?? 0) + delta;
  if (next <= 0) {
    if (!index.has(sessionId)) return index; // already empty — no churn
    const copy = new Map(index);
    copy.delete(sessionId);
    return copy;
  }
  const copy = new Map(index);
  copy.set(sessionId, next);
  return copy;
}
