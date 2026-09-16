/**
 * Shared adapter for the OpenAI-compatible image APIs. OpenAI, xAI, Together,
 * DeepInfra, and Recraft all expose `POST {baseUrl}/images/generations` (JSON,
 * Bearer auth, `data[].b64_json` or `data[].url`) and most support an
 * image-to-image variant. Each vendor module supplies a small {@link
 * OpenAiImagesSpec}; this class owns HTTP, decoding, URL downloads, and errors.
 *
 * No vendor SDK is used — everything goes through the injected `fetch`.
 */

import type {
  MediaCapabilities,
  MediaGenRequest,
  MediaModelInfo,
  MediaMode,
  MediaParamSpec,
} from "@bai/shared";
import {
  MediaGenError,
  type MediaGenAdapter,
  type MediaGenContext,
  type MediaGenerateResult,
  type MediaGeneratedImage,
} from "./adapter";
import {
  bytesToBlob,
  decodeB64,
  fetchImageBytes,
  mimeFromFormat,
  postForm,
  postJson,
  toGeneratedImage,
} from "./http";

export interface OpenAiImagesModel extends MediaModelInfo {
  readonly label: string;
}

/** A reference image resolved from the asset store. */
export interface RefImage {
  mime: string;
  bytes: Uint8Array;
}

/** How image-to-image is transported. */
export type OpenAiEditStyle = "multipart" | "json" | "refs" | "none";

export interface OpenAiImagesSpec {
  id: string;
  label: string;
  baseUrl: string;
  /** Env var named in the missing-key error (e.g. "OPENAI_API_KEY"). */
  envHint: string;
  defaultModel: string;
  models: OpenAiImagesModel[];
  paramsFor(model: OpenAiImagesModel): MediaParamSpec[];
  /**
   * Build the JSON generation body. `refs` is non-empty for "refs"-style i2i
   * (Together/Kontext, Recraft); other providers ignore it here.
   */
  generationBody(request: MediaGenRequest, model: string, refs: RefImage[]): Record<string, unknown>;
  /** i2i transport; `"refs"` rides generationBody, the others use /images/edits. */
  edit?: OpenAiEditStyle;
  /** Body for the xAI-style JSON `/images/edits` (required when edit === "json"). */
  editBody?(request: MediaGenRequest, model: string, refs: RefImage[]): Record<string, unknown>;
  /** Default mime when the provider omits one (e.g. Recraft SVG). */
  defaultMime?(request: MediaGenRequest): string;
  /** Extract provider-reported USD cost from the response body. */
  parseCost?(json: unknown): number | undefined;
  /** Headers required to download result URLs (e.g. Together's User-Agent). */
  downloadHeaders?: Record<string, string>;
}

export class OpenAiImagesAdapter implements MediaGenAdapter {
  private readonly modelsCache: { at: number; models: MediaModelInfo[] } = { at: 0, models: [] };

  constructor(
    private readonly spec: OpenAiImagesSpec,
    private readonly fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  ) {}

  get id(): string {
    return this.spec.id;
  }

  defaultModel(): string {
    return this.spec.defaultModel;
  }

  async listModels(): Promise<MediaModelInfo[]> {
    if (this.modelsCache.models.length === 0) {
      this.modelsCache.models = this.spec.models.map((m) => modelInfo(m));
    }
    return this.modelsCache.models;
  }

  capabilities(model?: string): MediaCapabilities {
    const info = this.infoFor(model);
    return {
      provider: this.spec.id,
      model: info.id,
      modes: info.modes,
      maxReferences: info.maxReferences,
      maxCount: info.maxCount,
      params: this.spec.paramsFor(info),
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
        `${this.spec.label} API key not configured — add one in Settings → Providers, or set ${this.spec.envHint}.`,
        { retryable: false },
      );
    }
    const baseUrl = (credentials.baseUrl ?? this.spec.baseUrl).replace(/\/+$/, "");
    const model = request.model ?? this.defaultModel();
    const headers = {
      authorization: `Bearer ${credentials.apiKey}`,
      ...(credentials.headers ?? {}),
    };
    const refs = this.resolveRefs(request, ctx);

    if (request.mode === "i2i" && this.spec.edit === "multipart") {
      return this.generateMultipartEdit({ baseUrl, model, headers, request, refs, ctx });
    }
    if (request.mode === "i2i" && this.spec.edit === "json") {
      const body = {
        ...(this.spec.editBody?.(request, model, refs) ?? { model, prompt: request.prompt }),
      };
      const json = await postJson(this.fetchImpl, `${baseUrl}/images/edits`, body, {
        headers,
        signal: ctx.signal,
        label: `${this.spec.label} image edit`,
      });
      return this.collect(json, request, ctx);
    }

