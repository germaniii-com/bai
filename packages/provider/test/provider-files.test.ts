import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CatalogService, ProviderFileRegistry, parseProviderFile } from "../src";
import { DEFAULT_CONFIG, type Config } from "@bai/shared";

const dirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "bai-provfiles-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const TEXT_FILE = {
  name: "My Gateway",
  providerType: ["text"],
  baseUrl: "https://gw.example.com/v1",
  env: ["MY_GW_KEY"],
  text: { adapter: "openai-compatible", models: ["my-model"] },
};

const IMAGE_FILE = {
  name: "Local FLUX",
  providerType: ["image"],
  baseUrl: "http://localhost:8000/v1",
  env: ["LOCAL_FLUX_KEY"],
  image: { template: "openai-images", defaultModel: "flux-dev", models: [{ id: "flux-dev", modes: ["t2i"] }] },
};

describe("parseProviderFile", () => {
  test("parses JSONC and validates", () => {
    const ok = parseProviderFile(
      `{ // comment\n "name":"X","providerType":["video"],"baseUrl":"https://a.b/c",` +
        `"video":{"template":"generic","defaultModel":"m","models":[{"id":"m","workflows":["t2v"]}],` +
        `"generate":{"path":"/g"},"response":{"videos":"data[*]","base64":"b64"}} }`,
      "x",
    );
    expect(ok.ok).toBe(true);
    const bad = parseProviderFile(`{ "name":"X","providerType":["image"],"baseUrl":"https://a.b/c" }`, "x");
    expect(bad.ok).toBe(false);
  });
});

describe("ProviderFileRegistry", () => {
  test("scans files, exposes catalog entries, and preserves capability flags", () => {
    const dir = makeDir();
    writeFileSync(join(dir, "my-gw.json"), JSON.stringify(TEXT_FILE));
    writeFileSync(join(dir, "local-flux.json"), JSON.stringify(IMAGE_FILE));

    const registry = new ProviderFileRegistry({ dir, pollMs: 0 });
    try {
      expect(registry.list().map((f) => f.id)).toEqual(["local-flux", "my-gw"]);

      const catalog = registry.catalogProviders();
      const gw = catalog.find((c) => c.id === "my-gw");
      expect(gw?.source).toBe("file");
      expect(gw?.adapter).toBe("openai-compatible");
      expect(gw?.api).toBe("https://gw.example.com/v1");
      expect(gw?.env).toEqual(["MY_GW_KEY"]);
      expect(gw?.mediaOnly).toBe(false);
      expect(gw?.models.map((m) => m.id)).toEqual(["my-model"]);

      const flux = catalog.find((c) => c.id === "local-flux");
      expect(flux?.mediaOnly).toBe(true);
      expect(flux?.providerType).toEqual(["image"]);
    } finally {
      registry.stop();
    }
  });

  test("reserved built-in media ids are ignored with a warning", () => {
    const dir = makeDir();
    writeFileSync(join(dir, "openai.json"), JSON.stringify({ ...IMAGE_FILE, name: "Shadow" }));
    writeFileSync(join(dir, "mine.json"), JSON.stringify(IMAGE_FILE));
    const registry = new ProviderFileRegistry({ dir, pollMs: 0 });
    try {
      expect(registry.get("openai")).toBeUndefined();
      expect(registry.get("mine")).toBeDefined();
    } finally {
      registry.stop();
    }
  });

  test("put validates + writes; remove deletes", () => {
    const dir = makeDir();
    const registry = new ProviderFileRegistry({ dir, pollMs: 0 });
    try {
      const saved = registry.put("mine", IMAGE_FILE as never);
      expect(saved.id).toBe("mine");
      expect(registry.get("mine")?.file.name).toBe("Local FLUX");

      expect(() => registry.put("openai", IMAGE_FILE as never)).toThrow(/reserved/);
      expect(() => registry.put("bad", { ...IMAGE_FILE, name: "" } as never)).toThrow();

      expect(registry.remove("mine")).toBe(true);
      expect(registry.get("mine")).toBeUndefined();
      expect(registry.remove("mine")).toBe(false);
    } finally {
      registry.stop();
    }
  });

  test("file providers merge on top of the catalog (source: file)", async () => {
    const dir = makeDir();
    writeFileSync(join(dir, "my-gw.json"), JSON.stringify(TEXT_FILE));
    const registry = new ProviderFileRegistry({ dir, pollMs: 0 });
    const config: Config = { ...DEFAULT_CONFIG };
    const catalog = new CatalogService({
      cachePath: join(dir, "models-cache.json"),
      config: () => config,
      fileProviders: () => registry.catalogProviders(),
      offline: true,
    });
    try {
      const providers = await catalog.providers();
      const gw = providers.find((p) => p.id === "my-gw");
      expect(gw?.source).toBe("file");
      expect(gw?.api).toBe("https://gw.example.com/v1");
      // An image-only provider is cataloged but hidden from chat pickers.
      writeFileSync(join(dir, "img.json"), JSON.stringify(IMAGE_FILE));
      registry.scan();
      const after = await catalog.providers();
      expect(after.find((p) => p.id === "img")?.mediaOnly).toBe(true);
    } finally {
      registry.stop();
    }
  });
});
