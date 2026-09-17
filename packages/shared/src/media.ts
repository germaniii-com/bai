/**
 * Media-generation vocabulary shared by core, the API, and every surface.
 *
 * The workbench owns its parameter vocabulary: an adapter declares
 * {@link MediaParamSpec}s (enum pickers, toggles, ranges, numbers, text) and
 * the web renders them generically, so a new provider is data — not UI work.
 * A generation request is stored verbatim on every produced asset
 * (`meta.gen`) so a gallery item can repopulate the form and be re-run; the
 * generated images themselves are immutable history.
 */

import type { Asset, Job } from "./domain";
import type { AssetId } from "./ids";
import type { AccountInfo } from "./providers";

/** The two generation workflows: text-to-image and image-to-image. */
export type MediaMode = "t2i" | "i2i";
/** One value a media parameter can carry on the wire. */
export type MediaParamValue = string | number | boolean | string[];

export interface MediaParamOption {
  value: string;
  label: string;
}

/**
 * One declarative parameter a provider/model accepts. `key` is the canonical
 * name the adapter maps to its request body (e.g. `aspect_ratio`, `n`,
 * `output_format`); surfaces never interpret it beyond reading its spec.
 */
export type MediaParamSpec =
  | { key: string; label: string; kind: "enum"; options: MediaParamOption[]; default?: string; hint?: string }
  | { key: string; label: string; kind: "toggle"; default?: boolean; hint?: string }
  | {
      key: string;
      label: string;
      kind: "range";
      min: number;
      max: number;
      step?: number;
      default?: number;
      unit?: string;
      hint?: string;
    }
  | { key: string; label: string; kind: "number"; min?: number; max?: number; default?: number; hint?: string }
  | { key: string; label: string; kind: "text"; default?: string; placeholder?: string; hint?: string }
  | {
      key: string;
      label: string;
      kind: "list";
      /** Item type (currently only free text — e.g. a multi-shot prompt list). */
      itemKind?: "text";
      min?: number;
      max?: number;
      default?: string[];
      hint?: string;
    };

/** A provider/model's generation capabilities — drives the params UI. */
export interface MediaCapabilities {
  provider: string;
  model: string;
  /** Which workflows this model supports. */
  modes: MediaMode[];
  /** Maximum number of reference images (0 = text-to-image only). */
  maxReferences: number;
  /** Maximum number of images per generation (n). */
  maxCount: number;
  params: MediaParamSpec[];
}

/** A selectable image model (the per-page model picker). */
export interface MediaModelInfo {
  id: string;
  label?: string;
  modes: MediaMode[];
  maxReferences: number;
  maxCount: number;
  /** Provider-published pricing rows (label/value) for the picker. */
  rates?: MediaModelRate[];
}

/** One pricing row shown beside a model (e.g. `Out · $40 / 1M tok`). */
export interface MediaModelRate {
  label: string;
  value: string;
}

// --- video -----------------------------------------------------------------
//
// Video is workflow-driven: the task verb (t2v/i2v/flf2v/ref2v/v2v/extend/
// upscale/motion/lipsync/reframe) plus role-tagged inputs. Mature provider APIs
// name the input *role* explicitly (first frame vs reference vs source), so the
// vocabulary below is role-first. Adapters advertise only the workflows they
// can actually serve, and surfaces render each workflow's declared input slots
// + params generically.

/** A media modality that can be produced from or consumed by a generation. */
export type MediaKind = "image" | "video" | "audio";

/** Every video-generation workflow bai models. */
export type VideoWorkflow =
  | "t2v"
  | "i2v"
  | "flf2v"
  | "ref2v"
  | "v2v"
  | "extend"
  | "upscale"
  | "motion"
  | "lipsync"
  | "reframe";

export const VIDEO_WORKFLOWS: readonly VideoWorkflow[] = [
  "t2v",
  "i2v",
  "flf2v",
  "ref2v",
  "v2v",
  "extend",
  "upscale",
  "motion",
  "lipsync",
  "reframe",
];

