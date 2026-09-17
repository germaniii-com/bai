/**
 * Media-provider credentials/endpoint specs — the single source of truth
 * shared by the curated provider overlay (provider package's `overlay.ts`,
 * which turns them into catalog entries so the registry can find env vars +
 * base URLs) and the media workbench registries (`workbench/media/registry.ts`
 * for images, `workbench/media/video-registry.ts` for video).
 *
 * Lives in `@bai/shared` (neutral leaf) so both the provider package and
 * core's workbenches may import it without a layering cycle; it depends on
 * nothing but plain data.
 *
 * `mediaOnly` providers are advertised by a media workbench only — the
 * registry hides them from the LLM/chat provider pickers (they speak vendor
 * media APIs, not an LLM wire protocol) while still resolving credentials and
 * accounts. `kinds` says which modalities the vendor generates (image and/or
 * video); a shared vendor (fal, Replicate, OpenRouter, Gemini) lists both.
 * `aliases` lets a user type a friendlier id (`google`, `minimax`) and still
 * reach the adapter.
 */
export interface MediaProviderSpec {
  /** Canonical provider id (also the adapter id). */
  id: string;
  /** Human label for the provider picker. */
  label: string;
  /** Vendor default endpoint; credentials.baseUrl overrides it. */
  baseUrl: string;
  /** Env vars that may hold the key (first wins), for auto-detection. */
  env: string[];
  /** Hides the provider from the LLM/chat pickers when true. */
  mediaOnly: boolean;
  /** Modalities this provider can generate. */
  kinds: ("image" | "video")[];
  /** Alternate ids that resolve to this provider. */
  aliases?: string[];
}

export const MEDIA_PROVIDER_SPECS: readonly MediaProviderSpec[] = [
  // --- also chat providers (already in models.dev / the overlay) -----------
  { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", env: ["OPENROUTER_API_KEY"], mediaOnly: false, kinds: ["image", "video"] },
  { id: "openai", label: "OpenAI Images", baseUrl: "https://api.openai.com/v1", env: ["OPENAI_API_KEY"], mediaOnly: false, kinds: ["image"] },
  { id: "xai", label: "xAI Grok Imagine", baseUrl: "https://api.x.ai/v1", env: ["XAI_API_KEY"], mediaOnly: false, kinds: ["image", "video"] },
  { id: "deepinfra", label: "DeepInfra", baseUrl: "https://api.deepinfra.com/v1/openai", env: ["DEEPINFRA_API_KEY", "DEEPINFRA_TOKEN"], mediaOnly: false, kinds: ["image"] },
  { id: "together", label: "Together AI", baseUrl: "https://api.together.ai/v1", env: ["TOGETHER_API_KEY"], mediaOnly: false, kinds: ["image"] },

  // --- image-only vendors (hidden from the chat pickers) -------------------
  { id: "gemini", label: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com", env: ["GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_API_KEY"], mediaOnly: true, kinds: ["image", "video"], aliases: ["google"] },
  { id: "recraft", label: "Recraft", baseUrl: "https://external.api.recraft.ai/v1", env: ["RECRAFT_API_TOKEN", "RECRAFT_API_KEY"], mediaOnly: true, kinds: ["image"] },
  { id: "bfl", label: "Black Forest Labs (FLUX)", baseUrl: "https://api.bfl.ai", env: ["BFL_API_KEY"], mediaOnly: true, kinds: ["image"] },
  { id: "stability", label: "Stability AI", baseUrl: "https://api.stability.ai", env: ["STABILITY_API_KEY"], mediaOnly: true, kinds: ["image"] },
  { id: "ideogram", label: "Ideogram", baseUrl: "https://api.ideogram.ai", env: ["IDEOGRAM_API_KEY"], mediaOnly: true, kinds: ["image"] },
  // The models.dev `minimax` entry is an Anthropic-wire LLM provider, so media
  // adapters use distinct ids and keep `minimax` as an alias.
  { id: "minimax-image", label: "MiniMax Image", baseUrl: "https://api.minimax.io", env: ["MINIMAX_API_KEY"], mediaOnly: true, kinds: ["image"], aliases: ["minimax"] },

  // --- shared image + video vendors ----------------------------------------
  { id: "fal", label: "fal.ai", baseUrl: "https://queue.fal.run", env: ["FAL_KEY", "FAL_API_KEY"], mediaOnly: true, kinds: ["image", "video"] },
  { id: "replicate", label: "Replicate", baseUrl: "https://api.replicate.com/v1", env: ["REPLICATE_API_TOKEN"], mediaOnly: true, kinds: ["image", "video"] },

  // --- video-only vendors --------------------------------------------------
  { id: "runway", label: "Runway", baseUrl: "https://api.dev.runwayml.com", env: ["RUNWAYML_API_SECRET", "RUNWAY_API_KEY"], mediaOnly: true, kinds: ["video"] },
  { id: "kling", label: "Kuaishou Kling", baseUrl: "https://api-singapore.klingai.com", env: ["KLING_API_KEY", "KLING_SECRET_KEY"], mediaOnly: true, kinds: ["video"] },
  { id: "luma", label: "Luma (Agents)", baseUrl: "https://agents.lumalabs.ai", env: ["LUMA_API_KEY", "LUMAAI_API_KEY"], mediaOnly: true, kinds: ["video"], aliases: ["lumalabs", "dream-machine"] },
  { id: "minimax-video", label: "MiniMax Video", baseUrl: "https://api.minimax.io", env: ["MINIMAX_API_KEY"], mediaOnly: true, kinds: ["video"], aliases: ["hailuo"] },
  { id: "wan", label: "Alibaba Wan", baseUrl: "https://dashscope.aliyuncs.com", env: ["DASHSCOPE_API_KEY"], mediaOnly: true, kinds: ["video"], aliases: ["dashscope", "alibaba"] },
  { id: "seedance", label: "ByteDance Seedance", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", env: ["ARK_API_KEY", "VOLCENGINE_API_KEY"], mediaOnly: true, kinds: ["video"], aliases: ["ark", "volcano", "bytedance"] },
];

/** Look up a spec by canonical id or alias. */
export function mediaProviderSpec(id: string): MediaProviderSpec | undefined {
  const direct = MEDIA_PROVIDER_SPECS.find((s) => s.id === id);
  if (direct !== undefined) return direct;
  return MEDIA_PROVIDER_SPECS.find((s) => s.aliases?.includes(id) === true);
}

/** Look up a spec by id/alias that generates the given modality. */
export function mediaProviderSpecForKind(
  id: string,
  kind: "image" | "video",
): MediaProviderSpec | undefined {
  const spec = mediaProviderSpec(id);
  return spec !== undefined && spec.kinds.includes(kind) ? spec : undefined;
}

/** Every spec that generates the given modality. */
export function mediaProviderSpecsForKind(kind: "image" | "video"): MediaProviderSpec[] {
  return MEDIA_PROVIDER_SPECS.filter((s) => s.kinds.includes(kind));
}
