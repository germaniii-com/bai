import type {
  MediaParamSpec,
  VideoCapabilities,
  VideoGenRequest,
  VideoInputSlot,
  VideoModelInfo,
  VideoWorkflow,
  VideoWorkflowSpec,
} from "@bai/shared";
import { VIDEO_WORKFLOW_LABELS, VIDEO_WORKFLOWS } from "@bai/shared";
import { MediaGenError, type MediaAdapterCredentials, type MediaGenContext } from "../adapter";
import type { MediaGeneratedVideo, VideoGenAdapter, VideoGenerateResult } from "../video-adapter";
import { toGeneratedVideo } from "../video-http";
import { STUB_MP4_B64 } from "./stub-mp4";

const STUB_MODEL = "stub";

function stubBytes(): Uint8Array {
  return new Uint8Array(Buffer.from(STUB_MP4_B64, "base64"));
}

function slot(
  role: VideoInputSlot["role"],
  label: string,
  accepts: VideoInputSlot["accepts"],
  multiple = false,
): VideoInputSlot {
  return { role, label, accepts, ...(multiple ? { multiple: true, maxCount: 4 } : {}) };
}

/** The stub advertises every workflow so the whole UI is exercisable offline. */
function stubWorkflows(): VideoWorkflowSpec[] {
  const w = (id: VideoWorkflow, inputs: VideoInputSlot[]): VideoWorkflowSpec => ({
    id,
    label: VIDEO_WORKFLOW_LABELS[id],
    inputs,
  });
  const first = slot("first_frame", "First frame", ["image"]);
  const last = slot("last_frame", "Last frame", ["image"]);
  const refs = slot("reference_image", "Reference images", ["image"], true);
  const source = slot("source_video", "Source video", ["video"]);
  const audio = slot("reference_audio", "Audio", ["audio"]);
  return [
    w("t2v", []),
    w("i2v", [first]),
    w("flf2v", [first, last]),
    w("ref2v", [refs]),
    w("v2v", [source]),
    w("extend", [source]),
    w("upscale", [source]),
    w("motion", [source, slot("reference_image", "Subject image", ["image"])]),
    w("lipsync", [slot("reference_image", "Portrait image", ["image"]), audio]),
    w("reframe", [source]),
  ];
}

function stubParams(): MediaParamSpec[] {
  return [
    {
      key: "duration",
      label: "Duration",
      kind: "range",
      min: 1,
      max: 30,
      step: 1,
      default: 4,
      unit: "s",
    },
    {
      key: "resolution",
      label: "Resolution",
      kind: "enum",
      options: ["480p", "720p", "1080p", "4k"].map((v) => ({ value: v, label: v })),
      default: "720p",
    },
    {
      key: "aspect_ratio",
      label: "Aspect ratio",
      kind: "enum",
      options: ["16:9", "9:16", "1:1"].map((v) => ({ value: v, label: v })),
      default: "16:9",
    },
    { key: "generate_audio", label: "Generate audio", kind: "toggle", default: true },
    { key: "seed", label: "Seed", kind: "number", min: 0, max: 2_147_483_647 },
    { key: "shots", label: "Shot prompts", kind: "list", hint: "One prompt per shot." },
  ];
}

/**
 * The offline/keyless video adapter: a deterministic placeholder clip for every
 * workflow. Keeps the pipeline exercised (and tests hermetic) when no real
 * provider is configured, and is the fallback for any unimplemented provider.
 */
export class StubVideoAdapter implements VideoGenAdapter {
  readonly id = "stub";

  defaultModel(): string {
    return STUB_MODEL;
  }

  async listModels(): Promise<VideoModelInfo[]> {
    return [
      {
        id: STUB_MODEL,
        label: "Stub (placeholder)",
        workflows: [...VIDEO_WORKFLOWS],
        rates: [{ label: "Cost", value: "free (placeholder)" }],
      },
    ];
  }

  capabilities(): VideoCapabilities {
    return {
      provider: "stub",
      model: STUB_MODEL,
      workflows: stubWorkflows(),
      params: stubParams(),
    };
  }

  async generate(input: {
    request: VideoGenRequest;
    credentials: MediaAdapterCredentials;
    ctx: MediaGenContext;
  }): Promise<VideoGenerateResult> {
    void input.credentials;
    if (input.ctx.signal.aborted) throw new MediaGenError("Generation cancelled.", { retryable: false });
    const video: MediaGeneratedVideo = toGeneratedVideo(stubBytes(), "video/mp4", "video/mp4");
    return { videos: [video] };
  }
}
