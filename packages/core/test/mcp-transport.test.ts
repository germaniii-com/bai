import { describe, expect, test } from "bun:test";
import { transportKind } from "../src/mcp/transport";

describe("transportKind", () => {
  test("honors an explicit transport (including sse)", () => {
    expect(transportKind({ transport: "sse", url: "https://x.example/sse" })).toBe("sse");
    expect(transportKind({ transport: "http", url: "https://x.example/mcp" })).toBe("http");
    expect(transportKind({ transport: "stdio", command: "bun" })).toBe("stdio");
  });

  test("infers http from a url and stdio from a command", () => {
    expect(transportKind({ url: "https://x.example/mcp" })).toBe("http");
    expect(transportKind({ command: "bun" })).toBe("stdio");
  });
});
