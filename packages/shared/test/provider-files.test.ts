import { describe, expect, test } from "bun:test";
import { providerFileSchema } from "../src";

const imageModels = [{ id: "m1", modes: ["t2i"] }];

describe("providerFileSchema", () => {
  test("accepts text-only, image-only, text+image, and video-only files", () => {
    expect(
      providerFileSchema.safeParse({
        name: "Chat",
        providerType: ["text"],
        baseUrl: "https://api.x.dev/v1",
        text: { adapter: "openai-compatible", models: ["m"] },
      }).success,
    ).toBe(true);

    expect(
      providerFileSchema.safeParse({
        name: "Img",
        providerType: ["image"],
        baseUrl: "https://api.x.dev/v1",
        image: { template: "openai-images", defaultModel: "m1", models: imageModels },
      }).success,
    ).toBe(true);

    expect(
      providerFileSchema.safeParse({
        name: "Both",
        providerType: ["text", "image"],
        baseUrl: "https://api.x.dev/v1",
        text: { adapter: "anthropic", models: ["m"] },
        image: { template: "generic", defaultModel: "m1", models: imageModels, generate: { path: "/g" }, response: { images: "data[*]", base64: "b64_json" } },
      }).success,
    ).toBe(true);

    // video is accepted with no capability block (not yet implemented).
    expect(
      providerFileSchema.safeParse({ name: "Vid", providerType: ["video"], baseUrl: "https://api.x.dev/v1" }).success,
    ).toBe(true);
  });

  test("providerType must match the capability blocks", () => {
    expect(
      providerFileSchema.safeParse({ name: "X", providerType: ["text"], baseUrl: "https://a.b/c" }).success,
    ).toBe(false);

    const extra = providerFileSchema.safeParse({
      name: "X",
      providerType: ["image"],
      baseUrl: "https://a.b/c",
      text: { adapter: "openai-compatible", models: [] },
      image: { template: "openai-images", defaultModel: "m", models: imageModels },
    });
    expect(extra.success).toBe(false);

    const dupes = providerFileSchema.safeParse({
      name: "X",
      providerType: ["text", "text"],
      baseUrl: "https://a.b/c",
      text: { adapter: "openai-compatible", models: [] },
    });
    expect(dupes.success).toBe(false);
  });

  test("generic response needs a base64 or url field", () => {
    const parsed = providerFileSchema.safeParse({
      name: "X",
      providerType: ["image"],
      baseUrl: "https://a.b/c",
      image: {
        template: "generic",
        defaultModel: "m",
        models: imageModels,
        generate: { path: "/g" },
        response: { images: "data[*]" },
      },
    });
    expect(parsed.success).toBe(false);
  });

  test("applies defaults (auth, edit, model limits, adapter)", () => {
    const parsed = providerFileSchema.parse({
      name: "Img",
      providerType: ["image"],
      baseUrl: "https://a.b/c",
      image: { template: "openai-images", defaultModel: "m1", models: imageModels },
    });
    expect(parsed.image?.template).toBe("openai-images");
    if (parsed.image?.template === "openai-images") expect(parsed.image.edit).toBe("none");
    expect(parsed.image?.models[0]).toMatchObject({ maxReferences: 0, maxCount: 1 });

    const text = providerFileSchema.parse({
      name: "Chat",
      providerType: ["text"],
      baseUrl: "https://a.b/c",
      text: {},
    });
    expect(text.text?.adapter).toBe("openai-compatible");

    const withAuth = providerFileSchema.parse({
      name: "Chat",
      providerType: ["text"],
      baseUrl: "https://a.b/c",
      auth: {},
      text: {},
    });
    expect(withAuth.auth).toEqual({ header: "authorization", scheme: "Bearer" });
  });

  test("rejects invalid ids and base URLs", () => {
    expect(
      providerFileSchema.safeParse({ id: "Bad ID", name: "X", providerType: ["video"], baseUrl: "https://a.b/c" }).success,
    ).toBe(false);
    expect(
      providerFileSchema.safeParse({ name: "X", providerType: ["video"], baseUrl: "not-a-url" }).success,
    ).toBe(false);
  });
});
