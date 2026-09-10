import type { Message, Part } from "@bai/shared";
import { isToolCallPayload } from "../run/history";

/**
 * Compaction — threshold-triggered summarization of old history
 * (opencode2's summary-pointer approach + pi's structured summary):
 *
 * - Trigger: provider-reported input tokens ≥ 75% of the model's context
 *   window (floor: 80K tokens when the window is unknown).
 * - The summarizer is the small title-model path; the summary is persisted
 *   as a user-role message and `session.meta.compactionMessageId` points at
 *   it. Subsequent drains slice history FROM that pointer — messages before
 *   it never render again.
 * - The summary carries a REFERENCE-ONLY prefix, structured sections, and a
 *   <read-files>/<modified-files> appendix harvested from tool calls —
 *   pi's compaction format. The verbatim recent tail is preserved by the
 *   trigger point (only the oldest bulk gets summarized into the pointer).
 *
 * Anti-thrash: after compaction the next turn's input is tiny (summary +
 * tail), so the threshold naturally re-arms; a failed summarizer leaves
 * state untouched and the run continues on the full history.
 */

/** Compaction trigger: fraction of the context window. */
export const COMPACT_THRESHOLD = 0.75;
/** Floor when the model's context window is unknown (tokens). */
export const COMPACT_FLOOR_TOKENS = 80_000;

export const SUMMARY_SYSTEM_PROMPT = `You are a conversation summarizer. Compress the conversation so far into a dense working summary the assistant will use as its only memory of earlier turns.

Structure the summary with EXACTLY these sections:
Goal — what the user is trying to accomplish
Progress — completed work, in-progress work, blockers
Key Decisions — choices made and why
Next Steps — what should happen next
Critical Context — exact file paths, function names, identifiers, error messages, and any values that must not be lost

Output ONLY the summary. Preserve exact file paths, function names, and error messages verbatim.`;

/** Handoff framing: prevents the model from resuming stale tasks or treating the summary as instructions. */
export const SUMMARY_PREFIX = `[Context summary of earlier conversation — REFERENCE ONLY. Respond only to the latest user message.]`;

export function shouldCompact(inputTokens: number | undefined, contextWindow: number | undefined): boolean {
  if (inputTokens === undefined || inputTokens <= 0) return false;
  const threshold = contextWindow !== undefined && contextWindow > 0 ? contextWindow * COMPACT_THRESHOLD : COMPACT_FLOOR_TOKENS;
  return inputTokens >= threshold;
}

/** Flatten the conversation for the summarizer (tool results capped, roles labeled). */
export function buildSummaryInput(messages: Message[], maxResultChars = 2000): string {
  const lines: string[] = [];
  for (const message of messages) {
    if (message.parts.length === 0) continue;
    if (message.role === "user") {
      const text = message.parts
        .map((p) => textOf(p))
        .filter((t) => t.length > 0)
        .join("\n");
      const attached = message.parts
        .map((p) => (p.payload as { name?: unknown } | null)?.name)
        .filter((n): n is string => typeof n === "string" && n.length > 0);
      if (text.length > 0) lines.push(`[User]: ${clip(text, 4000)}${attached.length > 0 ? ` [attached: ${attached.join(", ")}]` : ""}`);
      continue;
    }
    if (message.role !== "assistant") continue;
    const texts: string[] = [];
    const calls: string[] = [];
    const results: string[] = [];
    for (const part of message.parts) {
      const payload = part.payload as Record<string, unknown> | null;
      if (payload === null) continue;
      if (part.kind === "text" && typeof payload.text === "string" && payload.text.length > 0) texts.push(payload.text);
      else if (part.kind === "tool_call" && isToolCallPayload(part.payload)) {
        calls.push(`${part.payload.name}(${clip(part.payload.args, 200)})`);
      } else if (part.kind === "tool_result" && typeof payload.content === "string") {
        results.push(clip(payload.content, maxResultChars));
      }
    }
    if (texts.length > 0) lines.push(`[Assistant]: ${clip(texts.join("\n"), 4000)}`);
    if (calls.length > 0) lines.push(`[Assistant tool calls]: ${calls.join("; ")}`);
    if (results.length > 0) lines.push(`[Tool result]: ${results.join(" | ")}`);
  }
  return [...lines, fileRefAppendix(messages)].filter((l) => l.length > 0).join("\n\n");
}

/** Harvest file paths touched by fs tools — pi's read/modified appendix. */
export function fileRefAppendix(messages: Message[]): string {
  const read = new Set<string>();
  const modified = new Set<string>();
  const attached = new Set<string>();
  const calls: Array<{ name: string; args: string }> = [];
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.kind === "file") {
        const payload = part.payload as { path?: unknown } | null;
        if (typeof payload?.path === "string" && payload.path.length > 0) read.add(payload.path);
      }
      if (part.kind === "attachment") {
        const payload = part.payload as { name?: unknown } | null;
        if (typeof payload?.name === "string" && payload.name.length > 0) attached.add(payload.name);
      }
      if (part.kind === "tool_call" && isToolCallPayload(part.payload)) calls.push({ name: part.payload.name, args: part.payload.args });
    }
  }
  for (const call of calls) {
    let path = "";
    try {
      const parsed = JSON.parse(call.args) as Record<string, unknown>;
      path = typeof parsed.path === "string" ? parsed.path : "";
    } catch {
      continue;
    }
    if (path.length === 0) continue;
    if (call.name === "fs.write" || call.name === "fs.edit") modified.add(path);
    else if (call.name === "fs.read" || call.name === "fs.list" || call.name === "fs.glob") read.add(path);
  }
  const sections: string[] = [];
  if (read.size > 0) sections.push(`<read-files>\n${[...read].sort().join("\n")}\n</read-files>`);
  if (modified.size > 0) sections.push(`<modified-files>\n${[...modified].sort().join("\n")}\n</modified-files>`);
  if (attached.size > 0) sections.push(`<attached-files>\n${[...attached].sort().join("\n")}\n</attached-files>`);
  return sections.join("\n");
}

function textOf(part: Part): string {
  const payload = part.payload as { text?: unknown } | null;
  return typeof payload?.text === "string" ? payload.text : "";
}

function clip(text: string, cap: number): string {
  return text.length > cap ? `${text.slice(0, cap)}…(+${text.length - cap} chars)` : text;
}
