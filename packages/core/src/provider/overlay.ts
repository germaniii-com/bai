import type { AdapterName } from "@bai/shared";
import { MEDIA_PROVIDER_SPECS } from "../media-providers";

/**
 * bai-owned curated provider overlay.
 *
 * models.dev remains the source of truth for the bulk of the catalog. This
 * overlay closes the gaps that matter to bai and cannot be expressed by
 * models.dev alone:
 *
 *  - providers with a dedicated OAuth / token-import login (ChatGPT/Codex,
 *    xAI, Nous, Copilot, Qwen, MiniMax, Vertex) — the login machinery lives
 *    in `core/src/provider/oauth/`;
 *  - providers models.dev omits or models incompletely (coding plans,
 *    gateways, regional endpoints);
 *  - wire/adapter quirks (an endpoint that speaks the Responses API, an
 *    Anthropic-Messages-compatible gateway, extra request headers).
 *
 * Merge semantics: an overlay entry WINS over the catalog for
 * `name`/`baseUrl`/`adapter`/`authType`/`headers`/`env`, and its `models`
 * (if any) are added to the catalog's list. It never removes catalog models.
 */
export interface CuratedProvider {
  id: string;
  name: string;
  aliases?: string[];
  /** Base URL override (wins over models.dev `api` and WELL_KNOWN_BASE_URLS). */
  baseUrl?: string;
  /** Wire adapter override. */
  adapter?: AdapterName;
  /** Primary auth shape; OAuth-capable providers are also listed in OAUTH_SPECS. */
  authType?: "api_key" | "device_code" | "paste_code" | "import" | "adc";
  /** Env vars holding the key (first wins). */
  env?: string[];
  /** Default request headers applied to every call for this provider. */
  headers?: Record<string, string>;
  /** Model ids to ensure are present (added to the catalog list). */
  models?: string[];
  /** Context window for `models` entries (used only when the catalog lacks them). */
  contextLength?: number;
  /** True when the provider works with no credential (free tier). */
  keyless?: boolean;
  /**
   * True for a media-only vendor (image generation): credentials and base URL
   * resolve, accounts are manageable, but the provider is hidden from the
   * LLM/chat pickers because it speaks no chat wire protocol.
   */
  mediaOnly?: boolean;
}

const CODEX_MODELS = [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4-mini",
  "gpt-5.4",
  "gpt-5.3-codex",
  "gpt-5.3-codex-spark",
];

const XAI_MODELS = ["grok-4", "grok-4-mini", "grok-3", "grok-code-fast-1"];

function p(entry: CuratedProvider): CuratedProvider {
  return entry;
}

/**
 * Vendor image-endpoint entries generated from {@link MEDIA_PROVIDER_SPECS}.
 * `openai`/`xai`/`deepinfra`/`openrouter` already have catalog entries, so
 * only the missing vendors (and the media-only ones) are added here — their
 * env vars and base URLs then resolve through `ProviderRegistry`.
 */
const MEDIA_OVERLAY_IDS = new Set([
  "together",
  "gemini",
  "recraft",
  "bfl",
  "fal",
  "replicate",
  "stability",
  "ideogram",
  "minimax-image",
]);

const MEDIA_OVERLAY_LIST: CuratedProvider[] = MEDIA_PROVIDER_SPECS.filter((s) =>
  MEDIA_OVERLAY_IDS.has(s.id),
).map((s) => ({
  id: s.id,
  name: s.label,
  ...(s.aliases !== undefined ? { aliases: s.aliases } : {}),
  baseUrl: s.baseUrl,
  env: s.env,
  ...(s.imageOnly ? { mediaOnly: true } : {}),
}));

