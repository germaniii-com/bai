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
  });
});
