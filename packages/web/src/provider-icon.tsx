import {
  Bot,
  Cloud,
  Compass,
  Cpu,
  Flame,
  Layers,
  Orbit,
  Plug,
  Search,
  Server,
  Sparkles,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { PROVIDER_FALLBACKS, PROVIDER_ICONS } from "./provider-icons";

/**
 * The monochrome brand mark for a model provider, resolved from its id/name
 * (with an adapter fallback). Brand SVGs are compiled to `provider-icons.ts`
 * by `scripts/generate-provider-icons.mjs`; anything unrecognized gets a
 * lucide fallback (so every row always shows *an* icon).
 */
const LUCIDE: Record<string, LucideIcon> = {
  Bot,
  Cloud,
  Compass,
  Cpu,
  Flame,
  Layers,
  Orbit,
  Plug,
  Search,
  Server,
  Sparkles,
  Zap,
};

/** Ordered substring matchers over `id + name` (lowercased) — first hit wins. */
const MATCHERS: Array<[string, string]> = [
  ["openai", "openai"],
  ["codex", "openai"],
  ["anthropic", "anthropic"],
  ["claude", "anthropic"],
  ["gemini", "gemini"],
  ["google", "google"],
  ["vertex", "vertex"],
  ["xai", "xai"],
  ["grok", "xai"],
  ["groq", "groq"],
  ["mistral", "mistral"],
  ["deepseek", "deepseek"],
  ["meta", "meta"],
  ["llama", "meta"],
  ["openrouter", "openrouter"],
  ["ollama", "ollama"],
  ["cohere", "cohere"],
  ["azure", "azure"],
  ["copilot", "copilot"],
  ["github", "github"],
  ["microsoft", "microsoft"],
  ["bedrock", "aws"],
  ["aws", "aws"],
  ["amazon", "aws"],
  ["nvidia", "nvidia"],
  ["moonshot", "moonshot"],
  ["kimi", "moonshot"],
  ["qwen", "qwen"],
  ["dashscope", "qwen"],
  ["alibaba", "alibaba"],
  ["zhipu", "zhipu"],
  ["glm", "zhipu"],
  ["minimax", "minimax"],
  ["baidu", "baidu"],
  ["ernie", "baidu"],
  ["hugging", "huggingface"],
  ["perplexity", "perplexity"],
  ["together", "together"],
  ["fireworks", "fireworks"],
  ["cerebras", "cerebras"],
  ["lmstudio", "lmstudio"],
  ["lm studio", "lmstudio"],
  ["opencode", "opencode"],
  ["upstage", "upstage"],
  ["xiaomi", "xiaomi"],
  ["voyage", "voyage"],
  ["jina", "jina"],
  ["ai21", "ai21"],
  ["reka", "reka"],
  ["nous", "nous"],
  ["cloudflare", "cloudflare"],
  // Image-only vendors (no brand mark compiled — resolved to a fallback).
  ["black forest", "bfl"],
  ["black-forest", "bfl"],
  ["bfl", "bfl"],
  ["flux", "bfl"],
  ["fal", "fal"],
  ["replicate", "replicate"],
  ["stability", "stability"],
  ["stable diffusion", "stability"],
  ["ideogram", "ideogram"],
  ["recraft", "recraft"],
  ["deepinfra", "deepinfra"],
  // Video-only vendors (resolved to a fallback without a brand mark).
  ["runway", "runway"],
  ["kling", "kling"],
  ["kuaishou", "kling"],
  ["luma", "luma"],
  ["lumalabs", "luma"],
  ["minimax", "minimax"],
  ["hailuo", "minimax"],
  ["dashscope", "wan"],
  ["alibaba", "wan"],
  ["seedance", "seedance"],
  ["volcano", "seedance"],
  ["bytedance", "seedance"],
  ["veo", "gemini"],
];

/** Adapter → brand key, when the id/name tells us nothing. */
const ADAPTER_KEY: Record<string, string> = {
  openai: "openai",
  anthropic: "anthropic",
  responses: "openai",
};

/** Resolve a provider to a canonical brand key (always returns something). */
export function resolveProviderKey(id?: string, name?: string, adapter?: string): string {
  const hay = `${id ?? ""} ${name ?? ""}`.toLowerCase();
  for (const [needle, key] of MATCHERS) {
    if (hay.includes(needle)) return key;
  }
  if (adapter !== undefined) {
    const key = ADAPTER_KEY[adapter];
    if (key !== undefined) return key;
  }
  return "generic";
}

export function ProviderIcon({
  id,
  name,
  adapter,
  size = 16,
  className,
}: {
  id?: string;
  name?: string;
  adapter?: string;
  size?: number;
  className?: string;
}) {
  const key = resolveProviderKey(id, name, adapter);
  const brand = PROVIDER_ICONS[key];
  const classes = `provider-icon ${className ?? ""}`.trim();
  if (brand !== undefined) {
    return (
      <svg
        className={classes}
        viewBox={brand.viewBox}
        width={size}
        height={size}
        fill="currentColor"
        aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: brand.body }}
      />
    );
  }
  const Fallback = LUCIDE[PROVIDER_FALLBACKS[key] ?? "Cloud"] ?? Cloud;
  return <Fallback className={classes} size={size} aria-hidden="true" />;
}
