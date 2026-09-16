import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AuthStore,
  buildMediaAdapters,
  CatalogService,
  MEDIA_PROVIDER_SPECS,
  mediaProviderDefs,
  mediaProviderSpec,
  ProviderRegistry,
} from "../src";
import { DEFAULT_CONFIG, type Config } from "@bai/shared";

const noopFetch = (async () =>
  new Response("{}", { headers: { "content-type": "application/json" } })) as unknown as typeof globalThis.fetch;

describe("media provider registry", () => {
  test("every implemented spec materializes an adapter (+ the offline stub)", () => {
    const defs = mediaProviderDefs();
    const adapters = buildMediaAdapters(noopFetch);
    for (const spec of MEDIA_PROVIDER_SPECS) {
      const def = defs.find((d) => d.id === spec.id);
      expect(def).toBeDefined();
      expect(adapters.has(spec.id)).toBe(true);
      expect(adapters.get(spec.id)?.id).toBe(spec.id);
    }
    expect(adapters.has("stub")).toBe(true);
    expect(defs.length).toBe(MEDIA_PROVIDER_SPECS.length);
  });

  test("specs carry the credential metadata the overlay needs", () => {
    for (const spec of MEDIA_PROVIDER_SPECS) {
      expect(spec.label.length).toBeGreaterThan(0);
      expect(spec.baseUrl.startsWith("https://")).toBe(true);
      expect(spec.env.length).toBeGreaterThan(0);
    }
  });

  test("aliases resolve to their canonical provider", () => {
    expect(mediaProviderSpec("google")?.id).toBe("gemini");
    expect(mediaProviderSpec("minimax")?.id).toBe("minimax-image");
    expect(mediaProviderSpec("gemini")?.id).toBe("gemini");
    expect(mediaProviderSpec("openrouter")?.id).toBe("openrouter");
  });

  test("media-only providers are hidden from chat pickers but resolve credentials", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bai-media-reg-"));
    const config: Config = { ...DEFAULT_CONFIG };
    const accounts = new AuthStore({ file: join(dir, "auth.json") });
    const catalog = new CatalogService({
      cachePath: join(dir, "models-cache.json"),
      config: () => config,
      offline: true,
    });
    const registry = new ProviderRegistry({
      catalog,
      config: () => config,
      accounts,
      env: { FAL_KEY: "fal-test-key" },
    });

    const providers = await registry.listProviders();
    expect(providers.some((p) => p.id === "fal")).toBe(false);
    expect(providers.some((p) => p.id === "gemini")).toBe(false);
    // A chat-capable overlay media vendor stays selectable for LLMs.
    expect(providers.some((p) => p.id === "together")).toBe(true);

    const creds = await registry.resolveCredentials("fal");
    expect(creds.apiKey).toBe("fal-test-key");
    expect(creds.baseUrl).toBe("https://queue.fal.run");
    expect(creds.source).toBe("env");
  });

  test("revealApiKey returns stored keys only (never env/oauth/unknown)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bai-media-reveal-"));
    const config: Config = { ...DEFAULT_CONFIG };
    const accounts = new AuthStore({ file: join(dir, "auth.json") });
    accounts.set("fal", "default", { label: "fal", key: "fal-secret" });
    const catalog = new CatalogService({
      cachePath: join(dir, "models-cache.json"),
      config: () => config,
      offline: true,
    });
    const registry = new ProviderRegistry({
      catalog,
      config: () => config,
      accounts,
      env: { FAL_KEY: "env-secret" },
    });

    expect(registry.revealApiKey("fal", "default")).toBe("fal-secret");
    // The env pseudo-account is not stored in auth.json.
    expect(registry.revealApiKey("fal", "env")).toBeUndefined();
    expect(registry.revealApiKey("fal", "missing")).toBeUndefined();
  });
});
