import { describe, expect, test } from "bun:test";
import { BflMediaAdapter, FalMediaAdapter, MediaGenError, ReplicateMediaAdapter } from "../src";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 7, 128, 0, 0, 4, 56]);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function ctx(
  readAsset: (id: string) => { mime: string; bytes: Uint8Array } | undefined = () => undefined,
  signal: AbortSignal = new AbortController().signal,
) {
  return { signal, readAsset };
}

interface Call {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

function router(
  routes: Array<{ match: (url: string, method: string) => boolean; reply: () => Response | Promise<Response> }>,
  calls: Call[],
): typeof globalThis.fetch {
  return (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({
      url: String(url),
      method,
      body: init?.body,
      headers: (init?.headers as Record<string, string>) ?? {},
    });
    for (const route of routes) {
      if (route.match(String(url), method)) return route.reply();
    }
    throw new Error(`unexpected request: ${method} ${url}`);
  }) as unknown as typeof globalThis.fetch;
}

describe("BflMediaAdapter", () => {
  test("submit → poll → download result.sample", async () => {
    const calls: Call[] = [];
    const fetchImpl = router(
      [
        { match: (u, m) => m === "POST" && u.endsWith("/v1/flux-2-pro"), reply: () => jsonResponse({ id: "r1", polling_url: "https://poll.test/r1" }) },
        { match: (u) => u === "https://poll.test/r1", reply: () => jsonResponse({ status: "Ready", result: { sample: "https://delivery.test/img.png" } }) },
        { match: (u) => u === "https://delivery.test/img.png", reply: () => new Response(PNG, { headers: { "content-type": "image/png" } }) },
      ],
      calls,
    );
    const adapter = new BflMediaAdapter(fetchImpl);

    const result = await adapter.generate({
      request: { mode: "t2i", prompt: "a cat", model: "flux-2-pro", params: { width: 1000, height: 1000, seed: 5 } },
      credentials: { apiKey: "bfl-key" },
      ctx: ctx(),
    });

    expect(calls[0]?.url).toBe("https://api.bfl.ai/v1/flux-2-pro");
    expect(calls[0]?.headers["x-key"]).toBe("bfl-key");
    const body = JSON.parse(String(calls[0]?.body)) as Record<string, unknown>;
    expect(body.width).toBe(992); // rounded to a multiple of 16
    expect(body.seed).toBe(5);
    expect(result.images[0]?.bytes.byteLength).toBe(PNG.byteLength);
  });

  test("i2i passes base64 input_image", async () => {
    const calls: Call[] = [];
    const fetchImpl = router(
      [
        { match: (u, m) => m === "POST" && u.includes("/v1/flux-kontext-pro"), reply: () => jsonResponse({ polling_url: "https://poll.test/r2" }) },
        { match: (u) => u === "https://poll.test/r2", reply: () => jsonResponse({ status: "Ready", result: { sample: "https://delivery.test/x.png" } }) },
        { match: (u) => u === "https://delivery.test/x.png", reply: () => new Response(PNG, { headers: { "content-type": "image/png" } }) },
      ],
      calls,
    );
    const adapter = new BflMediaAdapter(fetchImpl);
    await adapter.generate({
      request: { mode: "i2i", prompt: "edit", model: "flux-kontext-pro", referenceAssetIds: ["ast_1"] },
      credentials: { apiKey: "k" },
      ctx: ctx(() => ({ mime: "image/png", bytes: PNG })),
    });
    const body = JSON.parse(String(calls[0]?.body)) as Record<string, unknown>;
    expect(typeof body.input_image).toBe("string");
    expect((body.input_image as string).startsWith("iVBOR")).toBe(true);
  });

  test("failed status → non-retryable error; missing key → error", async () => {
    const calls: Call[] = [];
    const fetchImpl = router(
      [
        { match: (u, m) => m === "POST", reply: () => jsonResponse({ polling_url: "https://poll.test/f" }) },
        { match: (u) => u === "https://poll.test/f", reply: () => jsonResponse({ status: "Failed", result: { error: "nope" } }) },
      ],
      calls,
    );
    const adapter = new BflMediaAdapter(fetchImpl);
    try {
      await adapter.generate({ request: { mode: "t2i", prompt: "x" }, credentials: { apiKey: "k" }, ctx: ctx() });
    } catch (err) {
      expect((err as MediaGenError).message).toBe("nope");
      expect((err as MediaGenError).retryable).toBe(false);
    }
    await expect(
      adapter.generate({ request: { mode: "t2i", prompt: "x" }, credentials: {}, ctx: ctx() }),
    ).rejects.toBeInstanceOf(MediaGenError);
  });
});

