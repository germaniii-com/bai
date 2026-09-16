import type {
  GenericImageSpec,
  GenericRequest,
  MediaCapabilities,
  MediaGenRequest,
  MediaModelInfo,
  MediaParamSpec,
  MediaParamValue,
  ProviderFileAuth,
} from "@bai/shared";
import {
  MediaGenError,
  type MediaGenAdapter,
  type MediaGenContext,
  type MediaGenerateResult,
  type MediaGeneratedImage,
} from "./adapter";
import {
  asArray,
  interpolate,
  readPath,
  type MappingVars,
} from "./mapping";
import {
  bytesToBlob,
  decodeB64,
  encodeB64,
  fetchImageBytes,
  postForm,
  postJson,
  toDataUrl,
  toGeneratedImage,
} from "./http";

/** Everything a generic file provider needs (id/label/endpoint + mapping). */
export interface GenericMediaConfig {
  id: string;
  label: string;
  baseUrl: string;
  /** Env vars named in the missing-key error. */
  envHint: string[];
  auth: ProviderFileAuth;
  headers?: Record<string, string>;
  spec: GenericImageSpec;
}

/**
 * A declarative media adapter: the provider file supplies the request body
 * template (with `$`-tokens), the reference-image mapping, and the response
 * paths. All HTTP goes through the shared media helpers (no SDK).
 */
export class GenericMediaAdapter implements MediaGenAdapter {
  readonly id: string;

  constructor(
    private readonly config: GenericMediaConfig,
    private readonly fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  ) {
    this.id = config.id;
  }

  defaultModel(): string {
    return this.config.spec.defaultModel;
  }

  async listModels(): Promise<MediaModelInfo[]> {
    return this.config.spec.models.map((m) => ({
      id: m.id,
      ...(m.label !== undefined ? { label: m.label } : {}),
      modes: m.modes,
      maxReferences: m.maxReferences,
      maxCount: m.maxCount,
    }));
  }

  capabilities(model?: string): MediaCapabilities {
    const info = infoFor(this.config.spec, model);
    return {
      provider: this.id,
      model: info.id,
      modes: info.modes,
      maxReferences: info.maxReferences,
      maxCount: info.maxCount,
      params: paramsFor(this.config.spec, info),
    };
  }

  async generate(input: {
    request: MediaGenRequest;
    credentials: { apiKey?: string; baseUrl?: string; headers?: Record<string, string> };
    ctx: MediaGenContext;
  }): Promise<MediaGenerateResult> {
    const { request, credentials, ctx } = input;
    if (credentials.apiKey === undefined || credentials.apiKey.length === 0) {
      const hint = this.config.envHint[0];
      throw new MediaGenError(
        `${this.config.label} API key not configured — add one in Settings → Providers${hint !== undefined ? `, or set ${hint}` : ""}.`,
        { retryable: false },
      );
    }
    const baseUrl = (credentials.baseUrl ?? this.config.baseUrl).replace(/\/+$/, "");
    const model = request.model ?? this.defaultModel();
    const params = request.params ?? {};
    const useEdit = request.mode === "i2i" && this.config.spec.edit !== undefined;
    const mapping = useEdit ? (this.config.spec.edit as GenericRequest) : this.config.spec.generate;

    // Reference bytes are resolved for every i2i request; the chosen mapping
    // decides whether/where to attach them (`references`), and mappings without
    // one simply ignore them.
    const refs = request.mode === "i2i" ? resolveRefs(request, ctx) : [];
    const vars = mappingVars(request, model, params);
    const headers = {
      ...(this.config.headers ?? {}),
      ...authHeaders(credentials.apiKey, this.config.auth),
      ...(credentials.headers ?? {}),
    };
    const url = `${baseUrl}${mapping.path}`;

    let json: unknown;
    if (mapping.contentType === "multipart") {
      const form = buildForm(mapping, vars, refs);
      const res = await postForm(this.fetchImpl, url, form, {
        headers,
        signal: ctx.signal,
        label: `${this.config.label} image request`,
      });
      json = await res.json().catch(() => undefined);
    } else {
      const body = interpolate(mapping.body, vars) as Record<string, unknown>;
      attachJsonReferences(body, mapping, refs);
      json = await postJson(this.fetchImpl, url, body, {
        headers,
        signal: ctx.signal,
        label: `${this.config.label} image request`,
      });
    }

    return this.collect(json, ctx);
  }

