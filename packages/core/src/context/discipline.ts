import type { Message, Part } from "@bai/shared";
import { isToolCallPayload, isToolResultPayload } from "../run/history";

/**
 * Token discipline — deterministic, no-LLM context reclamation (hermes'
 * context_compressor techniques, applied at render time).
 *
 * The durable transcript is never mutated (it is the event-sourced truth);
 * these pure transforms run on the history BEFORE rendering outbound
 * messages, so the provider sees a compacted view while the transcript
 * keeps full data:
 *
 * 1. stubIdenticalResults — the same tool called with the same args
 *    returning the same large result wastes tokens on every replay; the
 *    duplicates collapse to one-line reference stubs (hermes
 *    tool_guardrails.py:527-657).
 * 2. pruneOldToolResults — old tool results shrink to informative one-line
 *    summaries; only the most recent KEEP_RESULTS stay verbatim (hermes
 *    context_compressor.py:4019-4320).
 *
 * Both transforms are deterministic, so the rendered prefix is stable
 * turn-to-turn (cache-friendly): a result only changes rendering once,
 * when it crosses the keep-window boundary.
 */

/** Results at or above this length are stub/prune candidates (chars). */
const STUB_MIN_CHARS = 512;
/** Newest tool results always kept verbatim. */
export const KEEP_RESULTS = 10;

/** chars/4 heuristic — provider usage anchors the totals; this fills the gaps. */
export function estimateTokens(messages: Message[]): number {
  let chars = 0;
  for (const message of messages) {
    for (const part of message.parts) {
      chars += partChars(part);
    }
  }
  return Math.ceil(chars / 4);
}

function partChars(part: Part): number {
  const payload = part.payload as Record<string, unknown> | null;
  if (payload === null || payload === undefined) return 0;
  let n = 0;
  if (typeof payload.text === "string") n += payload.text.length;
  if (typeof payload.content === "string") n += payload.content.length;
  if (typeof payload.args === "string") n += payload.args.length;
  if (typeof payload.name === "string") n += payload.name.length;
  return n;
}

/**
 * Replace repeated identical large tool results with one-line stubs. A
 * streak is keyed on tool name + args + result content; the newest
 * occurrence keeps the full payload (the model most likely needs the
 * latest), older ones collapse.
 */
export function stubIdenticalResults(messages: Message[]): Message[] {
  const seen = new Map<string, { messageId: string; partId: string }>();

  // Walk newest → oldest so the LAST occurrence survives.
  for (let mi = messages.length - 1; mi >= 0; mi--) {
    const message = messages[mi];
    if (message === undefined) continue;
    for (const part of [...message.parts].reverse()) {
      if (part.kind !== "tool_result" || !isToolResultPayload(part.payload)) continue;
      const result = part.payload.content;
      if (result.length < STUB_MIN_CHARS) continue;

      const call = findCall(messages, part.payload.callId);
      const key = `${call?.name ?? "?"}\u0000${call?.args ?? ""}\u0000${result}`;
      const prev = seen.get(key);
      if (prev === undefined) {
        seen.set(key, { messageId: message.id, partId: part.id });
        continue;
      }
      // Older duplicate (we walk backwards) → stub it.
      stubPart(part, call, result);
    }
  }
  return messages;
}

function stubPart(part: Part, call: { name: string; args: string } | undefined, result: string): void {
  const label = call?.name ?? "tool";
  part.payload = {
    ...(part.payload as Record<string, unknown>),
    content: `[${label}] repeated identical result (${result.length} chars, first returned above) — full text elided.`,
  };
}

/** Find the tool_call part that owns a callId (for name/args context). */
function findCall(messages: Message[], callId: string): { name: string; args: string } | undefined {
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.kind === "tool_call" && isToolCallPayload(part.payload) && part.payload.callId === callId) {
        return { name: part.payload.name, args: part.payload.args };
      }
    }
  }
  return undefined;
}

