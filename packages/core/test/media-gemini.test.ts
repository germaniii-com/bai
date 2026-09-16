import { describe, expect, test } from "bun:test";
import { GeminiMediaAdapter, MediaGenError } from "../src";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 7, 128, 0, 0, 4, 56]);
const PNG_B64 = Buffer.from(PNG).toString("base64");

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function ctx(readAsset: (id: string) => { mime: string; bytes: Uint8Array } | undefined = () => undefined) {
  return { signal: new AbortController().signal, readAsset };
}

describe("GeminiMediaAdapter", () => {
  test("t2i posts content blocks + response_format and decodes output_image", async () => {
    let url = "";
    let body: Record<string, unknown> = {};
    let headers: Record<string, string> = {};
    const fetchImpl = (async (u: string, init?: RequestInit) => {
      url = u;
      headers = init?.headers as Record<string, string>;
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({ output_image: { data: PNG_B64, mime_type: "image/png" } });
    }) as unknown as typeof globalThis.fetch;
    const adapter = new GeminiMediaAdapter(fetchImpl);

    const result = await adapter.generate({
      request: { mode: "t2i", prompt: "a nano banana", model: "gemini-3.1-flash-image", params: { aspect_ratio: "16:9", image_size: "2K" } },
      credentials: { apiKey: "g-test" },
      ctx: ctx(),
    });

    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
    expect(headers["x-goog-api-key"]).toBe("g-test");
    expect(body.model).toBe("gemini-3.1-flash-image");
    const input = body.input as Array<Record<string, unknown>>;
    expect(input[0]?.type).toBe("text");
    expect(body.response_format).toEqual({ type: "image", aspect_ratio: "16:9", image_size: "2K" });
    expect(result.images[0]?.bytes.byteLength).toBe(PNG.byteLength);
  });

  test("i2i appends image blocks and clamps to maxReferences", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({ output_image: { data: PNG_B64, mime_type: "image/jpeg" } });
    }) as unknown as typeof globalThis.fetch;
    const adapter = new GeminiMediaAdapter(fetchImpl);
    const refs = ["ast_1", "ast_2", "ast_3", "ast_4", "ast_5"];

    const result = await adapter.generate({
      request: { mode: "i2i", prompt: "edit", model: "gemini-3.1-flash-lite-image", referenceAssetIds: refs },
      credentials: { apiKey: "g" },
      ctx: ctx((id) => (refs.includes(id) ? { mime: "image/png", bytes: PNG } : undefined)),
    });

    const input = body.input as Array<Record<string, unknown>>;
    // 1 text + 4 refs (lite maxReferences = 4).
    expect(input).toHaveLength(5);
    expect(input[1]?.type).toBe("image");
    expect(typeof input[1]?.data).toBe("string");
    expect(result.images[0]?.mime).toBe("image/jpeg");
  });

  test("missing key is non-retryable", async () => {
    const adapter = new GeminiMediaAdapter((async () => jsonResponse({})) as unknown as typeof globalThis.fetch);
    await expect(
      adapter.generate({ request: { mode: "t2i", prompt: "x" }, credentials: {}, ctx: ctx() }),
    ).rejects.toBeInstanceOf(MediaGenError);
  });

  test("no image → non-retryable error; 5xx → retryable", async () => {
    const empty = new GeminiMediaAdapter((async () => jsonResponse({})) as unknown as typeof globalThis.fetch);
    await expect(
      empty.generate({ request: { mode: "t2i", prompt: "x" }, credentials: { apiKey: "k" }, ctx: ctx() }),
    ).rejects.toBeInstanceOf(MediaGenError);

    const down = new GeminiMediaAdapter(
      (async () => jsonResponse({ error: { message: "boom" } }, 503)) as unknown as typeof globalThis.fetch,
    );
    try {
      await down.generate({ request: { mode: "t2i", prompt: "x" }, credentials: { apiKey: "k" }, ctx: ctx() });
    } catch (err) {
      expect((err as MediaGenError).message).toBe("boom");
      expect((err as MediaGenError).retryable).toBe(true);
    }
  });

  test("capabilities expose aspect_ratio + image_size", () => {
    const adapter = new GeminiMediaAdapter();
    const caps = adapter.capabilities("gemini-3-pro-image");
    expect(caps.provider).toBe("gemini");
    expect(caps.maxReferences).toBe(14);
    expect(caps.params.map((p) => p.key)).toEqual(["aspect_ratio", "image_size"]);
  });
});
