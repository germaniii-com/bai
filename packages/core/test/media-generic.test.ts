import { describe, expect, test } from "bun:test";
import { providerFileSchema, type ProviderFile } from "@bai/shared";
import {
  MediaGenError,
  interpolateMediaBody,
  providerFileToMediaDef,
  readMediaPath,
  ImageWorkbench,
  type MappingVars,
} from "../src";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 7, 128, 0, 0, 4, 56]);
const PNG_B64 = Buffer.from(PNG).toString("base64");

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function ctx(readAsset: (id: string) => { mime: string; bytes: Uint8Array } | undefined = () => undefined) {
  return { signal: new AbortController().signal, readAsset };
}

const vars: MappingVars = { prompt: "a cat", model: "m1", count: 2, mode: "t2i", width: 512, height: 768, params: { aspect_ratio: "16:9" } };

describe("mapping engine", () => {
  test("interpolate: single token keeps type, embedded stringifies, unknown stays literal", () => {
    expect(interpolateMediaBody("$count", vars)).toBe(2);
    expect(interpolateMediaBody("n=$count", vars)).toBe("n=2");
    expect(interpolateMediaBody({ prompt: "$prompt", ratio: "$param.aspect_ratio", miss: "$nope", price: "$5" }, vars)).toEqual({
      prompt: "a cat",
      ratio: "16:9",
      miss: "$nope",
      price: "$5",
    });
  });

  test("readPath: dot, index, wildcard, missing", () => {
    const root = { data: [{ b64: "a" }, { b64: "b" }], usage: { cost: 0.04 }, one: { url: "u" } };
    expect(readMediaPath(root, "usage.cost")).toBe(0.04);
    expect(readMediaPath(root, "data[0].b64")).toBe("a");
    expect(readMediaPath(root, "data[*].b64")).toEqual(["a", "b"]);
    expect(readMediaPath(root, "one.url")).toBe("u");
    expect(readMediaPath(root, "nope.deep")).toBeUndefined();
  });
});

function buildGeneric(file: Partial<ProviderFile>): ReturnType<NonNullable<ReturnType<typeof providerFileToMediaDef>>["build"]> {
  const parsed = providerFileSchema.parse(file);
  const def = providerFileToMediaDef("acme", parsed, "/tmp/acme.json");
  if (def === undefined) throw new Error("no media def");
  return def.build((async () => jsonResponse({})) as unknown as typeof globalThis.fetch);
}

const GENERIC_FILE: ProviderFile = providerFileSchema.parse({
  name: "Acme",
  providerType: ["image"],
  baseUrl: "https://acme.test",
  env: ["ACME_KEY"],
  image: {
    template: "generic",
    defaultModel: "acme-1",
    models: [{ id: "acme-1", modes: ["t2i", "i2i"], maxReferences: 2, maxCount: 2 }],
    generate: {
      path: "/v1/generate",
      contentType: "json",
      body: { model: "$model", prompt: "$prompt", count: "$count", ratio: "$param.aspect_ratio" },
      references: { field: "images", encoding: "data-url", wrap: "array" },
    },
    response: { images: "data[*]", base64: "b64_json", mime: "media_type", costUsd: "usage.cost" },
  },
});