const CURATED_LIST: CuratedProvider[] = [
    // --- OAuth / subscription logins -------------------------------------
    p({
      id: "openai-codex",
      name: "ChatGPT (Codex)",
      aliases: ["codex", "chatgpt", "openai_codex"],
      baseUrl: "https://chatgpt.com/backend-api/codex",
      adapter: "responses",
      authType: "device_code",
      models: CODEX_MODELS,
      contextLength: 272_000,
    }),
    p({
      id: "xai",
      name: "xAI (Grok)",
      aliases: ["grok", "x-ai", "x.ai"],
      baseUrl: "https://api.x.ai/v1",
      adapter: "responses",
      env: ["XAI_API_KEY"],
      models: XAI_MODELS,
    }),
    p({
      id: "nous",
      name: "Nous Portal",
      aliases: ["nous-portal", "nousresearch", "nous-research"],
      baseUrl: "https://inference-api.nousresearch.com/v1",
      adapter: "openai-compatible",
      authType: "device_code",
    }),
    p({
      id: "copilot",
      name: "GitHub Copilot",
      aliases: ["github-copilot", "github-models", "github"],
      baseUrl: "https://api.githubcopilot.com",
      adapter: "openai-compatible",
      authType: "device_code",
      env: ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"],
      headers: {
        "Editor-Version": "vscode/1.104.1",
        "Copilot-Integration-Id": "vscode-chat",
      },
    }),
    p({
      id: "qwen-oauth",
      name: "Qwen (OAuth)",
      aliases: ["qwen", "qwen-portal", "qwen-cli"],
      baseUrl: "https://portal.qwen.ai/v1",
      adapter: "openai-compatible",
      authType: "import",
    }),
    p({
      id: "minimax-oauth",
      name: "MiniMax (OAuth)",
      aliases: ["minimax_oauth"],
      baseUrl: "https://api.minimax.io/anthropic",
      adapter: "anthropic",
      authType: "device_code",
      models: ["MiniMax-M2.5", "MiniMax-M2.1", "MiniMax-Text-01"],
    }),
    p({
      id: "vertex",
      name: "Google Vertex AI",
      aliases: ["google-vertex", "vertex-ai", "gcp-vertex"],
      baseUrl: "https://aiplatform.googleapis.com",
      adapter: "openai-compatible",
      authType: "adc",
    }),

    // --- models.dev gaps / coding plans ----------------------------------
    p({
      id: "opencode-zen",
      name: "OpenCode Zen",
      aliases: ["opencode", "opencode_zen", "zen"],
      baseUrl: "https://opencode.ai/zen/v1",
      adapter: "openai-compatible",
      env: ["OPENCODE_ZEN_API_KEY"],
    }),
    p({
      id: "opencode-go",
      name: "OpenCode Go",
      aliases: ["opencode_go", "go", "opencode-go-sub"],
      baseUrl: "https://opencode.ai/zen/go/v1",
      adapter: "openai-compatible",
      env: ["OPENCODE_GO_API_KEY"],
    }),
    p({
      id: "opencode-free",
      name: "OpenCode Free",
      aliases: ["free", "opencode_free"],
      baseUrl: "https://opencode.ai/zen/v1",
      adapter: "openai-compatible",
      keyless: true,
    }),
    p({
      id: "kimi-coding",
      name: "Kimi for Coding",
      aliases: ["kimi", "moonshot", "kimi-for-coding"],
      baseUrl: "https://api.moonshot.ai/v1",
      adapter: "openai-compatible",
      env: ["KIMI_API_KEY", "KIMI_CODING_API_KEY"],
    }),
    p({
      id: "kimi-coding-cn",
      name: "Kimi for Coding (China)",
      aliases: ["kimi-cn", "moonshot-cn"],
      baseUrl: "https://api.moonshot.cn/v1",
      adapter: "openai-compatible",
      env: ["KIMI_CN_API_KEY"],
    }),
    p({
      id: "zai",
      name: "Z.ai (GLM)",
      aliases: ["glm", "z-ai", "z.ai", "zhipu"],
      baseUrl: "https://api.z.ai/api/paas/v4",
      adapter: "openai-compatible",
      env: ["GLM_API_KEY", "ZAI_API_KEY", "Z_AI_API_KEY"],
    }),
    p({
      id: "meta-ai",
      name: "Meta AI / Muse",
      aliases: ["meta", "muse", "muse-spark", "model-api", "msl"],
      baseUrl: "https://api.meta.ai/v1",
      adapter: "responses",
      env: ["MODEL_API_KEY", "META_API_KEY", "META_MODEL_API_KEY"],
    }),
    p({
      id: "commandcode",
      name: "CommandCode",
      aliases: ["commandcode-chat"],
      baseUrl: "https://api.commandcode.ai/provider/v1",
      adapter: "openai-compatible",
      env: ["COMMANDCODE_API_KEY"],
    }),
    p({
      id: "commandcode-anthropic",
      name: "CommandCode (Anthropic)",
      aliases: ["commandcode-claude"],
      baseUrl: "https://api.commandcode.ai/provider/v1",
      adapter: "anthropic",
      env: ["COMMANDCODE_ANTHROPIC_API_KEY"],
    }),
    p({
      id: "actual",
      name: "Actual Computer",
      aliases: ["actual-computer", "actualcomputer", "aci"],
      baseUrl: "https://api.actual.inc/v1",
      adapter: "responses",
      env: ["ACTUAL_API_KEY"],
    }),
    p({
      id: "alibaba",
      name: "Alibaba DashScope",
      aliases: ["dashscope", "alibaba-cloud", "qwen-dashscope"],
      baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      adapter: "openai-compatible",
      env: ["DASHSCOPE_API_KEY"],
    }),
    p({
      id: "alibaba-cn",
      name: "Alibaba DashScope (China)",
      aliases: ["dashscope-cn"],
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      adapter: "openai-compatible",
      env: ["DASHSCOPE_API_KEY"],
    }),
    p({
      id: "alibaba-coding-plan",
      name: "Alibaba Coding Plan",
      aliases: ["alibaba_coding", "alibaba-coding", "dashscope-coding"],
      baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
      adapter: "openai-compatible",
      env: ["ALIBABA_CODING_PLAN_API_KEY", "DASHSCOPE_API_KEY"],
    }),
    p({
      id: "stepfun",
      name: "StepFun",
      aliases: ["step", "stepfun-coding-plan"],
      baseUrl: "https://api.stepfun.ai/step_plan/v1",
      adapter: "openai-compatible",
      env: ["STEPFUN_API_KEY"],
    }),
    p({
      id: "upstage",
      name: "Upstage Solar",
      aliases: ["solar"],
      baseUrl: "https://api.upstage.ai/v1",
      adapter: "openai-compatible",
      env: ["UPSTAGE_API_KEY"],
    }),
    p({
      id: "xiaomi",
      name: "Xiaomi MiMo",
      aliases: ["mimo", "xiaomi-mimo"],
      baseUrl: "https://api.xiaomimimo.com/v1",
      adapter: "openai-compatible",
      env: ["XIAOMI_API_KEY"],
    }),
    p({
      id: "arcee",
      name: "Arcee AI",
      aliases: ["arcee-ai", "arceeai"],
      baseUrl: "https://api.arcee.ai/api/v1",
      adapter: "openai-compatible",
      env: ["ARCEEAI_API_KEY"],
    }),
    p({
      id: "gmi",
      name: "GMI Cloud",
      aliases: ["gmi-cloud", "gmicloud"],
      baseUrl: "https://api.gmi-serving.com/v1",
      adapter: "openai-compatible",
      env: ["GMI_API_KEY"],
    }),
    p({
      id: "kilocode",
      name: "Kilo Code",
      aliases: ["kilo-code", "kilo", "kilo-gateway"],
      baseUrl: "https://api.kilo.ai/api/gateway",
      adapter: "openai-compatible",
      env: ["KILOCODE_API_KEY"],
    }),
    p({
      id: "router",
      name: "Ramp Router",
      aliases: ["ramp-router", "ramp", "router.com"],
      baseUrl: "https://api.router.com/v1",
      adapter: "responses",
      env: ["RAMP_ROUTER_API_KEY", "ROUTER_API_KEY"],
    }),
    p({
      id: "deepinfra",
      name: "DeepInfra",
      aliases: ["deep-infra", "deepinfra-ai"],
      baseUrl: "https://api.deepinfra.com/v1/openai",
      adapter: "openai-compatible",
      env: ["DEEPINFRA_API_KEY"],
    }),
    p({
      id: "nebius-token-factory",
      name: "Nebius Token Factory",
      aliases: ["nebius", "nebius-tokenfactory", "nebius-tf", "token-factory"],
      baseUrl: "https://api.tokenfactory.nebius.com/v1",
      adapter: "openai-compatible",
      env: ["NEBIUS_API_KEY", "NEBIUS_TOKEN_FACTORY_API_KEY"],
    }),
    p({
      id: "nvidia",
      name: "NVIDIA NIM",
      aliases: ["nvidia-nim"],
      baseUrl: "https://integrate.api.nvidia.com/v1",
      adapter: "openai-compatible",
      env: ["NVIDIA_API_KEY"],
    }),
    p({
      id: "huggingface",
      name: "Hugging Face",
      aliases: ["hf", "hugging-face", "huggingface-hub"],
      baseUrl: "https://router.huggingface.co/v1",
      adapter: "openai-compatible",
      env: ["HF_TOKEN"],
    }),
    p({
      id: "ollama-cloud",
      name: "Ollama Cloud",
      aliases: ["ollama_cloud"],
      baseUrl: "https://ollama.com/v1",
      adapter: "openai-compatible",
      env: ["OLLAMA_API_KEY"],
    }),
    p({
      id: "novita",
      name: "NovitaAI",
      aliases: ["novita-ai", "novitaai"],
      baseUrl: "https://api.novita.ai/openai/v1",
      adapter: "openai-compatible",
      env: ["NOVITA_API_KEY"],
    }),
    p({
      id: "fireworks",
      name: "Fireworks AI",
      aliases: ["fireworks-ai", "fw"],
      baseUrl: "https://api.fireworks.ai/inference/v1",
      adapter: "openai-compatible",
      env: ["FIREWORKS_API_KEY"],
    }),
    p({
      id: "ai-gateway",
      name: "Vercel AI Gateway",
      aliases: ["vercel", "vercel-ai-gateway", "ai_gateway", "aigateway"],
      baseUrl: "https://ai-gateway.vercel.sh/v1",
      adapter: "openai-compatible",
      env: ["AI_GATEWAY_API_KEY"],
    }),
    ...MEDIA_OVERLAY_LIST,
  ];

/** Every curated provider, keyed by id (explicit tuple typing for fromEntries). */
export const CURATED_PROVIDERS: Record<string, CuratedProvider> = Object.fromEntries(
  CURATED_LIST.map((entry): [string, CuratedProvider] => [entry.id, entry]),
);

/** Look up a curated entry by id. */
export function curatedProvider(id: string): CuratedProvider | undefined {
  return CURATED_PROVIDERS[id];
}
