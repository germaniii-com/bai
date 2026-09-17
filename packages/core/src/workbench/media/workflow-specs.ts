import { VIDEO_WORKFLOW_LABELS } from "@bai/shared";
import type { MediaParamSpec, VideoInputSlot, VideoWorkflow, VideoWorkflowSpec } from "@bai/shared";

/**
 * Reusable workflow/input-slot building blocks so adapters declare their
 * capabilities as data. `workflow("i2v", [FIRST_FRAME])` etc.
 */

export const FIRST_FRAME: VideoInputSlot = {
  role: "first_frame",
  label: "First frame",
  accepts: ["image"],
  required: true,
  hint: "The image the clip begins on.",
};

export const LAST_FRAME: VideoInputSlot = {
  role: "last_frame",
  label: "Last frame",
  accepts: ["image"],
  hint: "The image the clip must end on.",
};

export function referenceImages(maxCount = 4, required = false): VideoInputSlot {
  return {
    role: "reference_image",
    label: "Reference images",
    accepts: ["image"],
    multiple: true,
    maxCount,
    ...(required ? { required: true } : {}),
    hint: "Subject/style references (not frame-locked).",
  };
}

export function referenceVideos(maxCount = 3): VideoInputSlot {
  return {
    role: "reference_video",
    label: "Reference videos",
    accepts: ["video"],
    multiple: true,
    maxCount,
    hint: "Motion/style references.",
  };
}

export function referenceAudio(maxCount = 1): VideoInputSlot {
  return {
    role: "reference_audio",
    label: "Reference audio",
    accepts: ["audio"],
    multiple: true,
    maxCount,
    hint: "Voice/music conditioning.",
  };
}

export const SOURCE_VIDEO: VideoInputSlot = {
  role: "source_video",
  label: "Source video",
  accepts: ["video"],
  required: true,
  hint: "The clip to transform/extend/upscale.",
};

export function sourceVideoParam(label = "Source video"): VideoInputSlot {
  return { role: "source_video", label, accepts: ["video"], required: true };
}

export const SUBJECT_IMAGE: VideoInputSlot = {
  role: "reference_image",
  label: "Subject image",
  accepts: ["image"],
  required: true,
  hint: "The character/subject to drive.",
};

export const PORTRAIT_IMAGE: VideoInputSlot = {
  role: "reference_image",
  label: "Portrait image",
  accepts: ["image"],
  required: true,
  hint: "The face/avatar to lip-sync.",
};

export const REQUIRED_AUDIO: VideoInputSlot = {
  role: "reference_audio",
  label: "Audio",
  accepts: ["audio"],
  required: true,
  hint: "The speech/music to sync to.",
};

// --- reusable generation parameter vocabularies -----------------------------

export function durationParam(min = 1, max = 15, def = 8): MediaParamSpec {
  return { key: "duration", label: "Duration", kind: "range", min, max, step: 1, default: def, unit: "s" };
}

export function resolutionParam(options: string[] = ["480p", "720p", "1080p"], def = "720p"): MediaParamSpec {
  return {
    key: "resolution",
    label: "Resolution",
    kind: "enum",
    options: options.map((v) => ({ value: v, label: v })),
    default: def,
  };
}

export function aspectParam(options: string[] = ["16:9", "9:16", "1:1"], def = "16:9"): MediaParamSpec {
  return {
    key: "aspect_ratio",
    label: "Aspect ratio",
    kind: "enum",
    options: options.map((v) => ({ value: v, label: v })),
    default: def,
  };
}

export const seedParam: MediaParamSpec = { key: "seed", label: "Seed", kind: "number", min: 0, max: 2_147_483_647 };
export const generateAudioParam: MediaParamSpec = {
  key: "generate_audio",
  label: "Generate audio",
  kind: "toggle",
  default: true,
};
export const negativePromptParam: MediaParamSpec = {
  key: "negative_prompt",
  label: "Negative prompt",
  kind: "text",
};
export const shotsParam: MediaParamSpec = {
  key: "shots",
  label: "Shot prompts",
  kind: "list",
  hint: "One prompt per shot (multi-shot models).",
};
export const upscaleFactorParam: MediaParamSpec = {
  key: "upscale_factor",
  label: "Upscale factor",
  kind: "range",
  min: 1,
  max: 4,
  step: 1,
  default: 2,
};
export const targetFpsParam: MediaParamSpec = {
  key: "target_fps",
  label: "Target FPS",
  kind: "range",
  min: 8,
  max: 60,
  step: 1,
  hint: "Interpolates frames when higher than the source.",
};
export const editStrengthParam: MediaParamSpec = {
  key: "strength",
  label: "Edit strength",
  kind: "enum",
  options: ["adhere", "flex", "reimagine"].map((v) => ({ value: v, label: v })),
  default: "flex",
};

/** Build one workflow spec (label + description default from the vocabulary). */
export function workflow(
  id: VideoWorkflow,
  inputs: VideoInputSlot[],
  params?: MediaParamSpec[],
  description?: string,
): VideoWorkflowSpec {
  return {
    id,
    label: VIDEO_WORKFLOW_LABELS[id],
    ...(description !== undefined ? { description } : {}),
    inputs,
    ...(params !== undefined && params.length > 0 ? { params } : {}),
  };
}

export { VIDEO_WORKFLOW_LABELS };
