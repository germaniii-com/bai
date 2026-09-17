import type {
  GenericVideoSpec,
  MediaParamSpec,
  ProviderFileAuth,
  VideoCapabilities,
  VideoGenRequest,
  VideoInputSlot,
  VideoModelInfo,
  VideoWorkflow,
  VideoWorkflowSpec,
} from "@bai/shared";
import { VIDEO_WORKFLOW_LABELS } from "@bai/shared";
import { MediaGenError, type MediaAdapterCredentials, type MediaGenContext } from "../adapter";
import type { VideoGenAdapter, VideoGenerateResult } from "../video-adapter";
import { asArray, interpolate, readPath, type MappingVars } from "../mapping";
import { bytesToBlob, decodeB64, encodeB64, postForm, postJson, toDataUrl } from "../http";
import { fetchVideoBytes, toGeneratedVideo } from "../video-http";
import { inputBytes, inputsByRole, resolveInputs, type ResolvedInput } from "../upload";

/** Everything a generic file-defined video provider needs. */
export interface GenericVideoConfig {
  id: string;
  label: string;
  baseUrl: string;
  /** Env vars named in the missing-key error. */
  envHint: string[];
  auth: ProviderFileAuth;
  headers?: Record<string, string>;
  spec: GenericVideoSpec;
}

/**
 * A declarative video adapter for provider files: the file supplies a request
 * body template (`$prompt`/`$model`/`$workflow`/`$duration`/`$param.*`) plus
 * response paths. Supports t2v/i2v/flf2v/ref2v via the mapping's `references`.
 */
export class GenericVideoAdapter implements VideoGenAdapter {
  readonly id: string;

  constructor(
    private readonly config: GenericVideoConfig,
    private readonly fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  ) {
    this.id = config.id;
  }

  defaultModel(): string {
    return this.config.spec.defaultModel;
  }

  async listModels(): Promise<VideoModelInfo[]> {
    return this.config.spec.models.map((m) => ({
      id: m.id,
      ...(m.label !== undefined ? { label: m.label } : {}),
      workflows: m.workflows as VideoWorkflow[],
    }));
  }

  capabilities(model?: string): VideoCapabilities {
    const info = infoFor(this.config.spec, model);
    return {
      provider: this.id,
      model: info.id,
      workflows: workflowsFor(info.workflows),
      params: paramsFor(this.config.spec),
    };
  }

  async generate(input: {
    request: VideoGenRequest;
    credentials: MediaAdapterCredentials;
    ctx: MediaGenContext;
  }): Promise<VideoGenerateResult> {
    const { request, credentials, ctx } = input;
    if (credentials.apiKey === undefined || credentials.apiKey.length === 0) {
      const hint = this.config.envHint[0];
      throw new MediaGenError(
        `${this.config.label} API key not configured — add one in Settings → Video Generation${hint !== undefined ? `, or set ${hint}` : ""}.`,
        { retryable: false },
      );
    }
    const base = (credentials.baseUrl ?? this.config.baseUrl).replace(/\/+$/, "");
    const model = request.model ?? this.defaultModel();
    const inputs = resolveInputs(request.inputs, ctx);
    const mapping = this.config.spec.generate;
    const vars = mappingVars(request, model);
    const headers = {
      ...(this.config.headers ?? {}),
      ...authHeaders(credentials.apiKey, this.config.auth),
      ...(credentials.headers ?? {}),
    };
    const url = `${base}${mapping.path}`;

    let json: unknown;
    if (mapping.contentType === "multipart") {
      const form = buildForm(mapping.body, vars, mapping.references, inputs);
      const res = await postForm(this.fetchImpl, url, form, {
        headers,
        signal: ctx.signal,
        label: `${this.config.label} video request`,
      });
      json = await res.json().catch(() => undefined);
    } else {
      const body = interpolate(mapping.body, vars) as Record<string, unknown>;
      attachJsonReferences(body, mapping.references, inputs);
      json = await postJson(this.fetchImpl, url, body, {
        headers,
        signal: ctx.signal,
        label: `${this.config.label} video request`,
      });
    }

    const entries = asArray(readPath(json, this.config.spec.response.videos));
    const videos = [];
    for (const entry of entries) {
      const response = this.config.spec.response;
      const mime = response.mime !== undefined ? readField(entry, response.mime) : undefined;
      const fallbackMime = typeof mime === "string" && mime.length > 0 ? mime : "video/mp4";
      if (response.base64 !== undefined) {
        const b64 = readField(entry, response.base64);
        if (typeof b64 === "string" && b64.length > 0) {
          videos.push(toGeneratedVideo(decodeB64(b64), fallbackMime, fallbackMime));
          continue;
        }
      }
      if (response.url !== undefined) {
        const videoUrl = readField(entry, response.url);
        if (typeof videoUrl === "string" && videoUrl.length > 0) {
          videos.push(
            await fetchVideoBytes(this.fetchImpl, videoUrl, {
              signal: ctx.signal,
              fallbackMime,
              label: `${this.config.label} video download`,
            }),
          );
        }
      }
    }
    if (videos.length === 0) {
      throw new MediaGenError(`${this.config.label} returned no video for this request.`, { retryable: false });
    }
    const rawCost =
      this.config.spec.response.costUsd !== undefined ? readPath(json, this.config.spec.response.costUsd) : undefined;
    const costUsd = typeof rawCost === "number" && Number.isFinite(rawCost) ? rawCost : undefined;
    return { videos, ...(costUsd !== undefined ? { costUsd } : {}) };
  }
}

