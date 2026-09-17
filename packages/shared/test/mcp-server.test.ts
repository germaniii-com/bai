import { describe, expect, test } from "bun:test";
import {
  buildMcpToolAliases,
  configPatchSchema,
  configSchema,
  filterMcpServerTools,
  MCP_SERVER_ALWAYS_EXCLUDE,
  MCP_TOOL_ALIAS_MAX,
  mcpToolAlias,
} from "../src";

const MCP_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

describe("MCP server role — tool aliases", () => {
  test("dots become _, slashes become __", () => {
    expect(mcpToolAlias("fs.read")).toBe("fs_read");
    expect(mcpToolAlias("mcp/list_resources")).toBe("mcp__list_resources");
    expect(mcpToolAlias("mcp/github/search")).toBe("mcp__github__search");
    expect(mcpToolAlias("web.search")).toBe("web_search");
  });

  test("produces MCP/LLM-safe names and maps both directions", () => {
    const names = ["bash", "fs.read", "fs.write", "mcp/list_resources", "mcp/github/search", "image.generate"];
    const aliases = buildMcpToolAliases(names);
    for (const name of names) {
      const alias = aliases.byTool.get(name);
      expect(alias).toBeDefined();
      expect(MCP_NAME_RE.test(alias as string)).toBe(true);
      expect(aliases.byAlias.get(alias as string)).toBe(name);
    }
    expect(aliases.byAlias.size).toBe(names.length);
  });

  test("collisions are disambiguated deterministically", () => {
    const aliases = buildMcpToolAliases(["a.b", "a_b"]);
    expect(aliases.byTool.get("a.b")).toBe("a_b");
    expect(aliases.byTool.get("a_b")).toBe("a_b_2");
    expect(aliases.byAlias.get("a_b")).toBe("a.b");
    expect(aliases.byAlias.get("a_b_2")).toBe("a_b");
    // Same input order gives the same result.
    expect(buildMcpToolAliases(["a.b", "a_b"]).byTool.get("a_b")).toBe("a_b_2");
  });

  test("long names are truncated to the max length", () => {
    const long = `fs.${"x".repeat(200)}`;
    const alias = mcpToolAlias(long);
    expect(alias.length).toBeLessThanOrEqual(64);
    expect(MCP_NAME_RE.test(alias)).toBe(true);
  });

  test("a leading non-letter is prefixed", () => {
    expect(mcpToolAlias("1weird")).toBe("t_1weird");
  });
});

describe("MCP server role — tool filtering", () => {
  const all = ["bash", "fs.read", "fs.write", "question", "skills.view", "mcp/list_resources"];

  test("default exposes everything except the always-excluded", () => {
    expect(filterMcpServerTools(all, undefined)).toEqual(["bash", "fs.read", "fs.write", "skills.view", "mcp/list_resources"]);
    for (const tool of MCP_SERVER_ALWAYS_EXCLUDE) expect(filterMcpServerTools(all, undefined)).not.toContain(tool);
  });

  test("exclude removes names", () => {
    expect(filterMcpServerTools(all, { exclude: ["bash"] })).not.toContain("bash");
  });

  test("include is a whitelist that can opt question back in", () => {
    expect(filterMcpServerTools(all, { include: ["question", "fs.read"] })).toEqual(["fs.read", "question"]);
  });
});

describe("MCP server role — config schema", () => {
  test("configSchema accepts the mcpServer block and defaults it off", () => {
    const parsed = configSchema.parse({});
    expect(parsed.mcpServer).toEqual({});
    const withBlock = configSchema.parse({
      mcpServer: {
        enabled: true,
        autoApprove: false,
        tools: { include: ["fs.read"], exclude: ["bash"] },
        session: { agent: "build", cwd: "/tmp", model: "x/y" },
      },
    });
    expect(withBlock.mcpServer?.enabled).toBe(true);
    expect(withBlock.mcpServer?.tools?.include).toEqual(["fs.read"]);
  });

  test("configPatchSchema accepts a partial mcpServer patch", () => {
    expect(configPatchSchema.parse({ mcpServer: { enabled: false } }).mcpServer).toEqual({ enabled: false });
    expect(() => configPatchSchema.parse({ mcpServer: { enabled: "yes" } })).toThrow();
  });
});

// Keep the exported constant honest against the regex bound used above.
test("MCP_TOOL_ALIAS_MAX matches the regex bound", () => {
  expect(MCP_TOOL_ALIAS_MAX).toBe(64);
});