describe("GenericMediaAdapter", () => {
  test("t2i: interpolates the body, sends Bearer auth, decodes b64 + cost", async () => {
    const parsed = providerFileSchema.parse(GENERIC_FILE);
    const def = providerFileToMediaDef("acme", parsed, "/tmp/acme.json")!;
    let url = "";
    let headers: Record<string, string> = {};
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (u: string, init?: RequestInit) => {
      url = u;
      headers = init?.headers as Record<string, string>;
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({ data: [{ b64_json: PNG_B64, media_type: "image/png" }], usage: { cost: 0.02 } });
    }) as unknown as typeof globalThis.fetch;
    const adapter = def.build(fetchImpl);

    const result = await adapter.generate({
      request: { mode: "t2i", prompt: "a cat", model: "acme-1", params: { count: 2, aspect_ratio: "16:9" } },
      credentials: { apiKey: "sk-acme" },
      ctx: ctx(),
    });

    expect(url).toBe("https://acme.test/v1/generate");
    expect(headers.authorization).toBe("Bearer sk-acme");
    expect(body).toEqual({ model: "acme-1", prompt: "a cat", count: 2, ratio: "16:9" });
    expect(result.images[0]?.bytes.byteLength).toBe(PNG.byteLength);
    expect(result.costUsd).toBe(0.02);
  });

  test("i2i rides the generate mapping's references as data URLs", async () => {
    const parsed = providerFileSchema.parse(GENERIC_FILE);
    const def = providerFileToMediaDef("acme", parsed, "/tmp/acme.json")!;
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (_u: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({ data: [{ b64_json: PNG_B64, media_type: "image/png" }] });
    }) as unknown as typeof globalThis.fetch;
    await def.build(fetchImpl).generate({
      request: { mode: "i2i", prompt: "edit", model: "acme-1", referenceAssetIds: ["ast_1"] },
      credentials: { apiKey: "k" },
      ctx: ctx(() => ({ mime: "image/png", bytes: PNG })),
    });
    const images = body.images as string[];
    expect(images).toHaveLength(1);
    expect(images[0]?.startsWith("data:image/png;base64,")).toBe(true);
  });

  test("flat base64 array via the `.` field and a url response", async () => {
    const flat = providerFileSchema.parse({
      name: "Flat",
      providerType: ["image"],
      baseUrl: "https://flat.test",
      image: {
        template: "generic",
        defaultModel: "m",
        models: [{ id: "m", modes: ["t2i"] }],
        generate: { path: "/g", body: { p: "$prompt" } },
        response: { images: "images[*]", base64: "." },
      },
    });
    const flatDef = providerFileToMediaDef("flat", flat, "/tmp/flat.json")!;
    const flatFetch = (async () => jsonResponse({ images: [PNG_B64, PNG_B64] })) as unknown as typeof globalThis.fetch;
    const flatResult = await flatDef.build(flatFetch).generate({
      request: { mode: "t2i", prompt: "x", model: "m" },
      credentials: { apiKey: "k" },
      ctx: ctx(),
    });
    expect(flatResult.images).toHaveLength(2);

    const urlFile = providerFileSchema.parse({
      name: "Url",
      providerType: ["image"],
      baseUrl: "https://url.test",
      image: {
        template: "generic",
        defaultModel: "m",
        models: [{ id: "m", modes: ["t2i"] }],
        generate: { path: "/g" },
        response: { images: "output[0]", url: "url" },
      },
    });
    const urlDef = providerFileToMediaDef("urlp", urlFile, "/tmp/url.json")!;
    const urlFetch = (async (u: string) =>
      String(u).includes("/g") ? jsonResponse({ output: [{ url: "https://cdn.test/a.png" }] }) : new Response(PNG, { headers: { "content-type": "image/png" } })
    ) as unknown as typeof globalThis.fetch;
    const urlResult = await urlDef.build(urlFetch).generate({
      request: { mode: "t2i", prompt: "x", model: "m" },
      credentials: { apiKey: "k" },
      ctx: ctx(),
    });
    expect(urlResult.images[0]?.bytes.byteLength).toBe(PNG.byteLength);
  });

  test("multipart generates a FormData body and appends reference files", async () => {
    const file = providerFileSchema.parse({
      name: "Multi",
      providerType: ["image"],
      baseUrl: "https://multi.test",
      image: {
        template: "generic",
        defaultModel: "m",
        models: [{ id: "m", modes: ["t2i", "i2i"], maxReferences: 1, maxCount: 1 }],
        generate: { path: "/g", contentType: "multipart", body: { prompt: "$prompt" }, references: { field: "image", wrap: "single" } },
        response: { images: "images[*]", base64: "." },
      },
    });
    const def = providerFileToMediaDef("multi", file, "/tmp/multi.json")!;
    let form: FormData | undefined;
    const fetchImpl = (async (_u: string, init?: RequestInit) => {
      form = init?.body as FormData;
      return jsonResponse({ images: [PNG_B64] });
    }) as unknown as typeof globalThis.fetch;
    await def.build(fetchImpl).generate({
      request: { mode: "i2i", prompt: "x", model: "m", referenceAssetIds: ["ast_1"] },
      credentials: { apiKey: "k" },
      ctx: ctx(() => ({ mime: "image/png", bytes: PNG })),
    });
    expect(form).toBeInstanceOf(FormData);
    expect(form?.get("prompt")).toBe("x");
    expect(form?.has("image")).toBe(true);
  });

  test("missing key is non-retryable; empty response is an error", async () => {
    const adapter = buildGeneric(GENERIC_FILE);
    await expect(
      adapter.generate({ request: { mode: "t2i", prompt: "x" }, credentials: {}, ctx: ctx() }),
    ).rejects.toBeInstanceOf(MediaGenError);

    const empty = providerFileSchema.parse(GENERIC_FILE);
    const def = providerFileToMediaDef("acme", empty, "/tmp/acme.json")!;
    const fetchImpl = (async () => jsonResponse({ data: [] })) as unknown as typeof globalThis.fetch;
    await expect(
      def.build(fetchImpl).generate({ request: { mode: "t2i", prompt: "x" }, credentials: { apiKey: "k" }, ctx: ctx() }),
    ).rejects.toBeInstanceOf(MediaGenError);
  });
});

