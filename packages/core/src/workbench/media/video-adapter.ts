import type { VideoCapabilities, VideoGenRequest, VideoModelInfo } from "@bai/shared";
import type { MediaAdapterCredentials, MediaGenContext } from "./adapter";

/**
 * One video produced by an adapter. Bytes only (the workbench adds metadata);
 * `durationSeconds`/`width`/`height` come from the provider response or the
 * container probe. `poster` is an optional still frame for gallery cards.
 */
export interface MediaGeneratedVideo {
  mime: string;
  ext: string;
  bytes: Uint8Array;
  durationSeconds?: number;
  width?: number;
  height?: number;
  poster?: { mime: string; ext: string; bytes: Uint8Array };
}

/** An adapter's generation result: the videos plus the provider's USD cost. */
export interface VideoGenerateResult {
  videos: MediaGeneratedVideo[];
  /** Total request cost in USD when the provider reports it. */
  costUsd?: number;
}

/**
 * A video-generation adapter. Parallel to {@link MediaGenAdapter} but
 * workflow-driven: the model declares which workflows it supports (t2v, i2v,
 * flf2v, ref2v, v2v, extend, upscale, motion, lipsync, reframe) with each
 * workflow's role-tagged input slots, and the page renders them generically.
 * Adapters declare only what they can serve, and error clearly otherwise.
 */
export interface VideoGenAdapter {
  readonly id: string;
  /** Fallback model when neither the request nor config names one. */
  defaultModel(): string;
  /** Curated selectable models (with their workflow lists + rates). */
  listModels(): Promise<VideoModelInfo[]>;
  /** The workflow/param vocabulary for a (possibly default) model. */
  capabilities(model?: string): VideoCapabilities;
  generate(input: {
    request: VideoGenRequest;
    credentials: MediaAdapterCredentials;
    ctx: MediaGenContext;
  }): Promise<VideoGenerateResult>;
}
