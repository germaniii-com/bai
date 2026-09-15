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
    expect(MCP_CATALOG.length).toBeGreaterThanOrEqual(63);
    const seen = new Set<string>();
    for (const entry of MCP_CATALOG) {
      expect(isValidMcpServerName(entry.name)).toBe(true);
      expect(seen.has(entry.name)).toBe(false);
      seen.add(entry.name);
      expect(entry.category.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeGreaterThan(0);
      // Remote servers only: streamable HTTP, or explicit SSE.
      expect(entry.server.transport === "http" || entry.server.transport === "sse").toBe(true);
      expect(entry.server.url?.startsWith("https://")).toBe(true);
      expect(mcpServerSchema.safeParse(entry.server).success).toBe(true);
      if (entry.server.transport === "sse") expect(entry.server.url?.endsWith("/sse")).toBe(true);
      // The install-time OAuth flag must agree with the server definition.
      expect(entry.oauth === true).toBe(entry.server.oauth !== undefined && entry.server.oauth !== false);
    }
    // Figma's DCR allowlists specific client_name strings.
    const figma = MCP_CATALOG.find((e) => e.name === "figma");
    const oauth = figma?.server.oauth;
    expect(typeof oauth === "object" && oauth.clientName).toBe("Claude Code");
    // Categories are grouped (used by the Integrations pane).
    expect(new Set(MCP_CATALOG.map((e) => e.category)).size).toBeGreaterThan(1);
  });
});
