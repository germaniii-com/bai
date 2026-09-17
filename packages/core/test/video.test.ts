import { describe, expect, test } from "bun:test";
import {
  buildVideoAdapters,
  FalVideoAdapter,
  GeminiVeoAdapter,
  isRetryableJobError,
  MediaGenError,
  OpenRouterVideoAdapter,
  StubVideoAdapter,
  videoProbe,
  VideoWorkbench,
  videoProviderDefs,
  videoProviderInfos,
} from "../src";
import { STUB_MP4_B64 } from "../src/workbench/media/video/stub-mp4";

const MP4 = new Uint8Array(Buffer.from(STUB_MP4_B64, "base64"));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function ctx(): { signal: AbortSignal; readAsset: (id: string) => { mime: string; bytes: Uint8Array } | undefined } {
  return { signal: new AbortController().signal, readAsset: () => undefined };
}

describe("video adapter registry", () => {
  test("every implemented video provider materializes an adapter (+ the stub)", () => {
    const defs = videoProviderDefs();
    const ids = defs.map((d) => d.id).sort();
    expect(ids).toEqual([
      "fal",
      "gemini",
      "kling",
      "luma",
      "minimax-video",
      "openrouter",
      "replicate",
      "runway",
      "seedance",
      "wan",
    ]);
    const adapters = buildVideoAdapters();
    for (const def of defs) {
      expect(adapters.has(def.id)).toBe(true);
      expect(adapters.get(def.id)?.id).toBe(def.id);
    }
    expect(adapters.has("stub")).toBe(true);
  });

  test("provider infos expose workflows + models", async () => {
    const infos = await videoProviderInfos(buildVideoAdapters());
    const fal = infos.find((p) => p.id === "fal");
    expect(fal?.workflows).toContain("t2v");
    expect(fal?.models?.length ?? 0).toBeGreaterThan(0);
  });

  test("listModels carries pricing rates through the provider list", async () => {
    const infos = await videoProviderInfos(buildVideoAdapters());
    for (const id of ["fal", "openrouter", "gemini", "runway", "kling", "luma", "minimax-video", "wan", "seedance", "replicate"]) {
      const provider = infos.find((p) => p.id === id);
      const rates = provider?.models?.flatMap((m) => m.rates ?? []) ?? [];
      expect({ id, hasRates: rates.length > 0 }).toEqual({ id, hasRates: true });
    }
  });
});

describe("video container probe", () => {
  test("reads dimensions + duration from the stub mp4", () => {
    const probe = videoProbe(MP4, "video/mp4");
    expect(probe?.width).toBe(320);
    expect(probe?.height).toBe(180);
    expect(probe?.durationSeconds).toBeCloseTo(1, 1);
  });
});

describe("stub video adapter", () => {
  test("advertises every workflow and returns a playable mp4", async () => {
    const adapter = new StubVideoAdapter();
    const caps = adapter.capabilities();
    expect(caps.workflows.map((w) => w.id)).toContain("flf2v");
    expect(caps.workflows.map((w) => w.id)).toContain("lipsync");
    const result = await adapter.generate({
      request: { workflow: "i2v", prompt: "waves" },
      credentials: {},
      ctx: ctx() as never,
    });
    expect(result.videos).toHaveLength(1);
    expect(result.videos[0]?.mime).toBe("video/mp4");
    expect(result.videos[0]?.width).toBe(320);
  });
});

describe("VideoWorkbench", () => {
  test("capabilities default to the stub with the full workflow vocabulary", async () => {
    const wb = new VideoWorkbench();
    const caps = await wb.capabilities();
    expect(caps.provider).toBe("stub");
    expect(caps.capabilities.workflows).toHaveLength(10);
  });

  test("a video.generate job through the stub persists a video asset", async () => {
    const wb = new VideoWorkbench();
    const executor = wb.jobExecutors()["video.generate"]!;
    const result = await executor(
      { id: "job_test" as never, input: { workflow: "t2v", prompt: "a calm ocean" } },
      { progress: () => {}, signal: new AbortController().signal, sessionId: "sess_1", describe: () => {} },
    );
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.kind).toBe("video");
    expect(result.files[0]?.meta?.workflow).toBe("t2v");
    expect(result.files[0]?.meta?.placeholder).toBe(true);
  });
});

describe("video adapters (injected fetch)", () => {
  test("fal: submit → poll → download", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL) => {
      const u = String(url);
      calls.push(u);
      if (u.includes("queue.fal.run/fal-ai/veo3.1")) {
        return jsonResponse({ status_url: "https://queue.fal.run/s", response_url: "https://queue.fal.run/r" });
      }
      if (u === "https://queue.fal.run/s") return jsonResponse({ status: "COMPLETED" });
      if (u === "https://queue.fal.run/r") return jsonResponse({ video: { url: "https://cdn/x.mp4" } });
      return new Response(MP4, { headers: { "content-type": "video/mp4" } });
    }) as unknown as typeof globalThis.fetch;
    const adapter = new FalVideoAdapter(fetchImpl);
    const result = await adapter.generate({
      request: { workflow: "t2v", prompt: "x", model: "fal-ai/veo3.1" },
      credentials: { apiKey: "k" },
      ctx: ctx() as never,
    });
    expect(result.videos[0]?.mime).toBe("video/mp4");
    expect(calls).toContain("https://cdn/x.mp4");
  });

  test("openrouter: submit → poll → download with cost", async () => {
    const fetchImpl = (async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith("/videos")) return jsonResponse({ id: "v1", polling_url: "/api/v1/videos/v1" });
      if (u.includes("/videos/v1")) return jsonResponse({ status: "completed", unsigned_urls: ["https://cdn/x.mp4"], usage: { cost: 0.25 } });
      return new Response(MP4, { headers: { "content-type": "video/mp4" } });
    }) as unknown as typeof globalThis.fetch;
    const adapter = new OpenRouterVideoAdapter(fetchImpl);
    const result = await adapter.generate({
      request: { workflow: "t2v", prompt: "x" },
      credentials: { apiKey: "k" },
      ctx: ctx() as never,
    });
    expect(result.costUsd).toBe(0.25);
    expect(result.videos).toHaveLength(1);
  });

  test("gemini veo: operation poll → inline bytes", async () => {
    const fetchImpl = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes(":predictLongRunning")) return jsonResponse({ name: "models/veo/operations/1" });
      return jsonResponse({
        done: true,
        response: {
          generateVideoResponse: {
            generatedSamples: [{ video: { videoBytes: Buffer.from(MP4).toString("base64") } }],
          },
        },
      });
    }) as unknown as typeof globalThis.fetch;
    const adapter = new GeminiVeoAdapter(fetchImpl);
    const result = await adapter.generate({
      request: { workflow: "t2v", prompt: "x" },
      credentials: { apiKey: "k" },
      ctx: ctx() as never,
    });
    expect(result.videos[0]?.mime).toBe("video/mp4");
  });

  test("missing key is a non-retryable MediaGenError", async () => {
    const adapter = new OpenRouterVideoAdapter((async () => jsonResponse({})) as unknown as typeof globalThis.fetch);
    try {
      await adapter.generate({ request: { workflow: "t2v", prompt: "x" }, credentials: {}, ctx: ctx() as never });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(MediaGenError);
      expect(isRetryableJobError(err)).toBe(false);
    }
  });
});
