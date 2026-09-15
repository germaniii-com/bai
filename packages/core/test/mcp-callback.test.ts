import { describe, expect, test } from "bun:test";
import { McpCallbackServer } from "../src/mcp/callback";

describe("McpCallbackServer", () => {
  test("binds a loopback port and captures callback params", async () => {
    const server = new McpCallbackServer();
    await server.start(0); // ephemeral port — never collides in tests
    try {
      expect(server.redirectUrl).toBe(`http://127.0.0.1:${server.port}/callback`);
      const waiting = server.waitForCode(5_000);
      const res = await fetch(`${server.redirectUrl}?code=abc123&iss=${encodeURIComponent("https://issuer.example")}`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("Authorized");
      const params = await waiting;
      expect(params.get("code")).toBe("abc123");
      expect(params.get("iss")).toBe("https://issuer.example");
    } finally {
      await server.stop();
    }
  });

  test("unknown paths 404 and leave the pending callback open", async () => {
    const server = new McpCallbackServer();
    await server.start(0);
    try {
      const notFound = await fetch(`http://127.0.0.1:${server.port}/other`);
      expect(notFound.status).toBe(404);
      const waiting = server.waitForCode(5_000);
      await fetch(`${server.redirectUrl}?code=late`);
      expect((await waiting).get("code")).toBe("late");
    } finally {
      await server.stop();
    }
  });
});