/** Human labels for the workflow picker. */
export const VIDEO_WORKFLOW_LABELS: Record<VideoWorkflow, string> = {
  t2v: "Text to Video",
  i2v: "Image to Video",
  flf2v: "First + Last Frame",
  ref2v: "Reference to Video",
  v2v: "Video to Video (edit)",
  extend: "Extend Video",
  upscale: "Upscale / Enhance",
  motion: "Motion Control",
  lipsync: "Lip-sync / Avatar",
  reframe: "Reframe",
};

/** One role a video workflow accepts. */
export type VideoRole =
  | "first_frame"
  | "last_frame"
  | "reference_image"
  | "reference_video"
  | "reference_audio"
  | "source_video"
  | "keyframe";

/** One role-tagged input slot a workflow declares. */
export interface VideoInputSlot {
  role: VideoRole;
  label: string;
  /** Accepted asset kinds for this slot. */
  accepts: MediaKind[];
  required?: boolean;
  multiple?: boolean;
  maxCount?: number;
  hint?: string;
}

/** A workflow a model supports, with its input slots + workflow params. */
export interface VideoWorkflowSpec {
  id: VideoWorkflow;
  label: string;
  description?: string;
  inputs: VideoInputSlot[];
  params?: MediaParamSpec[];
}

/** A provider/model's video capabilities — the workflow + shared param vocab. */
export interface VideoCapabilities {
  provider: string;
  model: string;
  workflows: VideoWorkflowSpec[];
  params: MediaParamSpec[];
}

/** A selectable video model (the per-page model picker). */
export interface VideoModelInfo {
  id: string;
  label?: string;
  workflows: VideoWorkflow[];
  /** Provider-published pricing rows (label/value) for the picker. */
  rates?: MediaModelRate[];
}

/**
 * One role-tagged input on a video request. Sources are either a stored bai
 * asset (bytes are read and encoded per the adapter's needs) or an externally
 * hosted URL (for vendors that only accept URLs).
 */
export interface VideoInput {
  role: VideoRole;
  /** Stored asset id (`ast_…`). */
  assetId?: string;
  /** Externally hosted URL. */
  url?: string;
  /** Optional in-prompt tag (`@character`) used by reference workflows. */
  tag?: string;
  /** Optional time anchor (seconds or 0..1 fraction) for keyframes. */
  timestampSeconds?: number;
}

/**
 * A video-generation request — the durable job input and the `meta.gen`
 * payload stored on every produced asset.
 */
export interface VideoGenRequest {
  workflow: VideoWorkflow;
  prompt: string;
  model?: string;
  provider?: string;
  account?: string;
  /** Adapter-specific parameter values (see VideoCapabilities.params). */
  params?: Record<string, MediaParamValue>;
  /** Role-tagged references / source media. */
  inputs?: VideoInput[];
  /** Freeform tags applied to every video this request produces. */
  tags?: string[];
}

/** One page of generated videos (with the older-page cursor). */
export interface VideoGalleryPage {
  videos: Asset[];
  hasMore: boolean;
  nextCursor?: string;
  total: number;
}

/** The newest video job + its videos (the output area's seed on reload). */
export interface VideoRecent {
  job?: Job;
  videos: Asset[];
}

/** Adapter model list + workflow vocabulary (the video params UI's data). */
export interface VideoCapabilitiesResponse {
  provider: string;
  model: string;
  models: VideoModelInfo[];
  capabilities: VideoCapabilities;
}

/** One video provider the workbench can generate with (the picker's data). */
export interface VideoProviderInfo {
  id: string;
  label: string;
  defaultModel: string;
  /** The union of workflows across the provider's models. */
  workflows: VideoWorkflow[];
  models?: VideoModelInfo[];
  source?: "builtin" | "file";
  path?: string;
  providerType?: ("text" | "image" | "video")[];
  accounts?: AccountInfo[];
  connected?: boolean;
}

/** GET /api/video/providers response. */
export interface VideoProviderListResponse {
  providers: VideoProviderInfo[];
}

/**
 * A generation request — the durable job input and the `meta.gen` payload
 * stored on every produced asset. Loading a gallery item restores this shape
 * into the form; regenerating enqueues a new job with it.
 */
