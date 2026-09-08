/**
 * Presentation helpers shared by every surface. Pure functions only — no
 * imports (shared is the dependency leaf).
 */

import type { SessionUsage } from "./usage";

/** What a `task` tool result's `<task>` XML wrapper unwraps to. */
export interface TaskOutputView {
  /** The child session id that produced the output. */
  sessionId: string;
  state: "completed" | "error";
  text: string;
}

/**
 * Unwrap the task tool's `<task id state><task_result|task_error>` envelope
 * (core/src/tools/task.ts renderTaskOutput) into displayable text. Returns
 * undefined for content that isn't a task result — callers fall back to the
 * raw content.
 */
export function unwrapTaskOutput(content: string): TaskOutputView | undefined {
  const match =
    /<task id="([^"]*)" state="(completed|error)">\n<(task_result|task_error)>\n?([\s\S]*?)\n?<\/\3>\n<\/task>/.exec(
      content,
    );
  if (match === null) return undefined;
  const [, sessionId, state, , text] = match;
  return {
    sessionId: sessionId as string,
    state: state as TaskOutputView["state"],
    text: text as string,
  };
}

// --- context tracker (the composer hub's usage readout; pi/opencode parity) ---

/**
 * Compact token count for tight UI rows: `999`, `9.9k`, `123k`, `1.2M`,
 * `12M` (pi's footer format).
 */
export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

/** Visual severity of the context tracker readout. */
export type TrackerTone = "dim" | "warning" | "danger";

export interface ContextTrackerView {
  /** e.g. `45.2k (23%)`, `45.2k` (no window), `?/200k` (post-compaction). */
  label: string;
  tone: TrackerTone;
}

/**
 * The context tracker readout for a session's latest usage. Context tokens
 * are the last turn's `input + output + cacheRead + cacheWrite` — the same
 * sum the compaction trigger consumes; `reasoningTokens` is EXCLUDED (a
 * documented subset of output — adding it would double-count). Returns
 * undefined when there is nothing to show yet (no token fields at all and
 * no window). After compaction core emits a token-less row: `?/200k` (pi's
 * unknown-until-next-turn semantics). Tone: danger >90%, warning >70% of
 * the window, dim otherwise.
 */
export function contextTracker(usage: SessionUsage | null | undefined): ContextTrackerView | undefined {
  if (usage === undefined || usage === null) return undefined;
  const tokens =
    (usage.inputTokens ?? 0) +
    (usage.outputTokens ?? 0) +
    (usage.cacheReadTokens ?? 0) +
    (usage.cacheWriteTokens ?? 0);
  const tokensKnown = usage.inputTokens !== undefined || usage.outputTokens !== undefined;
  const window = usage.contextWindow;
  if (!tokensKnown) {
    // Post-compaction: the next turn re-reports; until then it's unknown.
    // No window either → nothing to show.
    if (window === undefined) return undefined;
    return { label: `?/${formatTokens(window)}`, tone: "dim" };
  }
  const pct = window !== undefined && window > 0 ? Math.round((tokens / window) * 100) : undefined;
  const label = pct !== undefined ? `${formatTokens(tokens)} (${pct}%)` : formatTokens(tokens);
  const tone: TrackerTone = pct !== undefined && pct > 90 ? "danger" : pct !== undefined && pct > 70 ? "warning" : "dim";
  return { label, tone };
}