describe("FalMediaAdapter", () => {
  test("submit → poll COMPLETED → download images", async () => {
    const calls: Call[] = [];
    const fetchImpl = router(
      [
        { match: (u, m) => m === "POST" && u.endsWith("/fal-ai/flux/schnell"), reply: () => jsonResponse({ request_id: "q1", status_url: "https://status.test/q1", response_url: "https://result.test/q1" }) },
        { match: (u) => u === "https://status.test/q1", reply: () => jsonResponse({ status: "COMPLETED" }) },
        { match: (u) => u === "https://result.test/q1", reply: () => jsonResponse({ images: [{ url: "https://fal.media/a.png" }] }) },
        { match: (u) => u === "https://fal.media/a.png", reply: () => new Response(PNG, { headers: { "content-type": "image/png" } }) },
      ],
      calls,
    );
    const adapter = new FalMediaAdapter(fetchImpl);

    const result = await adapter.generate({
      request: { mode: "t2i", prompt: "sunset", model: "fal-ai/flux/schnell", params: { image_size: "landscape_16_9", num_inference_steps: 4 } },
      credentials: { apiKey: "fal-key" },
      ctx: ctx(),
    });

    expect(calls[0]?.headers.authorization).toBe("Key fal-key");
    const body = JSON.parse(String(calls[0]?.body)) as Record<string, unknown>;
    expect(body.prompt).toBe("sunset");
    expect(body.image_size).toBe("landscape_16_9");
    expect(result.images[0]?.mime).toBe("image/png");
  });

  test("i2i is rejected; a COMPLETED status with error fails", async () => {
    const calls: Call[] = [];
    const fetchImpl = router(
      [
        { match: (u, m) => m === "POST", reply: () => jsonResponse({ status_url: "https://status.test/e", response_url: "https://result.test/e" }) },
        { match: (u) => u === "https://status.test/e", reply: () => jsonResponse({ status: "COMPLETED", error: "nsfw" }) },
      ],
      calls,
    );
    const adapter = new FalMediaAdapter(fetchImpl);
    await expect(
      adapter.generate({
        request: { mode: "i2i", prompt: "x", referenceAssetIds: ["ast_1"] },
        credentials: { apiKey: "k" },
        ctx: ctx(() => ({ mime: "image/png", bytes: PNG })),
      }),
    ).rejects.toBeInstanceOf(MediaGenError);

    await expect(
      adapter.generate({ request: { mode: "t2i", prompt: "x" }, credentials: { apiKey: "k" }, ctx: ctx() }),
    ).rejects.toThrow("nsfw");
  });
});

