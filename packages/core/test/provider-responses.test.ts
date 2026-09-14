import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, type Config } from "@bai/shared";
import { CatalogService } from "../src";
import { ProviderRegistry } from "../src";
import { AuthStore } from "../src";
import {
  codexAccountId,
  functionCallArgsDelta,
  instructionsFrom,
  isCodexEndpoint,
  toResponsesInput,
  toResponsesTools,
} from "../src/provider/adapters/responses";
import { buildToolNameMap } from "../src/provider/tool-names";

function tempCatalog(config: Config): { catalog: CatalogService; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "bai-overlay-"));
  const catalog = new CatalogService({ cachePath: join(dir, "c.json"), config: () => config, offline: true });
  return { catalog, dir };
}

describe("curated provider overlay", () => {
  test("overlay providers resolve with adapter/endpoint/auth metadata", async () => {
    const { catalog, dir } = tempCatalog(DEFAULT_CONFIG);
    const providers = await catalog.providers();
    const codex = providers.find((p) => p.id === "openai-codex");
    expect(codex?.adapter).toBe("responses");
    expect(codex?.api).toBe("https://chatgpt.com/backend-api/codex");
    expect(codex?.authType).toBe("device_code");
    expect(codex?.models.some((m) => m.id === "gpt-5.5")).toBe(true);

    const xai = providers.find((p) => p.id === "xai");
    expect(xai?.adapter).toBe("responses");
    expect(xai?.api).toBe("https://api.x.ai/v1");

    const zen = providers.find((p) => p.id === "opencode-zen");
    expect(zen?.api).toBe("https://opencode.ai/zen/v1");
    rmSync(dir, { recursive: true, force: true });
  });

  test("config custom provider keeps adapter/headers/contextLength", async () => {
    const config: Config = {
      ...DEFAULT_CONFIG,
      providers: {
        "my-gw": {
          name: "My Gateway",
          baseUrl: "https://gw.example.com/v1",
          adapter: "anthropic",
          headers: { "X-Tenant": "acme" },
          contextLength: 1234,
          models: ["m1"],
        },
      },
    };
    const { catalog, dir } = tempCatalog(config);
    const found = (await catalog.providers()).find((p) => p.id === "my-gw");
    expect(found?.adapter).toBe("anthropic");
    expect(found?.api).toBe("https://gw.example.com/v1");
    expect(found?.headers).toEqual({ "X-Tenant": "acme" });
    expect(found?.models.find((m) => m.id === "m1")?.contextWindow).toBe(1234);
    rmSync(dir, { recursive: true, force: true });
  });

  test("registry routes openai-codex through the responses adapter", async () => {
    const { catalog, dir } = tempCatalog(DEFAULT_CONFIG);
    const accounts = new AuthStore({ file: join(dir, "auth.json") });
    const registry = new ProviderRegistry({ catalog, config: () => DEFAULT_CONFIG, accounts });
    const provider = await registry.adapterFor("openai-codex");
    expect(provider?.name()).toBe("openai-codex");
    const list = await registry.listProviders();
    const info = list.find((p) => p.id === "openai-codex");
    expect(info?.adapter).toBe("responses");
    expect(info?.authType).toBe("device_code");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("Responses adapter lowering", () => {
  test("instructions extracted from system messages", () => {
    expect(instructionsFrom([{ role: "system", content: "be terse" }, { role: "user", content: "hi" }])).toBe("be terse");
  });

  test("tool calls and results lower to function_call/function_call_output", () => {
    const names = buildToolNameMap([{ name: "fs.read" }]);
    const input = toResponsesInput(
      [
        { role: "user", content: "read it" },
        {
          role: "assistant",
          content: [{ type: "tool_use", callId: "call_1", name: "fs.read", args: '{"path":"a"}' }],
        },
        { role: "user", content: [{ type: "tool_result", callId: "call_1", content: "contents" }] },
      ],
      { toolNames: names },
    );
    const call = input.find((i) => "type" in i && i.type === "function_call") as
      | { type: "function_call"; call_id: string; name: string; arguments: string }
      | undefined;
    const result = input.find((i) => "type" in i && i.type === "function_call_output") as
      | { type: "function_call_output"; call_id: string; output: string }
      | undefined;
    expect(call?.call_id).toBe("call_1");
    expect(call?.name).toBe("fs_read");
    expect(call?.arguments).toBe('{"path":"a"}');
    expect(result?.output).toBe("contents");
  });

  test("tool defs lower to strict:false function tools with sanitized names", () => {
    const tools = toResponsesTools([
      { name: "fs.read", description: "read", schema: { type: "object" } },
      { name: "mcp/server/search", schema: { type: "object" } },
    ]);
    expect(tools[0]?.name).toBe("fs_read");
    expect(tools[0]?.strict).toBe(false);
    expect(tools[0]?.description).toBe("read");
    expect(tools[1]?.name).toMatch(/^[a-zA-Z0-9_-]+$/);
  });

  test("done arguments are not re-emitted after the deltas streamed them", () => {
    const full = '{"path":"README.md"}';
    // The real stream: fragments arrive as deltas, then `done` repeats the
    // whole JSON — emitting it again would append a second copy.
    const streamed = '{"path"' + ':"README.md"}';
    expect(streamed).toBe(full);
    expect(functionCallArgsDelta(full, full)).toBe("");
    expect(functionCallArgsDelta(streamed, full)).toBe("");
    // A server that skips the delta events still gets the full payload.
    expect(functionCallArgsDelta("", full)).toBe(full);
    // Partial deltas (e.g. dropped/late fragments) get only the tail.
    expect(functionCallArgsDelta('{"path"', full)).toBe(':"README.md"}');
    // Unreconcilable accumulation never double-appends.
    expect(functionCallArgsDelta("garbage", full)).toBe("");
  });

  test("codex endpoint detection and account-id claim extraction", () => {
    expect(isCodexEndpoint("https://chatgpt.com/backend-api/codex")).toBe(true);
    expect(isCodexEndpoint("https://api.x.ai/v1")).toBe(false);
    // Header payload with the ChatGPT account claim (unsigned test JWT).
    const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_123" } })).toString("base64url");
    const token = `header.${payload}.sig`;
    expect(codexAccountId(token)).toBe("acct_123");
    expect(codexAccountId("not-a-jwt")).toBeUndefined();
  });
});
