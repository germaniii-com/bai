import { describe, expect, test } from "bun:test";
import { IdeogramMediaAdapter, MediaGenError, MinimaxMediaAdapter, StabilityMediaAdapter } from "../src";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 7, 128, 0, 0, 4, 56]);
const PNG_B64 = Buffer.from(PNG).toString("base64");

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function ctx(readAsset: (id: string) => { mime: string; bytes: Uint8Array } | undefined = () => undefined) {
  return { signal: new AbortController().signal, readAsset };
}

describe("StabilityMediaAdapter", () => {
  test("t2i posts multipart and reads raw bytes back", async () => {
    let url = "";
    let headers: Record<string, string> = {};
    let form: FormData | undefined;
    const fetchImpl = (async (u: string, init?: RequestInit) => {
      url = u;
      headers = init?.headers as Record<string, string>;
      form = init?.body as FormData;
      return new Response(PNG, { headers: { "content-type": "image/png" } });
    }) as unknown as typeof globalThis.fetch;
    const adapter = new StabilityMediaAdapter(fetchImpl);

    const result = await adapter.generate({
      request: { mode: "t2i", prompt: "a lighthouse", model: "core", params: { aspect_ratio: "16:9", output_format: "png" } },
      credentials: { apiKey: "sk-stab" },
      ctx: ctx(),
    });

    expect(url).toBe("https://api.stability.ai/v2beta/stable-image/generate/core");
    expect(headers.authorization).toBe("Bearer sk-stab");
    expect(form?.get("prompt")).toBe("a lighthouse");
    expect(form?.get("aspect_ratio")).toBe("16:9");
    expect(result.images[0]?.bytes.byteLength).toBe(PNG.byteLength);
  });

  test("i2i adds image + mode + strength", async () => {
    let form: FormData | undefined;
    const fetchImpl = (async (_u: string, init?: RequestInit) => {
      form = init?.body as FormData;
      return new Response(PNG, { headers: { "content-type": "image/png" } });
    }) as unknown as typeof globalThis.fetch;
    const adapter = new StabilityMediaAdapter(fetchImpl);

    await adapter.generate({
      request: { mode: "i2i", prompt: "edit", model: "sd3.5", referenceAssetIds: ["ast_1"], params: { strength: 0.4 } },
      credentials: { apiKey: "k" },
      ctx: ctx(() => ({ mime: "image/png", bytes: PNG })),
    });
    expect(form?.get("mode")).toBe("image-to-image");
    expect(form?.get("strength")).toBe("0.4");
    expect(form?.has("image")).toBe(true);
  });

  test("missing key is non-retryable", async () => {
    const adapter = new StabilityMediaAdapter((async () => jsonResponse({})) as unknown as typeof globalThis.fetch);
    await expect(adapter.generate({ request: { mode: "t2i", prompt: "x" }, credentials: {}, ctx: ctx() })).rejects.toBeInstanceOf(
      MediaGenError,
    );
  });
});

describe("IdeogramMediaAdapter", () => {
  test("t2i posts multipart with Api-Key and downloads result urls", async () => {
    let headers: Record<string, string> = {};
    let form: FormData | undefined;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (String(url).includes("/v1/ideogram-v3/generate")) {
        headers = init?.headers as Record<string, string>;
        form = init?.body as FormData;
        return jsonResponse({ created: "now", data: [{ url: "https://ideogram.test/a.png" }] });
      }
      return new Response(PNG, { headers: { "content-type": "image/png" } });
    }) as unknown as typeof globalThis.fetch;
    const adapter = new IdeogramMediaAdapter(fetchImpl);

    const result = await adapter.generate({
      request: { mode: "t2i", prompt: "poster", model: "ideogram-v3", params: { aspect_ratio: "16x9", count: 2 } },
      credentials: { apiKey: "id-key" },
      ctx: ctx(),
    });
    expect(headers["Api-Key"]).toBe("id-key");
    expect(form?.get("num_images")).toBe("2");
    expect(form?.get("aspect_ratio")).toBe("16x9");
    expect(result.images[0]?.bytes.byteLength).toBe(PNG.byteLength);
  });

  test("i2i attaches character_reference_images", async () => {
    let form: FormData | undefined;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (String(url).includes("/generate")) {
        form = init?.body as FormData;
        return jsonResponse({ data: [{ url: "https://ideogram.test/b.png" }] });
      }
      return new Response(PNG, { headers: { "content-type": "image/png" } });
    }) as unknown as typeof globalThis.fetch;
    const adapter = new IdeogramMediaAdapter(fetchImpl);
    await adapter.generate({
      request: { mode: "i2i", prompt: "edit", model: "ideogram-v3", referenceAssetIds: ["ast_1"] },
      credentials: { apiKey: "k" },
      ctx: ctx(() => ({ mime: "image/png", bytes: PNG })),
    });
    expect(form?.has("character_reference_images")).toBe(true);
  });
});

describe("MinimaxMediaAdapter", () => {
  test("t2i decodes data.image_base64[]", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({ data: { image_base64: [PNG_B64] } });
    }) as unknown as typeof globalThis.fetch;
    const adapter = new MinimaxMediaAdapter(fetchImpl);

    const result = await adapter.generate({
      request: { mode: "t2i", prompt: "x", model: "image-01", params: { aspect_ratio: "16:9", count: 1 } },
      credentials: { apiKey: "mm" },
      ctx: ctx(),
    });
    expect(body.model).toBe("image-01");
    expect(body.response_format).toBe("base64");
    expect(body.aspect_ratio).toBe("16:9");
    expect(result.images[0]?.bytes.byteLength).toBe(PNG.byteLength);
    expect(adapter.capabilities("image-01").modes).toEqual(["t2i"]);
  });

  test("i2i is rejected (needs a hosted URL)", async () => {
    const adapter = new MinimaxMediaAdapter((async () => jsonResponse({})) as unknown as typeof globalThis.fetch);
    await expect(
      adapter.generate({
        request: { mode: "i2i", prompt: "x", referenceAssetIds: ["ast_1"] },
        credentials: { apiKey: "k" },
        ctx: ctx(() => ({ mime: "image/png", bytes: PNG })),
      }),
    ).rejects.toThrow(/hosted/i);
  });
});