export interface MediaGenRequest {
  mode: MediaMode;
  prompt: string;
  model?: string;
  /**
   * Explicit provider/account target (the router gateway). When unset the
   * image workbench falls back to `config.imageGen.{provider,account}`.
   */
  provider?: string;
  account?: string;
  /** Adapter-specific parameter values (see MediaCapabilities.params). */
  params?: Record<string, MediaParamValue>;
  /** Reference image asset ids (image-to-image only). */
  referenceAssetIds?: string[];
  /** Freeform tags applied to every image this request produces. */
  tags?: string[];
}

/** Keyset cursor for the image gallery — ordered by (created_at, id) DESC. */
export interface MediaGalleryCursor {
  createdAt: string;
  id: string;
}

/** One page of generated images (with the older-page cursor). */
export interface MediaGalleryPage {
  images: Asset[];
  hasMore: boolean;
  nextCursor?: string;
  total: number;
}

/** The newest image job + its images (the output area's seed on reload). */
export interface MediaRecent {
  job?: Job;
  images: Asset[];
}

/** Adapter model list + parameter vocabulary (the params UI's data). */
export interface MediaCapabilitiesResponse {
  provider: string;
  model: string;
  models: MediaModelInfo[];
  capabilities: MediaCapabilities;
}

/**
 * One media provider the image workbench can generate with (the provider
 * picker's data). `id` is the `imageGen.provider` value; adapters own the wire
 * shape, so surfaces only need the id/label/defaults to render a selector.
 */
export interface MediaProviderInfo {
  id: string;
  label: string;
  defaultModel: string;
  modes: MediaMode[];
  /** The provider's selectable models (id/label/modes/limits). */
  models?: MediaModelInfo[];
  /** Whether the provider is a built-in adapter or a user provider file. */
  source?: "builtin" | "file";
  /** Absolute path of the defining provider file (file providers only). */
  path?: string;
  /** Declared capabilities (file providers only). */
  providerType?: ("text" | "image" | "video")[];
  /**
   * Saved accounts for this provider (ids/labels only — keys never leave the
   * server). Present on the Settings endpoint so image-only providers, which
   * are hidden from the LLM provider list, can still manage keys in the UI.
   */
  accounts?: AccountInfo[];
  /** Convenience: `(accounts?.length ?? 0) > 0` (or an env key is present). */
  connected?: boolean;
}

/** GET /api/image/providers response. */
export interface MediaProviderListResponse {
  providers: MediaProviderInfo[];
}

/** Only the models that support a workflow (used to filter the model picker). */
export function modelsForWorkflow(
  models: readonly MediaModelInfo[],
  mode: MediaMode,
): MediaModelInfo[] {
  return models.filter((m) => m.modes.includes(mode));
}

/** A distinct tag with its usage count (autocomplete + facet list). */
export interface MediaTagCount {
  tag: string;
  count: number;
}

/**
 * A generated media artifact reference carried on a tool result (the
 * `assets` payload key) so surfaces can render/act on it without another
 * lookup. Bytes live on disk (`GET /api/asset/:id/content`).
 */
export interface MediaAssetRef {
  id: AssetId;
  name: string;
  mime: string;
  bytes: number;
  width?: number;
  height?: number;
  /** Clip length in seconds (video assets only). */
  durationSeconds?: number;
}

export const MEDIA_TAG_MAX_COUNT = 10;
export const MEDIA_TAG_MAX_LENGTH = 32;

/** Normalize one tag: trim, collapse whitespace, lowercase, cap length. */
export function normalizeTag(raw: string): string {
  return raw.trim().replace(/\s+/g, " ").toLowerCase().slice(0, MEDIA_TAG_MAX_LENGTH);
}

/** Normalize a tag batch: drop empties, dedupe, cap count. */
export function normalizeTags(raw: readonly string[] | undefined): string[] {
  if (raw === undefined) return [];
  const out: string[] = [];
  for (const tag of raw) {
    const normalized = normalizeTag(tag);
    if (normalized.length === 0 || out.includes(normalized)) continue;
    out.push(normalized);
    if (out.length >= MEDIA_TAG_MAX_COUNT) break;
  }
  return out;
}