/**
 * Prune old tool results to one-line summaries. The KEEP_RESULTS newest
 * results stay verbatim; older large results collapse (error results stay
 * verbatim — the model needs the exact failure text). Deterministic: the
 * boundary advances one result per new call, so the rendered prefix changes
 * at most one message per turn.
 *
 * NOTE: transforms mutate the in-memory history copy returned by
 * `store.messages.history()` (fresh objects per call) — the durable
 * transcript is untouched.
 */
export function pruneOldToolResults(messages: Message[], opts: { keepResults?: number; minChars?: number } = {}): Message[] {
  const keep = opts.keepResults ?? KEEP_RESULTS;
  const minChars = opts.minChars ?? STUB_MIN_CHARS;

  // Collect result parts newest-first with their owning message.
  const results: Array<{ part: Part; call?: { name: string; args: string } }> = [];
  for (let mi = messages.length - 1; mi >= 0; mi--) {
    const message = messages[mi];
    if (message === undefined) continue;
    for (const part of message.parts) {
      if (part.kind === "tool_result" && isToolResultPayload(part.payload)) {
        results.push({ part, call: findCall(messages, part.payload.callId) });
      }
    }
  }

  for (let index = keep; index < results.length; index++) {
    const r = results[index];
    if (r === undefined) continue;
    const payload = r.part.payload as { content: string; isError?: boolean };
    if (payload.isError === true) continue; // exact failure text matters
    if (payload.content.length < minChars) continue; // small results are cheap
    const argsPreview = summarizeArgs(r.call?.args);
    r.part.payload = {
      ...payload,
      content: `[${r.call?.name ?? "tool"}${argsPreview ? " " + argsPreview : ""}] ran earlier — ${payload.content.length} chars of output elided (result was: ${oneLine(payload.content, 120)})`,
    };
  }

  return messages;
}

function summarizeArgs(args: string | undefined): string {
  if (args === undefined || args.length === 0) return "";
  try {
    const parsed = JSON.parse(args) as Record<string, unknown>;
    const path = parsed.path ?? parsed.pattern ?? parsed.input;
    return typeof path === "string" && path.length > 0 ? path.slice(0, 80) : "";
  } catch {
    return "";
  }
}

function oneLine(text: string, cap: number): string {
  const flat = text.replaceAll(/\s+/g, " ").trim();
  return flat.length > cap ? `${flat.slice(0, cap)}…` : flat;
}

/** Newest user messages whose attachments are re-sent to the provider. */
export const KEEP_ATTACHMENT_TURNS = 3;

/**
 * Bound attachment token cost: only the newest {@link KEEP_ATTACHMENT_TURNS}
 * user messages that carry attachments keep their media — older `attachment`
 * parts are stubbed to `{omitted:true,name}` (renderOutbound emits a one-line
 * note). The durable transcript is untouched (discipline mutates the history
 * copy only), so surfaces still show the original attachment.
 */
export function pruneOldAttachments(messages: Message[], keepUserTurns = KEEP_ATTACHMENT_TURNS): Message[] {
  const withAttachments: Message[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message === undefined || message.role !== "user") continue;
    if (message.parts.some((p) => p.kind === "attachment")) withAttachments.push(message);
  }
  if (withAttachments.length <= keepUserTurns) return messages;
  const drop = new Set(withAttachments.slice(keepUserTurns).map((m) => m.id));
  for (const message of messages) {
    if (!drop.has(message.id)) continue;
    for (const part of message.parts) {
      if (part.kind !== "attachment") continue;
      const payload = part.payload as { name?: unknown; kind?: unknown } | null;
      part.payload = {
        omitted: true,
        name: typeof payload?.name === "string" ? payload.name : "file",
        ...(typeof payload?.kind === "string" ? { kind: payload.kind } : {}),
      };
    }
  }
  return messages;
}

/** Run the full discipline pipeline (order matters: dedup before prune). */
export function applyDiscipline(messages: Message[]): Message[] {
  stubIdenticalResults(messages);
  pruneOldToolResults(messages);
  pruneOldAttachments(messages);
  return messages;
}