  /** Map the decoded response onto generated image bytes (+ cost). */
  private async collect(json: unknown, ctx: MediaGenContext): Promise<MediaGenerateResult> {
    const response = this.config.spec.response;
    const entries = asArray(readPath(json, response.images));
    const images: MediaGeneratedImage[] = [];
    for (const entry of entries) {
      const mime = response.mime !== undefined ? readField(entry, response.mime) : undefined;
      const fallbackMime = typeof mime === "string" && mime.length > 0 ? mime : "image/png";
      if (response.base64 !== undefined) {
        const b64 = readField(entry, response.base64);
        if (typeof b64 === "string" && b64.length > 0) {
          images.push(toGeneratedImage(decodeB64(b64), fallbackMime, fallbackMime));
          continue;
        }
      }
      if (response.url !== undefined) {
        const url = readField(entry, response.url);
        if (typeof url === "string" && url.length > 0) {
          images.push(
            await fetchImageBytes(this.fetchImpl, url, {
              signal: ctx.signal,
              fallbackMime,
              label: `${this.config.label} image download`,
            }),
          );
        }
      }
    }
    if (images.length === 0) {
      throw new MediaGenError(`${this.config.label} returned no images for this request.`, { retryable: false });
    }
    const rawCost = response.costUsd !== undefined ? readPath(json, response.costUsd) : undefined;
    const costUsd = typeof rawCost === "number" && Number.isFinite(rawCost) ? rawCost : undefined;
    return { images, ...(costUsd !== undefined ? { costUsd } : {}) };
  }
}

function infoFor(spec: GenericImageSpec, model?: string): { id: string; modes: ("t2i" | "i2i")[]; maxReferences: number; maxCount: number } {
  const id = model !== undefined && model.length > 0 ? model : spec.defaultModel;
  const found = spec.models.find((m) => m.id === id);
  if (found !== undefined) {
    return { id, modes: found.modes, maxReferences: found.maxReferences, maxCount: found.maxCount };
  }
  return { id, modes: ["t2i", "i2i"], maxReferences: 4, maxCount: 4 };
}

function paramsFor(spec: GenericImageSpec, info: { maxCount: number }): MediaParamSpec[] {
  if (spec.params !== undefined && spec.params.length > 0) return spec.params;
  return [
    { key: "count", label: "Number of images", kind: "range", min: 1, max: info.maxCount, step: 1, default: 1 },
    { key: "seed", label: "Seed", kind: "number", min: 0, max: 2_147_483_647 },
  ];
}

function mappingVars(request: MediaGenRequest, model: string, params: Record<string, MediaParamValue>): MappingVars {
  return {
    prompt: request.prompt,
    model,
    count: typeof params.count === "number" ? Math.max(1, Math.round(params.count)) : 1,
    mode: request.mode,
    ...(typeof params.width === "number" ? { width: params.width } : {}),
    ...(typeof params.height === "number" ? { height: params.height } : {}),
    ...(typeof params.seed === "number" ? { seed: params.seed } : {}),
    params,
  };
}

function authHeaders(apiKey: string, auth: ProviderFileAuth): Record<string, string> {
  const value = auth.scheme.length > 0 ? `${auth.scheme} ${apiKey}` : apiKey;
  return { [auth.header]: value };
}

interface RefImage {
  mime: string;
  bytes: Uint8Array;
}

function resolveRefs(request: MediaGenRequest, ctx: MediaGenContext): RefImage[] {
  const refs: RefImage[] = [];
  for (const id of request.referenceAssetIds ?? []) {
    const asset = ctx.readAsset(id);
    if (asset !== undefined) refs.push({ mime: asset.mime, bytes: asset.bytes });
  }
  return refs;
}

function encodeRef(ref: RefImage, encoding: "data-url" | "base64", mimeField?: string): unknown {
  if (encoding === "data-url") return toDataUrl(ref.mime, ref.bytes);
  const data = encodeB64(ref.bytes);
  return mimeField !== undefined ? { data, [mimeField]: ref.mime } : data;
}

function attachJsonReferences(body: Record<string, unknown>, mapping: GenericRequest, refs: RefImage[]): void {
  const mappingRefs = mapping.references;
  if (mappingRefs === undefined || refs.length === 0) return;
  const encode = (ref: RefImage): unknown => encodeRef(ref, mappingRefs.encoding, mappingRefs.mimeField);
  body[mappingRefs.field] = mappingRefs.wrap === "single" ? encode(refs[0] as RefImage) : refs.map(encode);
}

function buildForm(mapping: GenericRequest, vars: MappingVars, refs: RefImage[]): FormData {
  const form = new FormData();
  const body = interpolate(mapping.body, vars) as Record<string, unknown>;
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) form.append(key, stringifyFormValue(item));
    } else {
      form.set(key, stringifyFormValue(value));
    }
  }
  if (mapping.references !== undefined && refs.length > 0) {
    const limit = mapping.references.wrap === "single" ? 1 : refs.length;
    for (const ref of refs.slice(0, limit)) {
      form.append(mapping.references.field, bytesToBlob(ref.bytes, ref.mime), "reference.png");
    }
  }
  return form;
}

function stringifyFormValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/** Read a relative field within a response entry; `"."` means the entry itself. */
function readField(entry: unknown, field: string): unknown {
  return field === "." ? entry : readPath(entry, field);
}
