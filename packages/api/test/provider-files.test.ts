import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createApp } from "../src";
import { makeStack, type TestStack } from "./harness";

function send(body: unknown): RequestInit {
  return { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

const TEXT_FILE = {
  name: "My GW",
  providerType: ["text"],
  baseUrl: "https://gw.test/v1",
  env: ["GW_KEY"],
  text: { adapter: "openai-compatible", models: ["m1"] },
};

const IMAGE_FILE = {
  name: "Local FLUX",
  providerType: ["image"],
  baseUrl: "http://localhost:8000/v1",
  image: { template: "openai-images", defaultModel: "flux", models: [{ id: "flux", modes: ["t2i"] }] },
};

describe("provider files", () => {
  let stack: TestStack;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    stack = makeStack();
    app = createApp(stack.deps);
  });

  afterEach(() => stack.cleanup());

  test("CRUD + surface placement by providerType", async () => {
    expect(((await (await app.request("/api/provider/files")).json()) as { files: unknown[] }).files).toEqual([]);

    expect((await app.request("/api/provider/file/my-gw", send(TEXT_FILE))).status).toBe(201);
    expect((await app.request("/api/provider/file/local-flux", send(IMAGE_FILE))).status).toBe(201);

    const files = (await (await app.request("/api/provider/files")).json()) as {
      files: Array<{ id: string; providerType: string[]; path: string }>;
    };
    expect(files.files.map((f) => f.id).sort()).toEqual(["local-flux", "my-gw"]);
    expect(files.files.every((f) => f.path.includes("providers"))).toBe(true);

    // A text provider shows in the chat provider list (source: file)…
    const providers = (await (await app.request("/api/provider?models=0")).json()) as {
      providers: Array<{ id: string; source: string }>;
    };
    expect(providers.providers.some((p) => p.id === "my-gw" && p.source === "file")).toBe(true);
    // …while an image-only provider stays out of it.
    expect(providers.providers.some((p) => p.id === "local-flux")).toBe(false);

    // The image provider shows in the image workbench list.
    const img = (await (await app.request("/api/image/providers")).json()) as {
      providers: Array<{ id: string; source?: string; models?: Array<{ id: string }> }>;
    };
    const flux = img.providers.find((p) => p.id === "local-flux");
    expect(flux?.source).toBe("file");
    expect(flux?.models?.map((m) => m.id)).toEqual(["flux"]);

    expect((await app.request("/api/provider/file/my-gw", { method: "DELETE" })).status).toBe(200);
    expect((((await (await app.request("/api/provider/files")).json()) as { files: unknown[] }).files)).toHaveLength(1);
    expect((await app.request("/api/provider/file/my-gw", { method: "DELETE" })).status).toBe(404);
  });

  test("validation: reserved ids and bad bodies → 400", async () => {
    // Reserved built-in media id.
    expect((await app.request("/api/provider/file/openai", send(IMAGE_FILE))).status).toBe(400);
    // Schema failure (empty name).
    expect(
      (await app.request("/api/provider/file/bad", send({ name: "", providerType: ["image"], baseUrl: "https://x.y/z" }))).status,
    ).toBe(400);
    // providerType/image mismatch.
    expect(
      (
        await app.request(
          "/api/provider/file/missing",
          send({ name: "X", providerType: ["image"], baseUrl: "https://x.y/z" }),
        )
      ).status,
    ).toBe(400);
  });
});
