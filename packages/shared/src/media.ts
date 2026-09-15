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

/** The two generation workflows: text-to-image and image-to-image. */
export type MediaMode = "t2i" | "i2i";
/** One value a media parameter can carry on the wire. */
export type MediaParamValue = string | number | boolean;

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
  | { key: string; label: string; kind: "text"; default?: string; placeholder?: string; hint?: string };

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

/**
 * A generation request — the durable job input and the `meta.gen` payload
 * stored on every produced asset. Loading a gallery item restores this shape
 * into the form; regenerating enqueues a new job with it.
 */
export interface MediaGenRequest {
  mode: MediaMode;
  prompt: string;
  model?: string;
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
