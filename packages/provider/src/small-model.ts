import type { ModelInfo } from "@bai/shared";

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
 *
 * Lives in `@bai/provider` because `ProviderRegistry.smallModelFor` is its
 * primary caller; core's `title.ts` re-exports it for the title generator.
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
