import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, type Config } from "@bai/shared";
import { McpRegistry } from "../src/mcp/registry";

function makeConfig(mcp: Config["mcp"] = {}): Config {
  return { ...DEFAULT_CONFIG, mcp };
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "bai-mcp-registry-"));
}

const cleanups: string[] = [];
afterEach(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("McpRegistry", () => {
  test("scans a single-server file (name = stem)", () => {
    const dir = tempDir();
    cleanups.push(dir);
    writeFileSync(join(dir, "github.json"), JSON.stringify({ command: "npx", args: ["-y", "gh-mcp"] }));
    const registry = new McpRegistry({ dir, config: () => makeConfig(), pollMs: 0 });
    const servers = registry.list();
    expect(servers.map((s) => s.name)).toEqual(["github"]);
    expect(servers[0]?.source).toBe("file");
    expect(servers[0]?.config.command).toBe("npx");
    registry.stop();
  });

  test("accepts a YAML file and a mcpServers wrapper (keys become names)", () => {
    const dir = tempDir();
    cleanups.push(dir);
    writeFileSync(join(dir, "one.yaml"), "command: bun\nargs:\n  - server.ts\n");
    writeFileSync(
      join(dir, "bundle.json"),
      JSON.stringify({ mcpServers: { alpha: { url: "https://a.example/mcp" }, beta: { command: "b" } } }),
    );
    const registry = new McpRegistry({ dir, config: () => makeConfig(), pollMs: 0 });
    expect(registry.list().map((s) => s.name)).toEqual(["alpha", "beta", "one"]);
    expect(registry.get("alpha")?.config.url).toBe("https://a.example/mcp");
    expect(registry.get("one")?.config.command).toBe("bun");
    registry.stop();
  });

  test("files override same-named config.json entries", () => {
    const dir = tempDir();
    cleanups.push(dir);
    writeFileSync(join(dir, "shared.json"), JSON.stringify({ command: "from-file" }));
    const registry = new McpRegistry({
      dir,
      config: () => makeConfig({ shared: { command: "from-config" }, onlyConfig: { command: "c" } }),
      pollMs: 0,
    });
    expect(registry.get("shared")?.source).toBe("file");
    expect(registry.get("shared")?.config.command).toBe("from-file");
    expect(registry.get("onlyConfig")?.source).toBe("config");
    registry.stop();
  });

  test("substitutes ${VAR} references from the environment", () => {
    const dir = tempDir();
    cleanups.push(dir);
    writeFileSync(
      join(dir, "tokened.json"),
      JSON.stringify({ url: "https://x.example/mcp", headers: { Authorization: "Bearer ${TEST_MCP_TOKEN}" } }),
    );
    process.env.TEST_MCP_TOKEN = "secret-value";
    try {
      const registry = new McpRegistry({ dir, config: () => makeConfig(), pollMs: 0 });
      expect(registry.get("tokened")?.config.headers?.Authorization).toBe("Bearer secret-value");
      registry.stop();
    } finally {
      delete process.env.TEST_MCP_TOKEN;
    }
  });

  test("invalid files are skipped without taking down the registry", () => {
    const dir = tempDir();
    cleanups.push(dir);
    writeFileSync(join(dir, "good.json"), JSON.stringify({ command: "ok" }));
    writeFileSync(join(dir, "bad.json"), "{ not valid json ");
    const registry = new McpRegistry({ dir, config: () => makeConfig(), pollMs: 0 });
    expect(registry.list().map((s) => s.name)).toEqual(["good"]);
    registry.stop();
  });

  test("put writes a file and remove deletes it, notifying onChange", () => {
    const dir = tempDir();
    cleanups.push(dir);
    let changes = 0;
    const registry = new McpRegistry({ dir, config: () => makeConfig(), pollMs: 0, onChange: () => (changes += 1) });
    registry.put("added", { transport: "http", url: "https://added.example/mcp" });
    expect(registry.get("added")?.config.url).toBe("https://added.example/mcp");
    expect(JSON.parse(readFileSync(join(dir, "added.json"), "utf8")).url).toBe("https://added.example/mcp");
    expect(registry.remove("added")).toBe(true);
    expect(registry.get("added")).toBeUndefined();
    expect(changes).toBeGreaterThanOrEqual(2);
    registry.stop();
  });
});
