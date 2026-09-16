import { describe, expect, test } from "bun:test";
import { MediaGenError } from "../src";
import { deepInfraImagesAdapter } from "../src";
import { openAiImagesAdapter } from "../src";
import { recraftImagesAdapter } from "../src";
import { togetherImagesAdapter } from "../src";
import { xaiImagesAdapter } from "../src";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 7, 128, 0, 0, 4, 56]);
const PNG_B64 = Buffer.from(PNG).toString("base64");

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function ctx(readAsset: (id: string) => { mime: string; bytes: Uint8Array } | undefined = () => undefined) {
  return { signal: new AbortController().signal, readAsset };
}

describe("OpenAI images adapter", () => {
  test("t2i maps params and decodes b64", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse({ data: [{ b64_json: PNG_B64 }] });
    }) as unknown as typeof globalThis.fetch;
    const adapter = openAiImagesAdapter(fetchImpl);

    const result = await adapter.generate({
      request: { mode: "t2i", prompt: "a red panda", model: "gpt-image-2", params: { size: "1024x1024", quality: "high", count: 2 } },
      credentials: { apiKey: "sk-test" },
      ctx: ctx(),
    });

    expect(calls[0]?.url).toBe("https://api.openai.com/v1/images/generations");
    expect((calls[0]?.init?.headers as Record<string, string>).authorization).toBe("Bearer sk-test");
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(body.model).toBe("gpt-image-2");
    expect(body.quality).toBe("high");
    expect(body.size).toBe("1024x1024");
    expect(body.n).toBe(2);
    expect(result.images[0]?.mime).toBe("image/png");
  });

  test("i2i posts multipart to /images/edits", async () => {
    let body: FormData | undefined;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      body = init?.body as FormData;
      return jsonResponse({ data: [{ b64_json: PNG_B64 }] });
    }) as unknown as typeof globalThis.fetch;
    const adapter = openAiImagesAdapter(fetchImpl);

    await adapter.generate({
      request: { mode: "i2i", prompt: "watercolor it", model: "gpt-image-2", referenceAssetIds: ["ast_1"] },
      credentials: { apiKey: "k" },
      ctx: ctx((id) => (id === "ast_1" ? { mime: "image/png", bytes: PNG } : undefined)),
    });

    expect(body).toBeInstanceOf(FormData);
    expect(body?.get("model")).toBe("gpt-image-2");
    expect(body?.get("prompt")).toBe("watercolor it");
    expect(body?.has("image")).toBe(true);
  });

  test("missing key is non-retryable", async () => {
    const adapter = openAiImagesAdapter((async () => jsonResponse({})) as unknown as typeof globalThis.fetch);
    await expect(
      adapter.generate({ request: { mode: "t2i", prompt: "x" }, credentials: {}, ctx: ctx() }),
    ).rejects.toBeInstanceOf(MediaGenError);
  });
});

describe("xAI images adapter", () => {
  test("t2i reports cost from usage ticks", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({ data: [{ b64_json: PNG_B64 }], usage: { cost_in_usd_ticks: 400_000_000 } });
    }) as unknown as typeof globalThis.fetch;
    const adapter = xaiImagesAdapter(fetchImpl);

    const result = await adapter.generate({
      request: { mode: "t2i", prompt: "x", model: "grok-imagine-image-2.0", params: { aspect_ratio: "16:9", resolution: "2k", quality: "low", count: 2 } },
      credentials: { apiKey: "k" },
      ctx: ctx(),
    });

    expect(body.aspect_ratio).toBe("16:9");
    expect(body.resolution).toBe("2k");
    expect(body.quality).toBe("low");
    expect(body.n).toBe(2);
    expect(result.costUsd).toBeCloseTo(0.04);
  });

  test("i2i uses the JSON edits endpoint with an image_url block", async () => {
    let url = "";
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (u: string, init?: RequestInit) => {
      url = u;
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({ data: [{ b64_json: PNG_B64 }] });
    }) as unknown as typeof globalThis.fetch;
    const adapter = xaiImagesAdapter(fetchImpl);

    await adapter.generate({
      request: { mode: "i2i", prompt: "edit", model: "grok-imagine-image-2.0", referenceAssetIds: ["ast_1"] },
      credentials: { apiKey: "k" },
      ctx: ctx(() => ({ mime: "image/jpeg", bytes: PNG })),
    });

    expect(url).toBe("https://api.x.ai/v1/images/edits");
    const image = body.image as { url: string; type: string };
    expect(image.type).toBe("image_url");
    expect(image.url.startsWith("data:image/jpeg;base64,")).toBe(true);
  });
});

