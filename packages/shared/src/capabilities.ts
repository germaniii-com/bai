import type { ModelInfo } from "./domain";

/**
 * Per-model capability indicators (thinking / vision) rendered inline next to
 * every model name. Capabilities come strictly from the catalog metadata
 * (models.dev): unknown stays unknown — no badge is better than a wrong one.
 *
 * The labels + hints live here so the web UI and the TUI describe a model the
 * same way; only the presentation differs (Lucide glyphs + hover tooltips in
 * the web, `(think) (vision)` tags in the terminal).
 */

export type ModelCapabilityKey = "thinking" | "vision";

export interface ModelCapability {
  key: ModelCapabilityKey;
  /** Compact token appended to a model name, e.g. "think". */
  label: string;
  /** Full sentence for pointer surfaces (the web UI's hover hints). */
  hint: string;
}

/** Minimal shape the predicates read (ModelInfo-compatible). */
type CapabilityModel = Pick<ModelInfo, "reasoning" | "inputModalities">;

/** True when the model emits reasoning tokens (models.dev `reasoning`). */
export function supportsThinking(model: CapabilityModel): boolean {
  return model.reasoning === true;
}

/**
 * True when the model accepts image input. Uses the explicit models.dev
 * `inputModalities` list — `supportsAttachments` also covers PDFs, so it is
 * deliberately NOT treated as a vision signal. Modalities absent → unknown
 * (no badge).
 */
export function supportsVision(model: CapabilityModel): boolean {
  return model.inputModalities?.includes("image") === true;
}

/** Label + hover hint per capability, in display order. */
const CAPABILITY_META: Record<ModelCapabilityKey, { label: string; hint: string }> = {
  thinking: { label: "think", hint: "This model supports thinking" },
  vision: { label: "vision", hint: "This model supports vision" },
};

/** Capabilities attested by the catalog, in stable display order. */
export function modelCapabilities(model: CapabilityModel): ModelCapability[] {
  const out: ModelCapability[] = [];
  if (supportsThinking(model)) out.push({ key: "thinking", ...CAPABILITY_META.thinking });
  if (supportsVision(model)) out.push({ key: "vision", ...CAPABILITY_META.vision });
  return out;
}
