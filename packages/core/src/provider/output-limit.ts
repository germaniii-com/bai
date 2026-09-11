/**
 * Output-token ceiling for a model turn.
 *
 * Both adapters default `max_tokens` to 4096 when the request carries no
 * `params.max_tokens` (openai.ts:219, anthropic.ts:126-131). ~4096 tokens is
 * only ~16 KB of output, so a large `fs.write` is cut off *mid-argument* and
 * the run dies with "the model response was cut off by the token limit before
 * the arguments completed". The run coordinator resolves a real ceiling here
 * and passes it as `params.max_tokens` — the override the adapters already
 * honour.
 *
 * Precedence: explicit config override → the model's catalog output limit →
 * `DEFAULT_MAX_OUTPUT_TOKENS`, always clamped to the vendor cap and never
 * above half the context window (the model needs the other half for its own
 * prompt, tool schemas, and tool results).
 *
 * See docs/TOOL-OUTPUT-BUDGETS.md.
 */

/** Fallback when neither config nor the catalog says anything. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;
/** Floor, so a nonsensical override cannot starve the model. */
export const MIN_MAX_OUTPUT_TOKENS = 256;
/** Fraction of the context window that output may take. */
const CONTEXT_SHARE = 0.5;

export interface OutputLimitInputs {
  /** `config.models.maxOutputTokens` — explicit user override. */
  configValue?: number | undefined;
  /** Catalog `limit.output` for the resolved model (vendor hard cap). */
  modelLimit?: number | undefined;
  /** Catalog `limit.context` for the resolved model. */
  contextWindow?: number | undefined;
}

export function resolveMaxOutputTokens(inputs: OutputLimitInputs = {}): number {
  const config = positive(inputs.configValue);
  const model = positive(inputs.modelLimit);
  const context = positive(inputs.contextWindow);

  // A published output limit is a hard vendor cap: take it as the ceiling (it
  // is also the best default) and never exceed it, whatever the override says.
  const ceiling = model ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const requested = config ?? model ?? DEFAULT_MAX_OUTPUT_TOKENS;
  let value = Math.min(requested, ceiling);

  if (context !== undefined) value = Math.min(value, Math.floor(context * CONTEXT_SHARE));

  return Math.max(MIN_MAX_OUTPUT_TOKENS, Math.floor(value));
}

function positive(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}
