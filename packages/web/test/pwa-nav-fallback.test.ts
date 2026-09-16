import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Regression: the PWA service worker must not serve the cached app shell for
 * backend routes. Workbox's NavigationRoute handles every browser navigation,
 * so without a denylist, opening /api/help in a browser boots the SPA (chat)
 * instead of reaching the server. Curl cannot catch this — only navigations.
 */
const config = readFileSync(fileURLToPath(new URL("../vite.config.ts", import.meta.url)), "utf8");

describe("PWA navigation fallback", () => {
  test("workbox.navigateFallbackDenylist excludes backend prefixes", () => {
    const match = config.match(/navigateFallbackDenylist:\s*\[([\s\S]*?)\]/);
    expect(match, "vite.config.ts must configure workbox.navigateFallbackDenylist").not.toBeNull();
    const list = match?.[1] ?? "";
    for (const prefix of ["api", "mcp", "v1", "wb"]) {
      expect(list, `denylist must exclude /${prefix}`).toContain(prefix);
    }
  });
});
