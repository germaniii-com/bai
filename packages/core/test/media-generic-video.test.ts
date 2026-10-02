import { describe, expect, test } from "bun:test";
import { providerFileSchema, type ProviderFile } from "@bai/shared";
import { MediaGenError, providerFileToVideoDef, VideoWorkbench } from "../src";
import { STUB_MP4_B64 } from "../src/workbench/media/video/stub-mp4";

const MP4_B64 = STUB_MP4_B64;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function ctx(readAsset: (id: string) => { mime: string; bytes: Uint8Array } | undefined = () => undefined) {
  return { signal: new AbortController().signal, readAsset };
}

const VIDEO_FILE: ProviderFile = providerFileSchema.parse({
  name: "Acme Video",
  providerType: ["video"],
  baseUrl: "https://acme.test",
  env: ["ACME_VIDEO_KEY"],
  video: {
    template: "generic",
    defaultModel: "acme-v1",
    models: [
      { id: "acme-v1", workflows: ["t2v", "i2v"] },
      { id: "acme-v2", label: "Acme V2", workflows: ["t2v"] },
    ],
    generate: {
      method: "POST",
      path: "/v1/videos",
      contentType: "json",
      body: { model: "$model", prompt: "$prompt", duration: "$param.duration" },
      references: { field: "images", encoding: "data-url", wrap: "array" },
    },
    response: { videos: "data[*]", base64: "b64", mime: "media_type", costUsd: "usage.cost" },
  },
});

function build(file: ProviderFile, fetchImpl: typeof globalThis.fetch) {
  const def = providerFileToVideoDef("acme", file, "/tmp/acme-video.json");
  if (def === undefined) throw new Error("no video def");
  return { def, adapter: def.build(fetchImpl) };
}

describe("providerFileToVideoDef", () => {
  test("a video block becomes a video-only def; files without one are dropped", () => {
    const def = providerFileToVideoDef("acme", VIDEO_FILE, "/tmp/acme-video.json");
    expect(def?.id).toBe("acme");
    expect(def?.label).toBe("Acme Video");
    expect(def?.kinds).toEqual(["video"]);
    expect(def?.mediaOnly).toBe(true);
    expect(def?.filePath).toBe("/tmp/acme-video.json");
    expect(def?.env).toEqual(["ACME_VIDEO_KEY"]);
    // No video block → undefined (image-only / text-only files).
    const imageOnly = providerFileSchema.parse({
      name: "Acme",
      providerType: ["image"],
      baseUrl: "https://acme.test",
      image: {
        template: "openai-images",
        defaultModel: "m",
        models: [{ id: "m", modes: ["t2i"] }],
      },
    });
    expect(providerFileToVideoDef("acme", imageOnly, "/tmp/x.json")).toBeUndefined();
  });

  test("schema rejects a video capability without a video block", () => {
    expect(() =>
      providerFileSchema.parse({ name: "X", providerType: ["video"], baseUrl: "https://acme.test" }),
    ).toThrow();
  });
});

