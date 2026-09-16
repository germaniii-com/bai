import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createApp } from "../src";
import { makeStack } from "./harness";

/**
 * Locks the composition contract the router relies on: `extraRoutes` mount
 * BEFORE the `/api` sub-app (so `/api/help` resolves) and `serveSpa:false`
 * drops only the SPA fallback (the headless `--router` listener).
 */
describe("createApp extraRoutes / serveSpa", () => {
  test("extraRoutes mount before /api — /api/help resolves, /api router intact", async () => {
    const extraRoutes = new Hono()
      .get("/api/help", (c) => c.html("<h1>help</h1>"))
      .get("/v1/models", (c) => c.json({ object: "list" }));
    const stack = makeStack({ extraRoutes });
    const app = createApp(stack.deps);

    expect((await app.request("/api/help")).status).toBe(200);
    expect((await app.request("/v1/models")).status).toBe(200);
    expect((await app.request("/api/health")).status).toBe(200);

    await stack.cleanup();
  });

  test("serveSpa:false drops the SPA fallback but keeps /api", async () => {
    const stack = makeStack({ serveSpa: false });
    const app = createApp(stack.deps);

    expect((await app.request("/api/health")).status).toBe(200);
    expect((await app.request("/not/a/real/route")).status).toBe(404);

    await stack.cleanup();
  });
});