    const body = this.spec.generationBody(request, model, refs);
    const json = await postJson(this.fetchImpl, `${baseUrl}/images/generations`, body, {
      headers,
      signal: ctx.signal,
      label: `${this.spec.label} image request`,
    });
    return this.collect(json, request, ctx);
  }

  /** OpenAI-style multipart `/images/edits` (files + prompt + params). */
  private async generateMultipartEdit(input: {
    baseUrl: string;
    model: string;
    headers: Record<string, string>;
    request: MediaGenRequest;
    refs: RefImage[];
    ctx: MediaGenContext;
  }): Promise<MediaGenerateResult> {
    const { baseUrl, model, headers, request, refs, ctx } = input;
    const form = new FormData();
    form.set("model", model);
    form.set("prompt", request.prompt);
    const params = request.params ?? {};
    for (const key of ["n", "size", "quality", "background", "output_format", "output_compression"] as const) {
      const value = params[key];
      if (typeof value === "number" || (typeof value === "string" && value.length > 0 && value !== "auto")) {
        form.set(key, String(value));
      }
    }
    const field = refs.length > 1 ? "image[]" : "image";
    for (const ref of refs) {
      form.append(field, bytesToBlob(ref.bytes, ref.mime), "reference.png");
    }
    const res = await postForm(this.fetchImpl, `${baseUrl}/images/edits`, form, {
      headers,
      signal: ctx.signal,
      label: `${this.spec.label} image edit`,
    });
    const json = (await res.json().catch(() => undefined)) as unknown;
    return this.collect(json, request, ctx);
  }

  /** Decode `data[]` (base64 and/or URL), download URLs, attach cost. */
  private async collect(
    json: unknown,
    request: MediaGenRequest,
    ctx: MediaGenContext,
  ): Promise<MediaGenerateResult> {
    const data =
      typeof json === "object" && json !== null && Array.isArray((json as { data?: unknown }).data)
        ? ((json as { data: unknown[] }).data)
        : [];
    const files: MediaGeneratedImage[] = [];
    for (const entry of data) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as { b64_json?: unknown; url?: unknown; media_type?: unknown };
      const fallback = this.defaultMime(request);
      if (typeof record.b64_json === "string" && record.b64_json.length > 0) {
        files.push(
          toGeneratedImage(
            decodeB64(record.b64_json),
            typeof record.media_type === "string" ? record.media_type : undefined,
            fallback,
          ),
        );
      } else if (typeof record.url === "string" && record.url.length > 0) {
        files.push(
          await fetchImageBytes(this.fetchImpl, record.url, {
            ...(this.spec.downloadHeaders !== undefined ? { headers: this.spec.downloadHeaders } : {}),
            signal: ctx.signal,
            fallbackMime: fallback,
            label: `${this.spec.label} image download`,
          }),
        );
      }
    }
    if (files.length === 0) {
      throw new MediaGenError(`${this.spec.label} returned no images for this request.`, { retryable: false });
    }
    const costUsd = this.spec.parseCost?.(json);
    return { images: files, ...(costUsd !== undefined ? { costUsd } : {}) };
  }

  private resolveRefs(request: MediaGenRequest, ctx: MediaGenContext): RefImage[] {
    if (request.mode !== "i2i") return [];
    const refs: RefImage[] = [];
    for (const id of request.referenceAssetIds ?? []) {
      const asset = ctx.readAsset(id);
      if (asset !== undefined) refs.push({ mime: asset.mime, bytes: asset.bytes });
    }
    return refs;
  }

  private defaultMime(request: MediaGenRequest): string {
    if (this.spec.defaultMime !== undefined) return this.spec.defaultMime(request);
    return mimeFromFormat(request.params?.output_format);
  }

  private infoFor(model?: string): OpenAiImagesModel {
    const id = model !== undefined && model.length > 0 ? model : this.spec.defaultModel;
    return (
      this.spec.models.find((m) => m.id === id) ?? {
        id,
        label: id,
        modes: ["t2i", "i2i"],
        maxReferences: 4,
        maxCount: 4,
      }
    );
  }
}

/** Copy a curated model to a `MediaModelInfo` row (drops the label). */
function modelInfo(model: OpenAiImagesModel): MediaModelInfo {
  return {
    id: model.id,
    label: model.label,
    modes: model.modes,
    maxReferences: model.maxReferences,
    maxCount: model.maxCount,
    ...(model.rates !== undefined ? { rates: model.rates } : {}),
  };
}

/** A model supports i2i iff it accepts at least one reference. */
export function modesFor(maxReferences: number): MediaMode[] {
  return maxReferences > 0 ? ["t2i", "i2i"] : ["t2i"];
}
