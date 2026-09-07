/**
 * Curated Zero-Data-Retention (ZDR) capability overlay.
 *
 * models.dev — the model catalog — publishes NO retention/privacy fields
 * (its schema is strict; verified 2026-09-07 against the models.dev repo
 * schema source). ZDR is fundamentally an org-agreement + feature-usage
 * property, not a model property, which is why the catalog omits it. This
 * module is bai's small, hand-maintained overlay: which providers RUN a
 * formal ZDR program, and which specific models are carved out of it.
 *
 * Honesty stance: this expresses CAPABILITY, not activation — OpenAI,
 * Anthropic, and Google ZDR require an org-level agreement with the vendor;
 * the "Prefer ZDR models" setting only re-orders pickers so capable models
 * surface first. Each entry carries its source and last-verified date so
 * the list stays auditable.
 */

/**
 * Providers that run a formal ZDR program (self-serve or org-approval).
 * models.dev provider ids.
 */
export const ZDR_CAPABLE_PROVIDERS: ReadonlySet<string> = new Set([
  // OpenAI — org/project approval; ZDR-eligible endpoints incl. chat,
  // responses, embeddings, images (developers.openai.com/api/docs/guides/
  // your-data; verified 2026-09-07).
  "openai",
  // Anthropic — org-level ZDR via sales; per-model carve-outs below
  // (platform.claude.com/docs/en/manage-claude/api-and-data-retention;
  // verified 2026-09-07).
  "anthropic",
  // Google — per-project ZDR request for the Gemini API; grounding/file
  // uploads break it (ai.google.dev/gemini-api/docs/zdr; verified 2026-09-07).
  "google",
  // xAI — self-serve ZDR toggle (x-zero-data-retention header; verified
  // 2026-09-07 via zdr.dev registry).
  "xai",
  // Groq — self-serve ZDR toggle (verified 2026-09-07 via zdr.dev registry).
  "groq",
  // Mistral — enterprise ZDR approval (verified 2026-09-07 via zdr.dev).
  "mistral",
  // Cohere — enterprise ZDR approval (verified 2026-09-07 via zdr.dev).
  "cohere",
  // Perplexity — enterprise ZDR program (verified 2026-09-07 via zdr.dev).
  "perplexity",
  // Together — ZDR by default on serverless (verified 2026-09-07 via zdr.dev).
  "together",
  // Fireworks — ZDR by default (volatile memory; `store=true` → 30d)
  // (verified 2026-09-07 via zdr.dev).
  "fireworks",
]);

/**
 * Model-level carve-outs: models a ZDR-capable provider EXCLUDES from its
 * program (they require retention). Keyed by provider id; values match the
 * provider-LOCAL model id (the part after "provider/").
 */
const ZDR_EXCLUDED_MODELS: ReadonlyArray<{ provider: string; pattern: RegExp; reason: string }> = [
  {
    // Anthropic "Covered Models" require 30-day retention and are not
    // available under ZDR unless expressly authorized (api-and-data-retention
    // docs; verified 2026-09-07).
    provider: "anthropic",
    pattern: /fable|mythos/i,
    reason: "Covered Models require 30-day retention",
  },
];

/** True when the model is ZDR-capable per the curated overlay. */
export function isZdrCapable(providerId: string, localModelId: string): boolean {
  if (!ZDR_CAPABLE_PROVIDERS.has(providerId)) return false;
  return !ZDR_EXCLUDED_MODELS.some(
    (exclusion) => exclusion.provider === providerId && exclusion.pattern.test(localModelId),
  );
}

/** True for a full "provider/model" id (the ModelInfo.id shape). */
export function isZdrCapableModel(fullModelId: string, providerId?: string): boolean {
  const slash = fullModelId.indexOf("/");
  const provider = providerId ?? (slash >= 0 ? fullModelId.slice(0, slash) : "");
  const local = slash >= 0 ? fullModelId.slice(slash + 1) : fullModelId;
  return isZdrCapable(provider, local);
}

/** Minimal shape the sorter needs (ModelInfo-compatible). */
interface ZdrSortableModel {
  id: string;
  provider: string;
}

/**
 * Stable sort putting ZDR-capable models first when `preferZdr` is true;
 * the original relative order is preserved within each group (Array.toSorted
 * is stable). `preferZdr` false → the input order unchanged (a copy).
 * Model ids are full "provider/model" ids; the local part is split off for
 * the exclusion check.
 */
export function sortModelsZdrFirst<T extends ZdrSortableModel>(models: readonly T[], preferZdr: boolean): T[] {
  if (!preferZdr) return [...models];
  const rank = (m: T): number => {
    const slash = m.id.indexOf("/");
    const local = slash >= 0 ? m.id.slice(slash + 1) : m.id;
    return isZdrCapable(m.provider, local) ? 0 : 1;
  };
  return models.toSorted((a, b) => rank(a) - rank(b));
}
