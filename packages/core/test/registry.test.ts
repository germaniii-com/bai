import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStore, CatalogService, ProviderRegistry } from "../src";
import { DEFAULT_CONFIG, type Config } from "@bai/shared";

const DOC = {
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    npm: "@ai-sdk/anthropic",
    env: ["ANTHROPIC_API_KEY"],
    models: { "claude-test": { id: "claude-test", name: "Claude Test", tool_call: true } },
  },
  openai: {
    id: "openai",
    name: "OpenAI",
    npm: "@ai-sdk/openai",
    env: ["OPENAI_API_KEY"],
    models: { "gpt-test": { id: "gpt-test", name: "GPT Test", tool_call: true } },
  },
  openrouter: {
    id: "openrouter",
    name: "OpenRouter",
    npm: "@openrouter/ai-sdk-provider",
    api: "https://openrouter.ai/api/v1",
    env: ["OPENROUTER_API_KEY"],
    models: { "test/model": { id: "test/model", name: "Test Model", tool_call: true } },
  },
  groq: {
    id: "groq",
    name: "Groq",
    npm: "@ai-sdk/groq",
    env: ["GROQ_API_KEY"],
    models: { "test/groq": { id: "test/groq", name: "Groq Test", tool_call: true } },
  },
  "google-shape": {
    id: "google-shape",
    name: "Google Shape",
    npm: "@ai-sdk/google",
    env: ["GEMINI_API_KEY"],
    models: { gemini: { id: "gemini", name: "Gemini", tool_call: true } },
  },
};

interface Fixture {
  registry: ProviderRegistry;
  accounts: AuthStore;
  setConfig(config: Partial<Config>): void;
  dir: string;
}

function makeFixture(env: Record<string, string | undefined> = {}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "bai-reg-"));
  let config: Config = { ...DEFAULT_CONFIG, models: { default: "stub/echo" } };
  const accounts = new AuthStore({ file: join(dir, "auth.json") });
  const cachePath = join(dir, "models-cache.json");
  writeFileSync(cachePath, JSON.stringify(DOC));
  const catalog = new CatalogService({ cachePath, config: () => config, offline: true });
  const registry = new ProviderRegistry({
    catalog,
    config: () => config,
    accounts,
    env,
  });
  return {
    registry,
    accounts,
    setConfig(patch: Partial<Config>) {
      config = { ...config, ...patch };
    },
    dir,
  };
}

