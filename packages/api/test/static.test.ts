import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { staticHandler } from "../src";

/**
 * Regression: backend prefixes must never fall through to the SPA shell.
 * A browser navigation to /api/help (etc.) that resolves to index.html would
 * boot the client router and land on chat.
 */
const dir = mkdtempSync(join(tmpdir(), "bai-static-"));
writeFileSync(join(dir, "index.html"), "<!doctype html><title>bai</title>");
const app = new Hono().get("*", staticHandler(dir));

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("staticHandler SPA fallback", () => {
  test("backend prefixes never fall through to the app shell", async () => {
    for (const path of ["/api", "/api/help", "/api/help/openapi.json", "/v1", "/v1/models", "/mcp", "/mcp/x", "/wb/code/x"]) {
      const res = await app.request(path);
      expect(res.status, `expected 404 for ${path}`).toBe(404);
    }
  });

  test("client routes fall through to index.html", async () => {
    for (const path of ["/", "/chat", "/settings/providers", "/workspace"]) {
      const res = await app.request(path);
      expect(res.status, `expected 200 for ${path}`).toBe(200);
      expect(await res.text(), `expected app shell for ${path}`).toContain("<title>bai</title>");
    }
  });
});
