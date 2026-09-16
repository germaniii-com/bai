import type { MediaGenConfig, MediaGenRequest, MediaModelInfo, MediaParamValue, MediaProviderInfo } from "@bai/shared";
import { normalizeTags } from "@bai/shared";
import type { Workbench } from "../workbench/types";
import type { GeneratedFile, JobExecutor, JobExecutorResult } from "../workbench/types";
import { MediaGenError, type MediaGenAdapter, type MediaGeneratedImage } from "./media/adapter";
import { buildMediaAdapters, mediaProviderDef, mediaProviderInfos } from "./media/registry";
import { imageDimensions, looksLikeImage } from "./media/dimensions";

/** Credentials + stored-asset reads the image executor needs at runtime. */
export interface MediaRuntimeDeps {
  /** Resolve a provider's API key/base URL/headers (the provider registry). */
  resolveCredentials(
    providerId: string,
    accountId?: string,
  ): Promise<{ apiKey?: string; baseUrl?: string; headers?: Record<string, string> }>;
  /** Read a stored reference asset's bytes (image-to-image). */
  readAsset(id: string): { mime: string; bytes: Uint8Array } | undefined;
}

export interface ImageWorkbenchDeps {
  /** config imageGen accessor — provider/model/account fallbacks. */
  defaults?: () => MediaGenConfig | undefined;
  /** Provider credentials + asset reads; absent → stub-only. */
  runtime?: MediaRuntimeDeps;
  /** Fetch override for the OpenRouter adapter (tests). */
  fetch?: typeof globalThis.fetch;
}

/**
 * Image-generation modality. The pipeline (prompt → job → executor → asset +
 * DB row → events → gallery) is unchanged; this class selects a
 * {@link MediaGenAdapter} from config (`imageGen.provider`): `openrouter` for
 * the real Image API, the deterministic stub for anything else (offline/no-key
 * safe). Every produced asset is self-describing — its `meta.gen` carries the
 * request so the gallery can reload it.
 */
export class ImageWorkbench implements Workbench {
  private readonly deps: ImageWorkbenchDeps;
  private readonly adapters: Map<string, MediaGenAdapter>;

  constructor(deps: ImageWorkbenchDeps = {}) {
    this.deps = deps;
    // Adapters are materialized from the media-provider registry, so a new
    // provider is a spec entry + adapter file — not a change here.
    this.adapters = buildMediaAdapters(deps.fetch ?? globalThis.fetch);
  }

  name() {
    return "image" as const;
  }

  label() {
    return "Image";
  }

  tools() {
    return [];
  }

  jobTypes() {
    return ["image.generate" as const];
  }

  assetKinds() {
    return ["image" as const];
  }

  /** The provider picker's rows (label + adapter defaults + models). */
  async providers(): Promise<MediaProviderInfo[]> {
    return mediaProviderInfos(this.adapters);
  }

  /** The adapter for a provider id or alias; unknown providers fall back to the stub. */
  private adapterFor(provider: string): MediaGenAdapter {
    const direct = this.adapters.get(provider);
    if (direct !== undefined) return direct;
    const aliased = mediaProviderDef(provider);
    if (aliased !== undefined) {
      const adapter = this.adapters.get(aliased.id);
      if (adapter !== undefined) return adapter;
    }
    return this.adapters.get("stub")!;
  }

  /** Curated model list (with rates) + param spec for the page's picker. */
  async capabilities(provider?: string, model?: string): Promise<{
    provider: string;
    model: string;
    models: MediaModelInfo[];
    capabilities: ReturnType<MediaGenAdapter["capabilities"]>;
  }> {
    const configured = this.deps.defaults?.();
    const providerId = provider ?? configured?.provider ?? "stub";
    const adapter = this.adapterFor(providerId);
    const modelId = model ?? configured?.model ?? adapter.defaultModel();
    return {
      provider: providerId,
      model: modelId,
      models: await adapter.listModels(),
      capabilities: adapter.capabilities(modelId),
    };
  }