function workflowsFor(workflows: VideoWorkflow[]): VideoWorkflowSpec[] {
  const inputsFor: Partial<Record<VideoWorkflow, VideoInputSlot[]>> = {
    i2v: [{ role: "first_frame", label: "First frame", accepts: ["image"], required: true }],
    flf2v: [
      { role: "first_frame", label: "First frame", accepts: ["image"], required: true },
      { role: "last_frame", label: "Last frame", accepts: ["image"] },
    ],
    ref2v: [{ role: "reference_image", label: "Reference images", accepts: ["image"], multiple: true, maxCount: 4 }],
  };
  return workflows.map((id) => ({ id, label: VIDEO_WORKFLOW_LABELS[id], inputs: inputsFor[id] ?? [] }));
}

function paramsFor(spec: GenericVideoSpec): MediaParamSpec[] {
  if (spec.params !== undefined && spec.params.length > 0) return spec.params as MediaParamSpec[];
  return [
    { key: "duration", label: "Duration", kind: "range", min: 1, max: 15, step: 1, default: 5, unit: "s" },
    { key: "resolution", label: "Resolution", kind: "text", placeholder: "720p" },
    { key: "seed", label: "Seed", kind: "number", min: 0, max: 2_147_483_647 },
  ];
}

function mappingVars(request: VideoGenRequest, model: string): MappingVars {
  const params = request.params ?? {};
  return {
    prompt: request.prompt,
    model,
    count: 1,
    mode: request.workflow,
    workflow: request.workflow,
    ...(typeof params.width === "number" ? { width: params.width } : {}),
    ...(typeof params.height === "number" ? { height: params.height } : {}),
    ...(typeof params.seed === "number" ? { seed: params.seed } : {}),
    ...(typeof params.duration === "number" ? { duration: params.duration } : {}),
    params,
  };
}

function authHeaders(apiKey: string, auth: ProviderFileAuth): Record<string, string> {
  const value = auth.scheme.length > 0 ? `${auth.scheme} ${apiKey}` : apiKey;
  return { [auth.header]: value };
}

function attachJsonReferences(
  body: Record<string, unknown>,
  mapping: { field: string; encoding: "data-url" | "base64"; mimeField?: string; wrap: "array" | "single" } | undefined,
  inputs: ResolvedInput[],
): void {
  if (mapping === undefined) return;
  const refs = inputsByRole(inputs, "reference_image");
  if (refs.length === 0) return;
  const encode = (ref: ResolvedInput): unknown => {
    if (mapping.encoding === "data-url") return ref.url ?? toDataUrl(ref.mime, inputBytes(ref));
    const data = encodeB64(inputBytes(ref));
    return mapping.mimeField !== undefined ? { data, [mapping.mimeField]: ref.mime } : data;
  };
  body[mapping.field] = mapping.wrap === "single" ? encode(refs[0] as ResolvedInput) : refs.map(encode);
}

function buildForm(
  template: Record<string, unknown>,
  vars: MappingVars,
  mapping: { field: string; wrap: "array" | "single" } | undefined,
  inputs: ResolvedInput[],
): FormData {
  const form = new FormData();
  const body = interpolate(template, vars) as Record<string, unknown>;
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) for (const item of value) form.append(key, stringifyFormValue(item));
    else form.set(key, stringifyFormValue(value));
  }
  if (mapping !== undefined) {
    const refs = inputsByRole(inputs, "reference_image");
    const limit = mapping.wrap === "single" ? 1 : refs.length;
    for (const ref of refs.slice(0, limit)) form.append(mapping.field, bytesToBlob(inputBytes(ref), ref.mime), "reference.bin");
  }
  return form;
}

function stringifyFormValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function readField(entry: unknown, field: string): unknown {
  return field === "." ? entry : readPath(entry, field);
}

function infoFor(spec: GenericVideoSpec, model?: string): { id: string; workflows: VideoWorkflow[] } {
  const id = model !== undefined && model.length > 0 ? model : spec.defaultModel;
  const found = spec.models.find((m) => m.id === id);
  return { id, workflows: (found?.workflows as VideoWorkflow[] | undefined) ?? ["t2v"] };
}
