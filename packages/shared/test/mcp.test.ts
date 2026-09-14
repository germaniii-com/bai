import { describe, expect, test } from "bun:test";
import { interpolateEnv, isValidMcpServerName, MCP_CATALOG, mcpServerFileSchema, mcpServerSchema } from "../src";

describe("MCP config", () => {
  test("accepts a single server object", () => {
    const parsed = mcpServerFileSchema.parse({ command: "npx", args: ["-y", "server"], env: { A: "1" } });
    expect(parsed).toMatchObject({ command: "npx" });
  });

  test("accepts a mcpServers wrapper (keys are server names)", () => {
    const parsed = mcpServerFileSchema.parse({
      mcpServers: { alpha: { url: "https://a.example/mcp" }, beta: { command: "b" } },
    });
    expect("mcpServers" in parsed).toBe(true);
    if ("mcpServers" in parsed) expect(Object.keys(parsed.mcpServers)).toEqual(["alpha", "beta"]);
  });

  test("accepts the extended fields and rejects a bad timeout", () => {
    const parsed = mcpServerSchema.parse({
      transport: "http",
      url: "https://x.example/mcp",
      headers: { Authorization: "Bearer x" },
      oauth: { scope: "read" },
      enabled: false,
      timeout: 5000,
      tools: { include: ["a"], exclude: ["b"] },
    });
    expect(parsed.transport).toBe("http");
    expect(parsed.oauth).toEqual({ scope: "read" });
    expect(() => mcpServerSchema.parse({ timeout: -1 })).toThrow();
  });

  test("isValidMcpServerName enforces filename stems", () => {
    expect(isValidMcpServerName("github")).toBe(true);
    expect(isValidMcpServerName("my-server_2")).toBe(true);
    expect(isValidMcpServerName("1bad")).toBe(false);
    expect(isValidMcpServerName("has space")).toBe(false);
  });

  test("interpolateEnv substitutes ${VAR} and leaves unknown refs", () => {
    process.env.TEST_MCP_VAR = "value";
    try {
      const out = interpolateEnv({ url: "https://x/${TEST_MCP_VAR}", nested: ["${TEST_MCP_VAR}", "${MISSING}"] }, process.env);
      expect(out).toEqual({ url: "https://x/value", nested: ["value", "${MISSING}"] });
    } finally {
      delete process.env.TEST_MCP_VAR;
    }
  });

  test("curated catalog entries are well-formed", () => {
    expect(MCP_CATALOG.length).toBeGreaterThanOrEqual(6);
    for (const entry of MCP_CATALOG) {
      expect(isValidMcpServerName(entry.name)).toBe(true);
      expect(mcpServerSchema.safeParse(entry.server).success).toBe(true);
      expect(entry.server.transport).toBe("http");
      expect(entry.server.url?.startsWith("https://")).toBe(true);
    }
  });
});