describe("GenericVideoAdapter", () => {
  test("listModels + capabilities expose the file's models, workflows and params", async () => {
    const fetchImpl = (async () => jsonResponse({})) as unknown as typeof globalThis.fetch;
    const { adapter } = build(VIDEO_FILE, fetchImpl);

    expect(adapter.defaultModel()).toBe("acme-v1");
    const models = await adapter.listModels();
    expect(models.map((m) => m.id)).toEqual(["acme-v1", "acme-v2"]);
    expect(models[1]?.label).toBe("Acme V2");

    // Workflow vocabulary comes from the model's declared workflows.
    const caps = adapter.capabilities("acme-v1");
    expect(caps.provider).toBe("acme");
    expect(caps.model).toBe("acme-v1");
    expect(caps.workflows.map((w) => w.id)).toEqual(["t2v", "i2v"]);
    // i2v declares a first_frame slot; t2v has none.
    expect(caps.workflows.find((w) => w.id === "i2v")?.inputs[0]?.role).toBe("first_frame");
    expect(caps.workflows.find((w) => w.id === "t2v")?.inputs).toEqual([]);
    // Default param vocabulary (duration/resolution/seed).
    expect(caps.params.map((p) => p.key)).toEqual(["duration", "resolution", "seed"]);

    // An unknown model keeps the requested id and falls back to the safest
    // workflow set (t2v) — the catalog is a convenience, not a gate.
    const unknown = adapter.capabilities("nope");
    expect(unknown.model).toBe("nope");
    expect(unknown.workflows.map((w) => w.id)).toEqual(["t2v"]);
  });

  test("declared params replace the default vocabulary", () => {
    const withParams = providerFileSchema.parse({
      ...VIDEO_FILE,
      video: { ...VIDEO_FILE.video, params: [{ key: "fps", label: "FPS", kind: "number", default: 24 }] },
    });
    const fetchImpl = (async () => jsonResponse({})) as unknown as typeof globalThis.fetch;
    const { adapter } = build(withParams, fetchImpl);
    expect(adapter.capabilities().params.map((p) => p.key)).toEqual(["fps"]);
  });

  test("t2v: interpolates the body, sends Bearer auth, decodes base64 + cost", async () => {
    let url = "";
    let headers: Record<string, string> = {};
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (u: string, init?: RequestInit) => {
      url = u;
      headers = init?.headers as Record<string, string>;
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({ data: [{ b64: MP4_B64, media_type: "video/mp4" }], usage: { cost: 0.08 } });
    }) as unknown as typeof globalThis.fetch;
    const { adapter } = build(VIDEO_FILE, fetchImpl);

    const result = await adapter.generate({
      request: { workflow: "t2v", prompt: "a calm ocean", model: "acme-v1", params: { duration: 5 } },
      credentials: { apiKey: "sk-acme" },
      ctx: ctx(),
    });

    expect(url).toBe("https://acme.test/v1/videos");
    expect(headers.authorization).toBe("Bearer sk-acme");
    expect(body).toEqual({ model: "acme-v1", prompt: "a calm ocean", duration: 5 });
    expect(result.videos).toHaveLength(1);
    expect(result.videos[0]?.mime).toBe("video/mp4");
    expect(result.videos[0]?.bytes.byteLength).toBeGreaterThan(0);
    expect(result.costUsd).toBe(0.08);
  });

  test("a url response is downloaded inline (expiring URLs never leak to the gallery)", async () => {
    const urlFile = providerFileSchema.parse({
      ...VIDEO_FILE,
      video: {
        ...VIDEO_FILE.video,
        response: { videos: "output", url: "video_url" },
      },
    });
    const calls: string[] = [];
    const fetchImpl = (async (u: string) => {
      calls.push(String(u));
      if (String(u).endsWith("/v1/videos")) return jsonResponse({ output: { video_url: "https://cdn.acme.test/out.mp4" } });
      return new Response(new Uint8Array(Buffer.from(MP4_B64, "base64")), {
        status: 200,
        headers: { "content-type": "video/mp4" },
      });
    }) as unknown as typeof globalThis.fetch;
    const { adapter } = build(urlFile, fetchImpl);

    const result = await adapter.generate({
      request: { workflow: "t2v", prompt: "waves" },
      credentials: { apiKey: "k" },
      ctx: ctx(),
    });
    expect(calls).toEqual(["https://acme.test/v1/videos", "https://cdn.acme.test/out.mp4"]);
    expect(result.videos[0]?.mime).toBe("video/mp4");
    expect(result.costUsd).toBeUndefined();
  });

  test("i2v attaches reference frames as data URLs", async () => {
    const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (_u: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({ data: [{ b64: MP4_B64, media_type: "video/mp4" }] });
    }) as unknown as typeof globalThis.fetch;
    const { adapter } = build(VIDEO_FILE, fetchImpl);

    await adapter.generate({
      request: {
        workflow: "i2v",
        prompt: "animate",
        model: "acme-v1",
        inputs: [{ role: "reference_image", assetId: "ast_1" }],
      },
      credentials: { apiKey: "k" },
      ctx: ctx(() => ({ mime: "image/png", bytes: PNG })),
    });
    const images = body.images as string[];
    expect(images).toHaveLength(1);
    expect(images[0]?.startsWith("data:image/png;base64,")).toBe(true);
  });

  test("custom auth scheme + extra headers ride the request", async () => {
    const authed = providerFileSchema.parse({
      ...VIDEO_FILE,
      auth: { header: "x-api-key", scheme: "" },
      headers: { "X-Tenant": "acme" },
    });
    let headers: Record<string, string> = {};
    const fetchImpl = (async (_u: string, init?: RequestInit) => {
      headers = init?.headers as Record<string, string>;
      return jsonResponse({ data: [{ b64: MP4_B64, media_type: "video/mp4" }] });
    }) as unknown as typeof globalThis.fetch;
    await build(authed, fetchImpl).adapter.generate({
      request: { workflow: "t2v", prompt: "x" },
      credentials: { apiKey: "raw-key" },
      ctx: ctx(),
    });
    expect(headers["x-api-key"]).toBe("raw-key");
    expect(headers["X-Tenant"]).toBe("acme");
  });

  test("a missing API key fails fast with the env var hint", async () => {
    const fetchImpl = (async () => jsonResponse({})) as unknown as typeof globalThis.fetch;
    const { adapter } = build(VIDEO_FILE, fetchImpl);
    const err = await adapter
      .generate({ request: { workflow: "t2v", prompt: "x" }, credentials: {}, ctx: ctx() })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MediaGenError);
    expect((err as Error).message).toContain("ACME_VIDEO_KEY");
  });

  test("an empty result is a clear non-retryable error", async () => {
    const fetchImpl = (async () => jsonResponse({ data: [] })) as unknown as typeof globalThis.fetch;
    const { adapter } = build(VIDEO_FILE, fetchImpl);
    const err = await adapter
      .generate({ request: { workflow: "t2v", prompt: "x" }, credentials: { apiKey: "k" }, ctx: ctx() })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MediaGenError);
    expect((err as Error).message).toContain("returned no video");
  });
});

