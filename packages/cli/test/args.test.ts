import { describe, expect, test } from "bun:test";
import { parseCliArgs, UsageError, usage } from "../src/args";

describe("parseCliArgs", () => {
  test("bare invocation → TUI", () => {
    expect(parseCliArgs([]).mode).toBe("tui");
    expect(parseCliArgs(["--code"]).mode).toBe("tui");
  });

  test("mode flags resolve", () => {
    expect(parseCliArgs(["--web"]).mode).toBe("web");
    expect(parseCliArgs(["--host"]).mode).toBe("host");
    expect(parseCliArgs(["--one-shot", "hi"]).mode).toBe("oneshot");
    expect(parseCliArgs(["--one-shot", "hi"])).toMatchObject({ prompt: "hi", format: "json" });
  });

  test("--router is a modifier (headless or combined with web/host)", () => {
    expect(parseCliArgs(["--router"])).toMatchObject({ mode: "router", router: true });
    expect(parseCliArgs(["--web", "--router"])).toMatchObject({ mode: "web", router: true });
    expect(parseCliArgs(["--host", "--router"])).toMatchObject({ mode: "host", router: true });
    expect(parseCliArgs(["--web"]).router).toBe(false);
    expect(() => parseCliArgs(["--one-shot", "x", "--router"])).toThrow(UsageError);
  });

  test("--mcp is a modifier (server role) and never one-shot", () => {
    expect(parseCliArgs(["--web", "--mcp"])).toMatchObject({ mode: "web", mcp: true });
    expect(parseCliArgs(["--web"]).mcp).toBe(false);
    expect(() => parseCliArgs(["--one-shot", "x", "--mcp"])).toThrow(UsageError);
  });

  test("`bai mcp` is its own stdio-bridge mode with --url/--token", () => {
    expect(parseCliArgs(["mcp"])).toMatchObject({ mode: "mcp", mcp: false });
    expect(parseCliArgs(["mcp", "--url", "http://127.0.0.1:9640/mcp", "--token", "t"])).toMatchObject({
      mode: "mcp",
      url: "http://127.0.0.1:9640/mcp",
      token: "t",
    });
    expect(() => parseCliArgs(["mcp", "--web"])).toThrow(UsageError);
    expect(() => parseCliArgs(["mcp", "extra"])).toThrow(UsageError);
  });

  test("mode flags are mutually exclusive (exit-2 class error)", () => {
    expect(() => parseCliArgs(["--web", "--host"])).toThrow(UsageError);
    expect(() => parseCliArgs(["--web", "--one-shot", "x"])).toThrow(UsageError);
  });

  test("shared flags parse", () => {
    const args = parseCliArgs(["--web", "--port", "7000", "--token", "abc", "--format", "text", "--open"]);
    expect(args).toMatchObject({ mode: "web", port: 7000, token: "abc", format: "text", open: true });
  });

  test("invalid values are usage errors", () => {
    expect(() => parseCliArgs(["--port", "notanumber"])).toThrow(UsageError);
    expect(() => parseCliArgs(["--port", "99999"])).toThrow(UsageError);
    expect(() => parseCliArgs(["--format", "yaml"])).toThrow(UsageError);
    expect(() => parseCliArgs(["--one-shot"])).toThrow(UsageError);
    expect(() => parseCliArgs(["stray-positional"])).toThrow(UsageError);
  });

  test("version/help short-circuit", () => {
    expect(parseCliArgs(["--version"]).version).toBe(true);
    expect(parseCliArgs(["--help"]).help).toBe(true);
  });

  test("usage text mentions the modes", () => {
    expect(usage()).toContain("--one-shot");
    expect(usage()).toContain("--host");
    expect(usage()).toContain("--router");
    expect(usage()).toContain("--mcp");
    expect(usage()).toContain("bai mcp");
  });
});
