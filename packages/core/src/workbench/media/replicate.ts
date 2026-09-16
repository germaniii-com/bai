import type {
  MediaCapabilities,
  MediaGenRequest,
  MediaModelInfo,
  MediaParamSpec,
} from "@bai/shared";
import {
  MediaGenError,
  type MediaGenAdapter,
  type MediaGenContext,
  type MediaGenerateResult,
  type MediaGeneratedImage,
} from "./adapter";
import { bytesToBlob, fetchImageBytes, getJson, postForm, postJson, pollUntil, toDataUrl } from "./http";

export const REPLICATE_API_URL = "https://api.replicate.com/v1";

/** Replicate only inlines data URLs up to 256 KB; larger files must be uploaded. */
const DATA_URL_LIMIT = 256 * 1024;

/**
 * Replicate — `POST /v1/predictions` with `{ model, input }` and
 * `Prefer: wait` (pseudo-synchronous up to 60s), falling back to polling
 * `GET /v1/predictions/{id}`. Output URLs require the Authorization header and
 * expire (~1h), so bytes are downloaded here. Reference images ride as data
 * URLs when small, otherwise via the Files API.
 */

interface ReplicateModel extends MediaModelInfo {
  readonly label: string;
}

const MODELS: ReplicateModel[] = [
  { id: "black-forest-labs/flux-schnell", label: "FLUX.1 [schnell]", modes: ["t2i"], maxReferences: 0, maxCount: 4 },
  { id: "black-forest-labs/flux-dev", label: "FLUX.1 [dev]", modes: ["t2i"], maxReferences: 0, maxCount: 4 },
  { id: "black-forest-labs/flux-1.1-pro", label: "FLUX 1.1 [pro]", modes: ["t2i"], maxReferences: 0, maxCount: 1 },
  { id: "black-forest-labs/flux-kontext-pro", label: "FLUX.1 Kontext [pro]", modes: ["i2i"], maxReferences: 1, maxCount: 1 },
  { id: "black-forest-labs/flux-kontext-max", label: "FLUX.1 Kontext [max]", modes: ["i2i"], maxReferences: 1, maxCount: 1 },
];

const DEFAULT_MODEL = "black-forest-labs/flux-schnell";

const ASPECT_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9", "9:21"];

function paramsFor(model: ReplicateModel): MediaParamSpec[] {
  return [
    {
      key: "aspect_ratio",
      label: "Aspect ratio",
      kind: "enum",
      options: ["auto", ...ASPECT_RATIOS].map((r) => ({ value: r, label: r })),
      default: "1:1",
    },
    {
      key: "output_format",
      label: "Output format",
      kind: "enum",
      options: ["png", "jpg", "webp"].map((v) => ({ value: v, label: v })),
      default: "png",
    },
    { key: "seed", label: "Seed", kind: "number", min: 0, max: 2_147_483_647 },
    { key: "count", label: "Number of images", kind: "range", min: 1, max: model.maxCount, step: 1, default: 1 },
  ];
}

interface Prediction {
  id?: unknown;
  status?: unknown;
  output?: unknown;
  error?: unknown;
}

export class ReplicateMediaAdapter implements MediaGenAdapter {
  readonly id = "replicate";

  constructor(private readonly fetchImpl: typeof globalThis.fetch = globalThis.fetch) {}

  defaultModel(): string {
    return DEFAULT_MODEL;
  }

  async listModels(): Promise<MediaModelInfo[]> {
    return MODELS.map((m) => ({ id: m.id, label: m.label, modes: m.modes, maxReferences: m.maxReferences, maxCount: m.maxCount }));
  }

  capabilities(model?: string): MediaCapabilities {
    const info = infoFor(model);
    return {
      provider: "replicate",
      model: info.id,
      modes: info.modes,
      maxReferences: info.maxReferences,
      maxCount: info.maxCount,
      params: paramsFor(info),
    };
  }

