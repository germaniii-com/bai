import { describe, expect, test } from "bun:test";
import { isRetryableJobError, MediaGenError, OpenRouterMediaAdapter } from "../src";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 7, 128, 0, 0, 4, 56]);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function ctx(readAsset: (id: string) => { mime: string; bytes: Uint8Array } | undefined = () => undefined) {
  return { signal: new AbortController().signal, readAsset };
}

describe("OpenRouterMediaAdapter", () => {
  test("T2I: maps params to the /images body and decodes b64_json", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse({
        data: [{ b64_json: Buffer.from(PNG).toString("base64"), media_type: "image/png" }],
        usage: { cost: 0.04 },
      });
    }) as unknown as typeof globalThis.fetch;
    const adapter = new OpenRouterMediaAdapter(fetchImpl);

    const result = await adapter.generate({
      request: {
        mode: "t2i",
        prompt: "a red panda astronaut",
        model: "openai/gpt-image-2",
        params: { aspect_ratio: "16:9", resolution: "2K", count: 2, seed: 7, allow_fallbacks: false },
      },
      credentials: { apiKey: "sk-test", baseUrl: "https://openrouter.ai/api/v1" },
      ctx: ctx(),
    });

    expect(calls[0]?.url).toBe("https://openrouter.ai/api/v1/images");
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk-test");
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(body.model).toBe("openai/gpt-image-2");
    expect(body.prompt).toBe("a red panda astronaut");
    expect(body.aspect_ratio).toBe("16:9");
    expect(body.resolution).toBe("2K");
    expect(body.n).toBe(2);
    expect(body.seed).toBe(7);
    expect(body.provider).toEqual({ allow_fallbacks: false });
    expect(result.images).toHaveLength(1);
    expect(result.images[0]?.mime).toBe("image/png");
    expect(result.images[0]?.ext).toBe("png");
    expect(result.images[0]?.bytes.byteLength).toBe(PNG.byteLength);
    expect(result.costUsd).toBe(0.04);
  });

  test("I2I: builds a data-URL input_reference from stored bytes", async () => {
    let seen: Record<string, unknown> = {};
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      seen = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({ data: [{ b64_json: Buffer.from(PNG).toString("base64"), media_type: "image/png" }] });
    }) as unknown as typeof globalThis.fetch;
    const adapter = new OpenRouterMediaAdapter(fetchImpl);

    await adapter.generate({
      request: { mode: "i2i", prompt: "watercolor it", model: "openai/gpt-image-2", referenceAssetIds: ["ast_1"] },
      credentials: { apiKey: "k" },
      ctx: ctx((id) => (id === "ast_1" ? { mime: "image/jpeg", bytes: PNG } : undefined)),
    });

    const refs = seen.input_references as Array<{ image_url: { url: string } }>;
    expect(refs).toHaveLength(1);
    expect(refs[0]?.image_url.url.startsWith("data:image/jpeg;base64,")).toBe(true);
  });

  test("missing API key is a non-retryable MediaGenError", async () => {
    const adapter = new OpenRouterMediaAdapter((async () => jsonResponse({})) as unknown as typeof globalThis.fetch);
    await expect(
      adapter.generate({
        request: { mode: "t2i", prompt: "x" },
        credentials: {},
        ctx: ctx(),
      }),
    ).rejects.toBeInstanceOf(MediaGenError);
    try {
      await adapter.generate({ request: { mode: "t2i", prompt: "x" }, credentials: {}, ctx: ctx() });
    } catch (err) {
      expect(isRetryableJobError(err)).toBe(false);
    }
  });

  test("5xx is retryable, 400 is not", async () => {
    const make = (status: number) =>
      new OpenRouterMediaAdapter(
        (async () => jsonResponse({ error: { message: "boom" } }, status)) as unknown as typeof globalThis.fetch,
      );
    const retryable = make(503);
    const permanent = make(400);
    try {
      await retryable.generate({ request: { mode: "t2i", prompt: "x" }, credentials: { apiKey: "k" }, ctx: ctx() });
    } catch (err) {
      expect((err as MediaGenError).message).toBe("boom");
      expect(isRetryableJobError(err)).toBe(true);
    }
    try {
      await permanent.generate({ request: { mode: "t2i", prompt: "x" }, credentials: { apiKey: "k" }, ctx: ctx() });
    } catch (err) {
      expect(isRetryableJobError(err)).toBe(false);
    }
  });

  test("capabilities expose the ParamSpec vocabulary and per-model limits", () => {
    const adapter = new OpenRouterMediaAdapter();
    const caps = adapter.capabilities("google/gemini-2.5-flash-image");
    expect(caps.provider).toBe("openrouter");
    expect(caps.maxReferences).toBe(3);
    expect(caps.maxCount).toBe(1);
    expect(caps.params.map((p) => p.key)).toContain("aspect_ratio");
    expect(caps.params.map((p) => p.key)).toContain("allow_fallbacks");
  });

  test("listModels enriches curated models with live pricing (and caches)", async () => {
    let calls = 0;
    const fetchImpl = (async (url: string) => {
      calls += 1;
      if (String(url).endsWith("/models")) {
        return jsonResponse({
          data: [
            { id: "openai/gpt-image-1", pricing: { prompt: "0.000005", output_image: "0.00004" } },
            { id: "google/gemini-2.5-flash-image", pricing: { image: "0.039" } },
          ],
        });
      }
      return jsonResponse({ data: [] });
    }) as unknown as typeof globalThis.fetch;
    const adapter = new OpenRouterMediaAdapter(fetchImpl);

    const models = await adapter.listModels();
    const gpt = models.find((m) => m.id === "openai/gpt-image-1");
    expect(gpt?.rates?.map((r) => r.label)).toEqual(["In", "Out (img)"]);
    const gemini = models.find((m) => m.id === "google/gemini-2.5-flash-image");
    expect(gemini?.rates?.[0]).toEqual({ label: "Image", value: "$0.039 / image" });

    await adapter.listModels();
    expect(calls).toBe(1); // cached
  });

  test("listModels falls back to curated rates when the catalog is unavailable", async () => {
    const adapter = new OpenRouterMediaAdapter(
      (async () => {
        throw new Error("offline");
      }) as unknown as typeof globalThis.fetch,
    );
    const models = await adapter.listModels();
    const gemini = models.find((m) => m.id === "google/gemini-2.5-flash-image");
    expect(gemini?.rates?.length).toBeGreaterThan(0);
  });
});
