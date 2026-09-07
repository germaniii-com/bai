import { describe, expect, test } from "bun:test";
import { configSchema, deepMerge, DEFAULT_CONFIG, type Config } from "../src";

describe("config schema", () => {
  test("empty document parses to defaults", () => {
    const parsed = configSchema.parse({});
    expect(parsed.providers).toEqual({});
    expect(parsed.models).toEqual({});
    expect(parsed.permissions).toEqual({});
    expect(parsed.server).toEqual({});
  });

  test("accepts a full document", () => {
    const parsed = configSchema.parse({
      providers: { openrouter: { baseUrl: "https://openrouter.ai/api/v1" } },
      models: { default: "anthropic/claude-sonnet-4-5" },
      permissions: { "bash.*": "ask", "fs.read": "allow" },
      mcp: { fetch: { command: "uvx", args: ["mcp-server-fetch"] } },
      workbenches: { image: { adapter: "fal" } },
      server: { port: 9640 },
    });
    expect(parsed.models.default).toBe("anthropic/claude-sonnet-4-5");
    expect(parsed.permissions["bash.*"]).toBe("ask");
    expect(parsed.server.port).toBe(9640);
  });

  test("parses the settings-section keys (user, preferZdr, media gen)", () => {
    const parsed = configSchema.parse({
      user: { name: "German" },
      models: { preferZdr: true },
      imageGen: { provider: "openai", account: "personal", model: "gpt-image-2" },
      videoGen: { provider: "fal", model: "fal-ai/flux-2" },
    });
    expect(parsed.user.name).toBe("German");
    expect(parsed.models.preferZdr).toBe(true);
    expect(parsed.imageGen).toEqual({ provider: "openai", account: "personal", model: "gpt-image-2" });
    expect(parsed.videoGen).toEqual({ provider: "fal", model: "fal-ai/flux-2" });
    // Defaults stay empty — the settings keys are opt-in.
    expect(configSchema.parse({}).models).toEqual({});
    expect(configSchema.parse({}).user).toEqual({});
    expect(configSchema.parse({}).imageGen).toBeUndefined();
    expect(configSchema.parse({}).videoGen).toBeUndefined();
  });

  test("rejects invalid values", () => {
    expect(() => configSchema.parse({ server: { port: -1 } })).toThrow();
    expect(() => configSchema.parse({ permissions: { x: "maybe" } })).toThrow();
    expect(() => configSchema.parse({ providers: { p: { baseUrl: "not-a-url" } } })).toThrow();
    expect(() => configSchema.parse({ models: { preferZdr: "yes" } })).toThrow();
    expect(() => configSchema.parse({ user: { name: "" } })).toThrow();
    expect(() => configSchema.parse({ imageGen: { provider: "" } })).toThrow();
  });
});

describe("deepMerge", () => {
  test("later layers win, objects merge recursively", () => {
    const base: Config = {
      ...DEFAULT_CONFIG,
      providers: { a: { apiKeyEnv: "A_KEY" } },
      models: { default: "x/y" },
    };
    const merged = deepMerge(base, {
      providers: { a: { baseUrl: "https://x" }, b: {} },
      models: { default: "p/q" },
    });
    expect(merged.providers.a?.apiKeyEnv).toBe("A_KEY");
    expect(merged.providers.a?.baseUrl).toBe("https://x");
    expect(merged.providers.b).toEqual({});
    expect(merged.models.default).toBe("p/q");
  });

  test("arrays and scalars are replaced, not merged", () => {
    const merged = deepMerge({ mcp: { s: { args: ["a", "b"] } } }, { mcp: { s: { args: ["c"] } } });
    expect(merged).toEqual({ mcp: { s: { args: ["c"] } } });
  });
});