describe("Together images adapter", () => {
  test("t2i requests base64 and i2i sends reference_images", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return jsonResponse({ data: [{ b64_json: PNG_B64 }] });
    }) as unknown as typeof globalThis.fetch;
    const adapter = togetherImagesAdapter(fetchImpl);

    await adapter.generate({
      request: { mode: "t2i", prompt: "x", model: "black-forest-labs/FLUX.2-dev", params: { width: 1024, height: 768, steps: 28 } },
      credentials: { apiKey: "k" },
      ctx: ctx(),
    });
    expect(bodies[0]?.response_format).toBe("base64");
    expect(bodies[0]?.width).toBe(1024);
    expect(bodies[0]?.steps).toBe(28);

    await adapter.generate({
      request: { mode: "i2i", prompt: "y", model: "black-forest-labs/FLUX.2-dev", referenceAssetIds: ["ast_1"] },
      credentials: { apiKey: "k" },
      ctx: ctx(() => ({ mime: "image/png", bytes: PNG })),
    });
    const refs = bodies[1]?.reference_images as string[];
    expect(refs).toHaveLength(1);
    expect(refs[0]?.startsWith("data:image/png;base64,")).toBe(true);

    await adapter.generate({
      request: { mode: "i2i", prompt: "z", model: "black-forest-labs/FLUX.1-kontext-pro", referenceAssetIds: ["ast_1"] },
      credentials: { apiKey: "k" },
      ctx: ctx(() => ({ mime: "image/png", bytes: PNG })),
    });
    expect(typeof bodies[2]?.image_url).toBe("string");
  });
});

describe("DeepInfra images adapter", () => {
  test("t2i forces b64_json and is text-only", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({ data: [{ b64_json: PNG_B64 }] });
    }) as unknown as typeof globalThis.fetch;
    const adapter = deepInfraImagesAdapter(fetchImpl);

    expect(adapter.capabilities("black-forest-labs/FLUX-1-schnell").modes).toEqual(["t2i"]);
    const result = await adapter.generate({
      request: { mode: "t2i", prompt: "x", model: "black-forest-labs/FLUX-1-schnell", params: { size: "512x512" } },
      credentials: { apiKey: "k" },
      ctx: ctx(),
    });
    expect(body.response_format).toBe("b64_json");
    expect(body.size).toBe("512x512");
    expect(result.images[0]?.bytes.byteLength).toBe(PNG.byteLength);
  });
});

describe("Recraft images adapter", () => {
  test("downloads the returned url", async () => {
    const fetchImpl = (async (url: string) => {
      if (String(url).includes("images/generations")) {
        return jsonResponse({ data: [{ url: "https://cdn.test/image.png" }] });
      }
      return new Response(PNG, { headers: { "content-type": "image/png" } });
    }) as unknown as typeof globalThis.fetch;
    const adapter = recraftImagesAdapter(fetchImpl);

    const result = await adapter.generate({
      request: { mode: "t2i", prompt: "logo", model: "recraftv3", params: { size: "1024x1024" } },
      credentials: { apiKey: "k" },
      ctx: ctx(),
    });
    expect(result.images[0]?.mime).toBe("image/png");
    expect(result.images[0]?.bytes.byteLength).toBe(PNG.byteLength);
  });
});