  jobExecutors() {
    const executor: JobExecutor = async (job, ctx) => {
      const request = parseRequest(job.input);
      const configured = this.deps.defaults?.();
      const provider = configured?.provider ?? "stub";
      const adapter = this.adapterFor(provider);
      const model = request.model ?? configured?.model ?? adapter.defaultModel();
      const resolved: MediaGenRequest = { ...request, model };
      // Report dimensions for the queue's media-usage analytics row (best-effort).
      ctx.describe?.({
        provider,
        model,
        ...(configured?.account !== undefined ? { account: configured.account } : {}),
        mode: request.mode,
      });
      const params = resolved.params ?? {};
      ctx.progress(0.05);
      const credentials = this.deps.runtime
        ? await this.deps.runtime.resolveCredentials(provider, configured?.account)
        : {};
      const generated = await adapter.generate({
        request: resolved,
        credentials,
        ctx: {
          signal: ctx.signal,
          readAsset: (id) => this.deps.runtime?.readAsset(id),
        },
      });
      ctx.progress(0.9);
      const costPerImage =
        generated.costUsd !== undefined && generated.images.length > 0
          ? generated.costUsd / generated.images.length
          : undefined;
      const files: GeneratedFile[] = generated.images.map((image) =>
        this.toFile(image, resolved, provider, configured, costPerImage),
      );
      const result: JobExecutorResult = {
        output: {
          model,
          provider,
          count: files.length,
          ...(generated.costUsd !== undefined ? { costUsd: generated.costUsd } : {}),
        },
        files,
      };
      return result;
    };
    return { "image.generate": executor };
  }

  private toFile(
    image: MediaGeneratedImage,
    request: MediaGenRequest,
    provider: string,
    configured: MediaGenConfig | undefined,
    costUsd?: number,
  ): GeneratedFile {
    if (!looksLikeImage(image.bytes, image.mime)) {
      throw new MediaGenError(`Provider returned a non-image payload (${image.mime}).`, { retryable: false });
    }
    const dims = imageDimensions(image.bytes, image.mime);
    const params = request.params ?? {};
    const meta: Record<string, unknown> = {
      // Self-describing: the exact request reloads into the form.
      gen: { ...request, provider, ...(configured?.account !== undefined ? { account: configured.account } : {}) },
      prompt: request.prompt,
      mode: request.mode,
      model: request.model,
      provider,
      ...(configured?.account !== undefined ? { account: configured.account } : {}),
      ...(request.tags !== undefined && request.tags.length > 0 ? { tags: request.tags } : {}),
      ...(typeof params.aspect_ratio === "string" ? { aspectRatio: params.aspect_ratio } : {}),
      ...(typeof params.resolution === "string" ? { resolution: params.resolution } : {}),
      ...(dims !== undefined ? { width: dims.width, height: dims.height } : {}),
      ...(costUsd !== undefined ? { costUsd } : {}),
    };
    return { kind: "image", mime: image.mime, ext: image.ext, bytes: image.bytes, meta };
  }

  routes() {
    return [];
  }
}

/** Tolerant input parser: new `MediaGenRequest` plus legacy top-level fields. */
function parseRequest(input: unknown): MediaGenRequest {
  const obj = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const params: Record<string, MediaParamValue> = {};
  if (typeof obj.params === "object" && obj.params !== null) {
    for (const [key, value] of Object.entries(obj.params as Record<string, unknown>)) {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") params[key] = value;
    }
  }
  if (params.size === undefined && typeof obj.size === "string") params.size = obj.size;
  if (params.count === undefined && typeof obj.count === "number") params.count = obj.count;
  const referenceAssetIds: string[] = [];
  if (Array.isArray(obj.referenceAssetIds)) {
    for (const ref of obj.referenceAssetIds) if (typeof ref === "string" && ref.length > 0) referenceAssetIds.push(ref);
  }
  if (referenceAssetIds.length === 0 && typeof obj.referenceAssetId === "string" && obj.referenceAssetId.length > 0) {
    referenceAssetIds.push(obj.referenceAssetId);
  }
  const tags = normalizeTags(
    Array.isArray(obj.tags) ? obj.tags.filter((t): t is string => typeof t === "string") : undefined,
  );
  return {
    mode: obj.mode === "i2i" ? "i2i" : "t2i",
    prompt: typeof obj.prompt === "string" && obj.prompt.length > 0 ? obj.prompt : "placeholder",
    ...(typeof obj.model === "string" && obj.model.length > 0 ? { model: obj.model } : {}),
    ...(Object.keys(params).length > 0 ? { params } : {}),
    ...(referenceAssetIds.length > 0 ? { referenceAssetIds } : {}),
    ...(tags.length > 0 ? { tags } : {}),
  };
}