describe("ProviderRegistry (dynamic, multi-account)", () => {
  test("adapter selection by wire shape", async () => {
    const f = makeFixture();
    expect((await f.registry.adapterFor("anthropic"))?.constructor.name).toBe("AnthropicProvider");
    expect((await f.registry.adapterFor("openai"))?.constructor.name).toBe("OpenAiCompatProvider");
    expect((await f.registry.adapterFor("openrouter"))?.constructor.name).toBe("OpenAiCompatProvider");
    expect((await f.registry.adapterFor("groq"))?.constructor.name).toBe("OpenAiCompatProvider");
    expect((await f.registry.adapterFor("stub"))?.constructor.name).toBe("EchoProvider");
    // google wire shape has no adapter this iteration
    expect(await f.registry.adapterFor("google-shape")).toBeUndefined();
    expect(await f.registry.adapterFor("nope")).toBeUndefined();
    rmSync(f.dir, { recursive: true, force: true });
  });

  test("unsupported shapes are excluded from listings; keys never leak", async () => {
    const f = makeFixture();
    f.accounts.set("openai", "personal", { label: "Personal", key: "sk-secret" });
    const providers = await f.registry.listProviders();
    const ids = providers.map((p) => p.id);
    expect(ids).toContain("anthropic");
    expect(ids).toContain("openrouter");
    expect(ids).toContain("groq");
    expect(ids).toContain("stub");
    expect(ids).not.toContain("google-shape");

    const openai = providers.find((p) => p.id === "openai");
    expect(openai?.connected).toBe(true);
    expect(openai?.accounts).toEqual([
      { provider: "openai", id: "personal", label: "Personal", source: "api", hasKey: true },
    ]);
    expect(JSON.stringify(providers)).not.toContain("sk-secret");
    rmSync(f.dir, { recursive: true, force: true });
  });

  test("env pseudo-account appears when the provider env var is set", async () => {
    const f = makeFixture({ ANTHROPIC_API_KEY: "env-key" });
    const accounts = await f.registry.accounts("anthropic");
    expect(accounts).toEqual([
      { provider: "anthropic", id: "env", label: "env: ANTHROPIC_API_KEY", source: "env", hasKey: true },
    ]);
    const creds = await f.registry.resolveCredentials("anthropic");
    expect(creds.source).toBe("env");
    expect(creds.apiKey).toBe("env-key");
    rmSync(f.dir, { recursive: true, force: true });
  });

  test("credential precedence: named account > first account > env > config > keyless", async () => {
    const f = makeFixture({ GROQ_API_KEY: "env-key" });
    f.setConfig({ providers: { openai: { apiKey: "config-key" } } });

    // env wins when no accounts exist
    expect((await f.registry.resolveCredentials("groq")).source).toBe("env");
    // config apiKey wins over keyless
    expect((await f.registry.resolveCredentials("openai")).source).toBe("config");
    // stored account wins over everything
    f.accounts.set("groq", "main", { key: "stored-key" });
    const creds = await f.registry.resolveCredentials("groq");
    expect(creds.source).toBe("account");
    expect(creds.accountId).toBe("main");
    expect(creds.apiKey).toBe("stored-key");
    // named account resolution + unknown account falls through to first
    expect((await f.registry.resolveCredentials("groq", "main")).apiKey).toBe("stored-key");
    expect((await f.registry.resolveCredentials("groq", "missing")).accountId).toBe("main");
    // keyless provider
    expect((await f.registry.resolveCredentials("openrouter")).source).toBe("keyless");
    rmSync(f.dir, { recursive: true, force: true });
  });

  test("baseUrl resolution: account override > config > catalog api > well-known", async () => {
    const f = makeFixture();
    // catalog api (openrouter)
    expect((await f.registry.resolveCredentials("openrouter")).baseUrl).toBe("https://openrouter.ai/api/v1");
    // well-known map (groq has no api in the doc)
    expect((await f.registry.resolveCredentials("groq")).baseUrl).toBe("https://api.groq.com/openai/v1");
    // config override
    f.setConfig({ providers: { groq: { baseUrl: "https://proxy.example.com/v1" } } });
    f.registry.invalidate();
    expect((await f.registry.resolveCredentials("groq")).baseUrl).toBe("https://proxy.example.com/v1");
    // account override beats all
    f.accounts.set("groq", "main", { key: "k", baseUrl: "https://account.example.com/v1" });
    expect((await f.registry.resolveCredentials("groq", "main")).baseUrl).toBe("https://account.example.com/v1");
    rmSync(f.dir, { recursive: true, force: true });
  });

  test("default account: config override > first stored > env", async () => {
    const f = makeFixture({ ANTHROPIC_API_KEY: "env-key" });
    expect(await f.registry.defaultAccount("anthropic")).toBe("env");
    f.accounts.set("anthropic", "work", { key: "k" });
    expect(await f.registry.defaultAccount("anthropic")).toBe("work");
    f.setConfig({ models: { default: "stub/echo", defaultAccount: { anthropic: "work" } } });
    expect(await f.registry.defaultAccount("anthropic")).toBe("work");
    rmSync(f.dir, { recursive: true, force: true });
  });

  test("resolveModel splits provider/model and throws on unknown", async () => {
    const f = makeFixture();
    const resolved = await f.registry.resolveModel("openrouter/test/model");
    expect(resolved.providerId).toBe("openrouter");
    expect(resolved.model).toBe("test/model");
    expect(await f.registry.resolveModel("stub/echo")).toBeTruthy();
    await expect(f.registry.resolveModel("nope/model")).rejects.toThrow(/Unknown or unsupported/);
    rmSync(f.dir, { recursive: true, force: true });
  });

  test("invalidate clears materialized adapters (config change → no restart)", async () => {
    const f = makeFixture();
    expect(await f.registry.adapterFor("openrouter")).toBeTruthy();
    f.registry.invalidate();
    // still resolvable after invalidation (re-materialized on demand)
    expect(await f.registry.adapterFor("openrouter")).toBeTruthy();
    rmSync(f.dir, { recursive: true, force: true });
  });
});