describe("ReplicateMediaAdapter", () => {
  test("Prefer: wait + poll to succeeded, then download output", async () => {
    const calls: Call[] = [];
    const fetchImpl = router(
      [
        { match: (u, m) => m === "POST" && u.endsWith("/predictions"), reply: () => jsonResponse({ id: "p1", status: "processing" }) },
        { match: (u) => u === "https://api.replicate.com/v1/predictions/p1", reply: () => jsonResponse({ id: "p1", status: "succeeded", output: "https://replicate.delivery/a.png" }) },
        { match: (u) => u === "https://replicate.delivery/a.png", reply: () => new Response(PNG, { headers: { "content-type": "image/png" } }) },
      ],
      calls,
    );
    const adapter = new ReplicateMediaAdapter(fetchImpl);

    const result = await adapter.generate({
      request: { mode: "t2i", prompt: "x", model: "black-forest-labs/flux-schnell", params: { aspect_ratio: "16:9", count: 1 } },
      credentials: { apiKey: "r8-key" },
      ctx: ctx(),
    });

    expect(calls[0]?.headers.prefer).toBe("wait");
    expect(calls[0]?.headers.authorization).toBe("Bearer r8-key");
    const body = JSON.parse(String(calls[0]?.body)) as { model: string; input: Record<string, unknown> };
    expect(body.model).toBe("black-forest-labs/flux-schnell");
    expect(body.input.aspect_ratio).toBe("16:9");
    expect(result.images[0]?.bytes.byteLength).toBe(PNG.byteLength);
  });

  test("small i2i ref rides as a data URL", async () => {
    const calls: Call[] = [];
    const fetchImpl = router(
      [
        { match: (u, m) => m === "POST" && u.endsWith("/predictions"), reply: () => jsonResponse({ id: "p2", status: "succeeded", output: ["https://replicate.delivery/b.png"] }) },
        { match: (u) => u === "https://replicate.delivery/b.png", reply: () => new Response(PNG, { headers: { "content-type": "image/png" } }) },
      ],
      calls,
    );
    const adapter = new ReplicateMediaAdapter(fetchImpl);
    await adapter.generate({
      request: { mode: "i2i", prompt: "edit", model: "black-forest-labs/flux-kontext-pro", referenceAssetIds: ["ast_1"] },
      credentials: { apiKey: "k" },
      ctx: ctx(() => ({ mime: "image/png", bytes: PNG })),
    });
    const body = JSON.parse(String(calls[0]?.body)) as { input: Record<string, unknown> };
    expect((body.input.input_image as string).startsWith("data:image/png;base64,")).toBe(true);
  });

  test("large i2i ref uploads to the Files API", async () => {
    const calls: Call[] = [];
    const big = new Uint8Array(300 * 1024);
    const fetchImpl = router(
      [
        { match: (u, m) => m === "POST" && u.endsWith("/v1/files"), reply: () => jsonResponse({ urls: { get: "https://api.replicate.com/v1/files/abc" } }) },
        { match: (u, m) => m === "POST" && u.endsWith("/predictions"), reply: () => jsonResponse({ id: "p3", status: "succeeded", output: "https://replicate.delivery/c.png" }) },
        { match: (u) => u === "https://replicate.delivery/c.png", reply: () => new Response(PNG, { headers: { "content-type": "image/png" } }) },
      ],
      calls,
    );
    const adapter = new ReplicateMediaAdapter(fetchImpl);
    await adapter.generate({
      request: { mode: "i2i", prompt: "edit", model: "black-forest-labs/flux-kontext-max", referenceAssetIds: ["ast_big"] },
      credentials: { apiKey: "k" },
      ctx: ctx(() => ({ mime: "image/png", bytes: big })),
    });
    expect(calls[0]?.url).toBe("https://api.replicate.com/v1/files");
    const prediction = calls.find((c) => c.url.endsWith("/predictions"));
    const body = JSON.parse(String(prediction?.body)) as { input: Record<string, unknown> };
    expect(body.input.input_image).toBe("https://api.replicate.com/v1/files/abc");
  });

  test("failed prediction is non-retryable", async () => {
    const fetchImpl = router(
      [{ match: (u, m) => m === "POST" && u.endsWith("/predictions"), reply: () => jsonResponse({ id: "p4", status: "failed", error: "boom" }) }],
      [],
    );
    const adapter = new ReplicateMediaAdapter(fetchImpl);
    try {
      await adapter.generate({ request: { mode: "t2i", prompt: "x" }, credentials: { apiKey: "k" }, ctx: ctx() });
    } catch (err) {
      expect((err as MediaGenError).message).toBe("boom");
      expect((err as MediaGenError).retryable).toBe(false);
    }
  });
});

describe("async cancellation", () => {
  test("a pre-aborted signal stops polling", async () => {
    const fetchImpl = router(
      [
        { match: (u, m) => m === "POST", reply: () => jsonResponse({ polling_url: "https://poll.test/c" }) },
        { match: (u) => u === "https://poll.test/c", reply: () => jsonResponse({ status: "Pending" }) },
      ],
      [],
    );
    const adapter = new BflMediaAdapter(fetchImpl);
    const controller = new AbortController();
    controller.abort();
    await expect(
      adapter.generate({ request: { mode: "t2i", prompt: "x" }, credentials: { apiKey: "k" }, ctx: ctx(undefined, controller.signal) }),
    ).rejects.toBeInstanceOf(MediaGenError);
  });
});
