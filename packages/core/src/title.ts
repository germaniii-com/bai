/**
 * Session title generation: sessions are created as "New Chat Session -
 * <timestamp>" (opencode parity); the first prompt of a default-titled
 * session kicks off a mini LLM call (a small non-thinking model — see
 * pickSmallModel) that replaces the default with a generated title. If the
 * call fails — or the user beats it to a rename — the default stands. Both
 * updates ride `session.updated` events, so every surface picks them up live.
 */

import type { ModelInfo } from "@bai/shared";

/** Prefix of the creation-time default title (isDefaultTitle keys on it). */
export const DEFAULT_TITLE_PREFIX = "New Chat Session - ";

/** The creation-time default: prefix + RFC3339 UTC timestamp. */
export function defaultTitle(now: string): string {
  return DEFAULT_TITLE_PREFIX + now;
}

/**
 * True while a session still carries its creation-time default title — the
 * gate for the AI refine (a user rename always wins and is never replaced).
 */
export function isDefaultTitle(title: string): boolean {
  return new RegExp(
    `^${DEFAULT_TITLE_PREFIX}\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$`,
  ).test(title);
}

/** The refine request's system prompt (condensed from opencode's title.txt). */
export const TITLE_SYSTEM_PROMPT = `You are a title generator. You output ONLY a thread title. Nothing else.

Generate a brief, descriptive title that would help the user find this conversation later.
Your output must be a single line of 5 to 10 words - no explanations, no quotes.

Rules:
- Use the same language as the user message you are summarizing.
- Capture BOTH the main topic and the user's goal or intent. A long prompt
  must become a 5-10 word title, never a single word.
- The title must read naturally - no word salad.
- Drop filler articles (the, a, an) only where the title stays natural.
- Never include tool names (e.g. "read tool", "bash tool").
- Keep exact: technical terms, numbers, filenames, HTTP codes.
- Never assume a tech stack.
- NEVER respond to questions - just generate the title.
- Never say you cannot generate a title; always output something meaningful,
  even for minimal input (e.g. "hello" -> "Friendly greeting and getting acquainted").

Examples:
"debug 500 errors in production" -> Debugging 500 errors in production
"why is app.js failing" -> Investigating why app.js is failing
"@src/auth.ts can you add refresh token support" -> Adding refresh token support to auth.ts
"how do I connect postgres to my API" -> Connecting a Postgres database to the API
"refactor user service" -> Refactoring the user service code
"hello" -> Friendly greeting and getting acquainted`;

/** Cap for the refined title (opencode parity: 97 + "..."). */
const REFINED_MAX = 100;

/**
 * Small-model name patterns, in priority order (opencode's family-priority
 * heuristic adapted to models.dev ids/labels): the first non-reasoning model
 * matching any pattern wins.
 */
const SMALL_MODEL_PATTERNS = [
  /mini/i,
  /nano/i,
  /small/i,
  /haiku/i,
  /flash/i,
  /lite/i,
  /instant/i,
  /turbo/i,
] as const;

/**
 * Pick a small model for background calls (session titling) — opencode's
 * getSmallModel adapted to bai's catalog. Tiered so reasoning-only providers
 * (e.g. every opencode-go model is reasoning-flagged) still yield a cheap
 * "flash"-tier model instead of falling back to an expensive session model:
 *   1. non-thinking model with a small-model name (mini/nano/haiku/flash…)
 *   2. cheapest non-thinking model with published pricing
 *   3. cheapest small-pattern model (reasoning allowed)
 *   4. cheapest model overall
 * Undefined when nothing qualifies (the caller falls back to the session's
 * own model).
 */
export function pickSmallModel(models: ModelInfo[]): string | undefined {
  const cheapest = (list: ModelInfo[]): ModelInfo | undefined =>
    list.length > 0
      ? list.reduce((a, b) => ((b.outputCost ?? Infinity) < (a.outputCost ?? Infinity) ? b : a))
      : undefined;
  const matches = (m: ModelInfo, pattern: RegExp): boolean =>
    pattern.test(m.id) || pattern.test(m.label);

  const plain = models.filter((m) => m.reasoning !== true);
  for (const pattern of SMALL_MODEL_PATTERNS) {
    const match = plain.find((m) => matches(m, pattern));
    if (match !== undefined) return match.id;
  }
  const cheapestPlain = cheapest(plain.filter((m) => m.outputCost !== undefined));
  if (cheapestPlain !== undefined) return cheapestPlain.id;

  const patternMatches = SMALL_MODEL_PATTERNS.flatMap((pattern) =>
    models.filter((m) => matches(m, pattern)),
  );
  const cheapestMatch = cheapest(patternMatches.filter((m) => m.outputCost !== undefined));
  if (cheapestMatch !== undefined) return cheapestMatch.id;
  const cheapestAny = cheapest(models.filter((m) => m.outputCost !== undefined));
  if (cheapestAny !== undefined) return cheapestAny.id;
  return undefined;
}

/**
 * Clean a model's title output: reasoning models may emit <think> blocks or
 * preamble; take the first usable line, collapse whitespace, cap length.
 * Empty string means "nothing usable — keep the default title".
 */
export function sanitizeGeneratedTitle(text: string): string {
  const stripped = text.replace(/<think>[\s\S]*?<\/think>\s*/g, "");
  const line = stripped.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  const unquoted = line.replace(/^["'`]+|["'`]+$/g, "").trim();
  const collapsed = unquoted.replace(/\s+/g, " ");
  if (collapsed.length === 0) return "";
  return collapsed.length > REFINED_MAX ? `${collapsed.slice(0, REFINED_MAX - 3)}...` : collapsed;
}
