import type { MediaCapabilities, MediaGenRequest, MediaModelInfo, MediaParamSpec } from "@bai/shared";
import { fnv1a, solidPng } from "../../jobs/png";
import type { MediaAdapterCredentials, MediaGenAdapter, MediaGenContext, MediaGenerateResult, MediaGeneratedImage } from "./adapter";

const STUB_MODEL = "stub";
const STUB_SIZES = ["256x256", "512x512", "1024x1024", "1024x1536", "1536x1024"] as const;

/**
 * The offline/keyless adapter: deterministic solid-color PNGs. Keeps the
 * pipeline exercised (and tests hermetic) when no real provider is
 * configured, and is the fallback for any provider bai doesn't implement yet.
 */
export class StubMediaAdapter implements MediaGenAdapter {
  readonly id = "stub";

  defaultModel(): string {
    return STUB_MODEL;
  }

  async listModels(): Promise<MediaModelInfo[]> {
    return [
      {
        id: STUB_MODEL,
        label: "Stub (placeholder)",
        modes: ["t2i", "i2i"],
        maxReferences: 1,
        maxCount: 4,
        rates: [{ label: "Cost", value: "free (placeholder)" }],
      },
    ];
  }

  capabilities(): MediaCapabilities {
    const params: MediaParamSpec[] = [
      { key: "count", label: "Number of generations", kind: "range", min: 1, max: 4, step: 1, default: 1 },
      {
        key: "size",
        label: "Size",
        kind: "enum",
        options: STUB_SIZES.map((s) => ({ value: s, label: s })),
        default: "512x512",
      },
    ];
    return {
      provider: "stub",
      model: STUB_MODEL,
      modes: ["t2i", "i2i"],
      maxReferences: 1,
      maxCount: 4,
      params,
    };
  }

  async generate(input: {
    request: MediaGenRequest;
    credentials: MediaAdapterCredentials;
    ctx: MediaGenContext;
  }): Promise<MediaGenerateResult> {
    void input.credentials;
    void input.ctx;
    const params = input.request.params ?? {};
    const rawCount = typeof params.count === "number" ? params.count : 1;
    const count = Math.min(Math.max(Math.round(rawCount), 1), 4);
    const size = typeof params.size === "string" ? params.size : "512x512";
    const [width, height] = parseSize(size);
    const images: MediaGeneratedImage[] = [];
    for (let i = 0; i < count; i++) {
      const seed = fnv1a(`${input.request.prompt}#${i}`);
      const rgb: [number, number, number] = [
        (seed & 0xff) as number,
        ((seed >> 8) & 0xff) as number,
        ((seed >> 16) & 0xff) as number,
      ];
      images.push({ mime: "image/png", ext: "png", bytes: solidPng(width, height, rgb) });
    }
    return { images };
  }
}

function parseSize(size: string): [number, number] {
  const match = /^(\d+)x(\d+)$/.exec(size);
  if (!match) return [512, 512];
  const w = Number(match[1]);
  const h = Number(match[2]);
  return [Math.min(w, 2048), Math.min(h, 2048)];
}