  async generate(input: {
    request: MediaGenRequest;
    credentials: { apiKey?: string; baseUrl?: string; headers?: Record<string, string> };
    ctx: MediaGenContext;
  }): Promise<MediaGenerateResult> {
    const { request, credentials, ctx } = input;
    if (credentials.apiKey === undefined || credentials.apiKey.length === 0) {
      throw new MediaGenError(
        "Replicate API token not configured — add one in Settings → Providers, or set REPLICATE_API_TOKEN.",
        { retryable: false },
      );
    }
    const baseUrl = (credentials.baseUrl ?? REPLICATE_API_URL).replace(/\/+$/, "");
    const model = request.model ?? this.defaultModel();
    const params = request.params ?? {};
    const headers = { authorization: `Bearer ${credentials.apiKey}`, ...(credentials.headers ?? {}) };

    const modelInput: Record<string, unknown> = { prompt: request.prompt };
    if (typeof params.aspect_ratio === "string" && params.aspect_ratio !== "auto") modelInput.aspect_ratio = params.aspect_ratio;
    if (typeof params.output_format === "string" && params.output_format.length > 0) modelInput.output_format = params.output_format;
    if (typeof params.seed === "number") modelInput.seed = Math.round(params.seed);
    if (typeof params.count === "number") modelInput.num_outputs = Math.max(1, Math.round(params.count));

    if (request.mode === "i2i") {
      const refId = request.referenceAssetIds?.[0];
      const asset = refId !== undefined ? ctx.readAsset(refId) : undefined;
      if (asset === undefined) {
        throw new MediaGenError("Replicate image-to-image needs a readable reference image.", { retryable: false });
      }
      modelInput.input_image = await this.referenceUrl({ mime: asset.mime, bytes: asset.bytes }, baseUrl, headers, ctx);
    }

    const submitted = (await postJson(
      this.fetchImpl,
      `${baseUrl}/predictions`,
      { model, input: modelInput },
      { headers: { ...headers, prefer: "wait" }, signal: ctx.signal, label: "Replicate prediction" },
    )) as Prediction | undefined;

    let prediction = submitted;
    if (!isTerminal(prediction)) {
      const id = typeof prediction?.id === "string" ? prediction.id : undefined;
      if (id === undefined) throw new MediaGenError("Replicate did not return a prediction id.", { retryable: false });
      prediction = await pollUntil<Prediction>(
        async () => {
          const current = (await getJson(this.fetchImpl, `${baseUrl}/predictions/${id}`, {
            headers,
            signal: ctx.signal,
            label: "Replicate poll",
          })) as Prediction | undefined;
          return isTerminal(current) ? { done: true, value: current } : { done: false };
        },
        { signal: ctx.signal, label: "Replicate generation" },
      );
    }

    const status = typeof prediction?.status === "string" ? prediction.status : "unknown";
    if (status !== "succeeded") {
      const message = typeof prediction?.error === "string" ? prediction.error : `Replicate prediction ${status}.`;
      throw new MediaGenError(message, { retryable: status === "starting" || status === "processing" });
    }
    const urls = outputUrls(prediction?.output);
    if (urls.length === 0) {
      throw new MediaGenError("Replicate returned no images for this request.", { retryable: false });
    }
    const images: MediaGeneratedImage[] = [];
    for (const url of urls) {
      images.push(
        await fetchImageBytes(this.fetchImpl, url, {
          headers,
          signal: ctx.signal,
          fallbackMime: "image/png",
          label: "Replicate image download",
        }),
      );
    }
    return { images };
  }

  /** Data URL when small enough, else upload to the Replicate Files API. */
  private async referenceUrl(
    ref: { mime: string; bytes: Uint8Array },
    baseUrl: string,
    headers: Record<string, string>,
    ctx: MediaGenContext,
  ): Promise<string> {
    if (ref.bytes.byteLength <= DATA_URL_LIMIT) return toDataUrl(ref.mime, ref.bytes);
    const form = new FormData();
    form.append("content", bytesToBlob(ref.bytes, ref.mime), "reference.png");
    const res = await postForm(this.fetchImpl, `${baseUrl}/files`, form, {
      headers,
      signal: ctx.signal,
      label: "Replicate file upload",
    });
    const json = (await res.json().catch(() => undefined)) as { urls?: { get?: unknown } } | undefined;
    const url = json?.urls?.get;
    if (typeof url !== "string" || url.length === 0) {
      throw new MediaGenError("Replicate file upload returned no URL.", { retryable: false });
    }
    return url;
  }
}

function isTerminal(prediction: Prediction | undefined): boolean {
  const status = typeof prediction?.status === "string" ? prediction.status : "";
  return status === "succeeded" || status === "failed" || status === "canceled";
}

function outputUrls(output: unknown): string[] {
  if (typeof output === "string") return [output];
  if (Array.isArray(output)) return output.filter((v): v is string => typeof v === "string");
  return [];
}

function infoFor(model?: string): ReplicateModel {
  const id = model !== undefined && model.length > 0 ? model : DEFAULT_MODEL;
  return (
    MODELS.find((m) => m.id === id) ?? {
      id,
      label: id,
      modes: ["t2i"],
      maxReferences: 0,
      maxCount: 4,
    }
  );
}
