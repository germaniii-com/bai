/**
 * Media-provider credentials/endpoint specs — the single source of truth
 * shared by the curated provider overlay (provider package's `overlay.ts`,
 * which turns them into catalog entries so the registry can find env vars +
 * base URLs) and the image workbench's adapter registry (`workbench/media/
 * registry.ts`).
 *
 * Lives in `@bai/shared` (neutral leaf) so both the provider package and
 * core's workbench may import it without a layering cycle; it depends on
 * nothing but plain data.
 *
 * `imageOnly` providers are advertised by the image workbench only — the
 * registry hides them from the LLM/chat provider pickers (they speak vendor
 * image APIs, not an LLM wire protocol) while still resolving credentials and
 * accounts. `aliases` lets a user type a friendlier id (`google`, `minimax`)
 * and still reach the adapter.
 */
export interface MediaProviderSpec {
  /** Canonical `imageGen.provider` id (also the adapter id). */
  id: string;
  /** Human label for the provider picker. */
  label: string;
  /** Vendor default endpoint; credentials.baseUrl overrides it. */
  baseUrl: string;
  /** Env vars that may hold the key (first wins), for auto-detection. */
  env: string[];
  /** Hides the provider from the LLM/chat pickers when true. */
  imageOnly: boolean;
  /** Alternate ids that resolve to this provider. */
  aliases?: string[];
}

export const MEDIA_PROVIDER_SPECS: readonly MediaProviderSpec[] = [
  // --- also chat providers (already in models.dev / the overlay) -----------
  { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", env: ["OPENROUTER_API_KEY"], imageOnly: false },
  { id: "openai", label: "OpenAI Images", baseUrl: "https://api.openai.com/v1", env: ["OPENAI_API_KEY"], imageOnly: false },
  { id: "xai", label: "xAI Grok Imagine", baseUrl: "https://api.x.ai/v1", env: ["XAI_API_KEY"], imageOnly: false },
  { id: "deepinfra", label: "DeepInfra", baseUrl: "https://api.deepinfra.com/v1/openai", env: ["DEEPINFRA_API_KEY", "DEEPINFRA_TOKEN"], imageOnly: false },
  { id: "together", label: "Together AI", baseUrl: "https://api.together.ai/v1", env: ["TOGETHER_API_KEY"], imageOnly: false },

  // --- image-only vendors (hidden from the chat pickers) -------------------
  { id: "gemini", label: "Google Gemini (Nano Banana)", baseUrl: "https://generativelanguage.googleapis.com", env: ["GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_API_KEY"], imageOnly: true, aliases: ["google"] },
  { id: "recraft", label: "Recraft", baseUrl: "https://external.api.recraft.ai/v1", env: ["RECRAFT_API_TOKEN", "RECRAFT_API_KEY"], imageOnly: true },
  { id: "bfl", label: "Black Forest Labs (FLUX)", baseUrl: "https://api.bfl.ai", env: ["BFL_API_KEY"], imageOnly: true },
  { id: "fal", label: "fal.ai", baseUrl: "https://queue.fal.run", env: ["FAL_KEY", "FAL_API_KEY"], imageOnly: true },
  { id: "replicate", label: "Replicate", baseUrl: "https://api.replicate.com/v1", env: ["REPLICATE_API_TOKEN"], imageOnly: true },
  { id: "stability", label: "Stability AI", baseUrl: "https://api.stability.ai", env: ["STABILITY_API_KEY"], imageOnly: true },
  { id: "ideogram", label: "Ideogram", baseUrl: "https://api.ideogram.ai", env: ["IDEOGRAM_API_KEY"], imageOnly: true },
  // The models.dev `minimax` entry is an Anthropic-wire LLM provider, so the
  // image adapter uses a distinct id and keeps `minimax` as an alias.
  { id: "minimax-image", label: "MiniMax Image", baseUrl: "https://api.minimax.io", env: ["MINIMAX_API_KEY"], imageOnly: true, aliases: ["minimax"] },
];

/** Look up a spec by canonical id or alias. */
export function mediaProviderSpec(id: string): MediaProviderSpec | undefined {
  const direct = MEDIA_PROVIDER_SPECS.find((s) => s.id === id);
  if (direct !== undefined) return direct;
  return MEDIA_PROVIDER_SPECS.find((s) => s.aliases?.includes(id) === true);
}