describe("VideoWorkbench with file-defined video providers", () => {
  test("a file video provider lists, serves capabilities, and generates an asset", async () => {
    const fetchImpl = (async (u: string) => {
      if (String(u).endsWith("/v1/videos")) return jsonResponse({ data: [{ b64: MP4_B64, media_type: "video/mp4" }] });
      return jsonResponse({});
    }) as unknown as typeof globalThis.fetch;
    const def = providerFileToVideoDef("acme", VIDEO_FILE, "/tmp/acme-video.json")!;
    const wb = new VideoWorkbench({ fetch: fetchImpl, custom: () => [def] });

    // Listed as a file-sourced provider alongside the builtins.
    const infos = await wb.providers();
    const acme = infos.find((p) => p.id === "acme");
    expect(acme?.source).toBe("file");
    expect(acme?.path).toBe("/tmp/acme-video.json");
    expect(acme?.providerType).toEqual(["video"]);
    expect(acme?.workflows).toContain("i2v");

    // Capabilities resolve to the custom adapter (not the stub).
    const caps = await wb.capabilities("acme", "acme-v1");
    expect(caps.provider).toBe("acme");
    expect(caps.capabilities.workflows.map((w) => w.id)).toEqual(["t2v", "i2v"]);
  });

  test("the job executor routes to the custom adapter and persists a video asset", async () => {
    const fetchImpl = (async (u: string) => {
      if (String(u).endsWith("/v1/videos")) return jsonResponse({ data: [{ b64: MP4_B64, media_type: "video/mp4" }] });
      return jsonResponse({});
    }) as unknown as typeof globalThis.fetch;
    const def = providerFileToVideoDef("acme", VIDEO_FILE, "/tmp/acme-video.json")!;
    const wb = new VideoWorkbench({
      fetch: fetchImpl,
      custom: () => [def],
      runtime: {
        resolveCredentials: async () => ({ apiKey: "k" }),
        readAsset: () => undefined,
      } as never,
    });

    const executor = wb.jobExecutors()["video.generate"]!;
    const result = await executor(
      { id: "job_video_file" as never, input: { workflow: "t2v", prompt: "a river", provider: "acme" } },
      { progress: () => {}, signal: new AbortController().signal, sessionId: "s1", describe: () => {} } as never,
    );
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.kind).toBe("video");
    expect(result.files[0]?.meta?.provider).toBe("acme");
    // Self-describing meta so the page can reload the exact request.
    expect((result.files[0]?.meta?.gen as { provider?: string })?.provider).toBe("acme");
  });
});