/** The default param values declared by a capability set. */
export function mediaParamDefaults(specs: readonly MediaParamSpec[]): Record<string, MediaParamValue> {
  const out: Record<string, MediaParamValue> = {};
  for (const spec of specs) {
    if (spec.default !== undefined) out[spec.key] = spec.default;
  }
  return out;
}

/**
 * Clamp/validate a param map against a capability spec: unknown keys drop,
 * enums/toggles keep only valid values, ranges/numbers clamp to their bounds,
 * and declared defaults fill anything missing. Used by the surface forms and
 * the agent tool so both always agree.
 */
export function coerceMediaParams(
  specs: readonly MediaParamSpec[],
  params: Record<string, MediaParamValue>,
): Record<string, MediaParamValue> {
  const out: Record<string, MediaParamValue> = {};
  for (const spec of specs) {
    const current = params[spec.key];
    switch (spec.kind) {
      case "enum": {
        const chosen =
          typeof current === "string" && spec.options.some((o) => o.value === current)
            ? current
            : spec.default;
        if (chosen !== undefined) out[spec.key] = chosen;
        break;
      }
      case "toggle": {
        const chosen = typeof current === "boolean" ? current : spec.default;
        if (chosen !== undefined) out[spec.key] = chosen;
        break;
      }
      case "range": {
        const chosen = typeof current === "number" ? clamp(current, spec.min, spec.max) : spec.default;
        if (chosen !== undefined) out[spec.key] = chosen;
        break;
      }
      case "number": {
        if (typeof current === "number") {
          out[spec.key] = clamp(current, spec.min ?? current, spec.max ?? current);
        } else if (spec.default !== undefined) {
          out[spec.key] = spec.default;
        }
        break;
      }
      case "text": {
        if (typeof current === "string") out[spec.key] = current;
        else if (spec.default !== undefined) out[spec.key] = spec.default;
        break;
      }
      case "list": {
        const source = Array.isArray(current)
          ? current
          : spec.default !== undefined
            ? spec.default
            : undefined;
        if (source !== undefined) {
          const items = source
            .filter((v): v is string => typeof v === "string")
            .map((v) => v.trim())
            .filter((v) => v.length > 0)
            .slice(0, spec.max ?? 64);
          if (items.length >= (spec.min ?? 0)) out[spec.key] = items;
        }
        break;
      }
    }
  }
  return out;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Fuzzy tag/search score (`0` = no match). Every whitespace-separated query
 * token must match the tag — as a prefix, a substring, or a subsequence — so
 * `gemini`, `pro`, and even `g3p` all match the tag `gemini 3 pro`. A higher
 * score means a tighter match (prefix > substring > subsequence), with a
 * bonus for the whole query appearing contiguously.
 */
export function fuzzyTagScore(tag: string, query: string): number {
  const haystack = tag.toLowerCase();
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return 1;
  const tokens = needle.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return 1;
  let total = 0;
  for (const token of tokens) {
    const score = tokenScore(haystack, token);
    if (score === 0) return 0;
    total += score;
  }
  return total + (haystack.includes(needle) ? 5 : 0);
}

/** Prefix/substring/subsequence score for one token (`0` = no match). */
function tokenScore(tag: string, token: string): number {
  const index = tag.indexOf(token);
  if (index === 0) return 100;
  if (index > 0) return 60;
  let cursor = 0;
  for (const ch of tag) {
    if (ch === token[cursor]) cursor += 1;
    if (cursor === token.length) return 20;
  }
  return 0;
}

function isParamValue(value: unknown): value is MediaParamValue {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function isMediaMode(value: unknown): value is MediaMode {
  return value === "t2i" || value === "i2i";
}

/** Read a stored generation request back off an asset's `meta.gen`, if valid. */
export function readMediaGen(meta: Record<string, unknown> | undefined): MediaGenRequest | undefined {
  const raw = meta?.gen;
  if (typeof raw !== "object" || raw === null) return undefined;
  const obj = raw as Record<string, unknown>;
  if (!isMediaMode(obj.mode) || typeof obj.prompt !== "string") return undefined;
  const params: Record<string, MediaParamValue> = {};
  if (typeof obj.params === "object" && obj.params !== null) {
    for (const [key, value] of Object.entries(obj.params as Record<string, unknown>)) {
      if (isParamValue(value)) params[key] = value;
    }
  }
  const referenceAssetIds = Array.isArray(obj.referenceAssetIds)
    ? obj.referenceAssetIds.filter((v): v is string => typeof v === "string")
    : undefined;
  const tags = Array.isArray(obj.tags) ? normalizeTags(obj.tags.filter((v): v is string => typeof v === "string")) : undefined;
  return {
    mode: obj.mode,
    prompt: obj.prompt,
    ...(typeof obj.model === "string" ? { model: obj.model } : {}),
    ...(Object.keys(params).length > 0 ? { params } : {}),
    ...(referenceAssetIds !== undefined && referenceAssetIds.length > 0 ? { referenceAssetIds } : {}),
    ...(tags !== undefined && tags.length > 0 ? { tags } : {}),
  };
}

/** Whether a string is one of the modeled video workflows. */
export function isVideoWorkflow(value: unknown): value is VideoWorkflow {
  return typeof value === "string" && (VIDEO_WORKFLOWS as readonly string[]).includes(value);
}

/** Whether a string is one of the modeled video input roles. */
export function isVideoRole(value: unknown): value is VideoRole {
  return (
    value === "first_frame" ||
    value === "last_frame" ||
    value === "reference_image" ||
    value === "reference_video" ||
    value === "reference_audio" ||
    value === "source_video" ||
    value === "keyframe"
  );
}

/** Read a stored video request back off an asset's `meta.gen`, if valid. */
export function readVideoGen(meta: Record<string, unknown> | undefined): VideoGenRequest | undefined {
  const raw = meta?.gen;
  if (typeof raw !== "object" || raw === null) return undefined;
  const obj = raw as Record<string, unknown>;
  if (!isVideoWorkflow(obj.workflow) || typeof obj.prompt !== "string") return undefined;
  const params: Record<string, MediaParamValue> = {};
  if (typeof obj.params === "object" && obj.params !== null) {
    for (const [key, value] of Object.entries(obj.params as Record<string, unknown>)) {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") params[key] = value;
      else if (Array.isArray(value) && value.every((v) => typeof v === "string")) params[key] = value as string[];
    }
  }
  const inputs: VideoInput[] = [];
  if (Array.isArray(obj.inputs)) {
    for (const entry of obj.inputs) {
      if (typeof entry !== "object" || entry === null) continue;
      const rec = entry as Record<string, unknown>;
      if (!isVideoRole(rec.role)) continue;
      const input: VideoInput = { role: rec.role };
      if (typeof rec.assetId === "string" && rec.assetId.length > 0) input.assetId = rec.assetId;
      if (typeof rec.url === "string" && rec.url.length > 0) input.url = rec.url;
      if (typeof rec.tag === "string" && rec.tag.length > 0) input.tag = rec.tag;
      if (typeof rec.timestampSeconds === "number" && Number.isFinite(rec.timestampSeconds)) {
        input.timestampSeconds = rec.timestampSeconds;
      }
      if (input.assetId !== undefined || input.url !== undefined) inputs.push(input);
    }
  }
  const tags = Array.isArray(obj.tags)
    ? normalizeTags(obj.tags.filter((v): v is string => typeof v === "string"))
    : undefined;
  return {
    workflow: obj.workflow,
    prompt: obj.prompt,
    ...(typeof obj.model === "string" ? { model: obj.model } : {}),
    ...(typeof obj.provider === "string" ? { provider: obj.provider } : {}),
    ...(typeof obj.account === "string" ? { account: obj.account } : {}),
    ...(Object.keys(params).length > 0 ? { params } : {}),
    ...(inputs.length > 0 ? { inputs } : {}),
    ...(tags !== undefined && tags.length > 0 ? { tags } : {}),
  };
}