describe("openai-images template", () => {
  test("maps params to the body and decodes b64", async () => {
    const file = providerFileSchema.parse({
      name: "OA",
      providerType: ["image"],
      baseUrl: "https://oa.test/v1",
      image: { template: "openai-images", defaultModel: "img-1", models: [{ id: "img-1", modes: ["t2i"], maxCount: 3 }] },
    });
    const def = providerFileToMediaDef("oa", file, "/tmp/oa.json")!;
    let url = "";
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (u: string, init?: RequestInit) => {
      url = u;
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({ data: [{ b64_json: PNG_B64 }] });
    }) as unknown as typeof globalThis.fetch;
    const result = await def.build(fetchImpl).generate({
      request: { mode: "t2i", prompt: "x", model: "img-1", params: { count: 3, size: "512x512" } },
      credentials: { apiKey: "k" },
      ctx: ctx(),
    });
    expect(url).toBe("https://oa.test/v1/images/generations");
    expect(body).toMatchObject({ model: "img-1", prompt: "x", n: 3, size: "512x512" });
    expect(result.images[0]?.mime).toBe("image/png");
  });
});

describe("ImageWorkbench custom providers", () => {
  test("providers() lists file providers; capabilities resolve them", async () => {
    const file = providerFileSchema.parse(GENERIC_FILE);
    const def = providerFileToMediaDef("acme", file, "/tmp/acme.json")!;
    const workbench = new ImageWorkbench({
      custom: () => [def],
      runtime: {
        resolveCredentials: async () => ({ apiKey: "k" }),
        readAsset: () => undefined,
      },
    });
    const providers = await workbench.providers();
    const acme = providers.find((p) => p.id === "acme");
    expect(acme?.source).toBe("file");
    expect(acme?.path).toBe("/tmp/acme.json");
    expect(acme?.models?.map((m) => m.id)).toEqual(["acme-1"]);

    const caps = await workbench.capabilities("acme");
    expect(caps.provider).toBe("acme");
    expect(caps.model).toBe("acme-1");
    expect(caps.capabilities.params.map((p) => p.key)).toEqual(["count", "seed"]);
  });
});
