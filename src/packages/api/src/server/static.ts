import { existsSync, statSync } from "node:fs";
import path from "node:path";
import type { Context } from "hono";

const HINT_PAGE = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>bai — web UI not built</title></head>
  <body style="font-family: ui-sans-serif, system-ui; background:#0b0e14; color:#e6e6e6; display:grid; place-items:center; min-height:100vh;">
    <main style="text-align:center;">
      <h1>bai</h1>
      <p>The web UI bundle is not built yet.</p>
      <p><code>bun run build -- --filter @bai/web</code></p>
    </main>
  </body>
</html>`;

/**
 * Static hosting of the built SPA with SPA fallback:
 * real file → serve (immutable cache for hashed /assets/*), otherwise →
 * index.html (no-cache). /api/* and /mcp never fall through.
 */
export function staticHandler(distDir: string | undefined) {
  const hasAssets = distDir !== undefined && existsSync(path.join(distDir, "index.html"));
  return async (c: Context): Promise<Response> => {
    if (!hasAssets || distDir === undefined) {
      return c.html(HINT_PAGE);
    }
    const url = new URL(c.req.url);
    const pathname = decodeURIComponent(url.pathname);
    if (pathname.startsWith("/api/") || pathname === "/api" || pathname.startsWith("/mcp")) {
      return c.body(null, 404);
    }
    const rel = pathname.replace(/^\/+/, "");
    const abs = path.resolve(distDir, rel);
    if (rel !== "" && abs.startsWith(path.resolve(distDir)) && existsSync(abs) && statSync(abs).isFile()) {
      const immutable = rel.startsWith("assets/");
      return new Response(Bun.file(abs), {
        headers: {
          "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
        },
      });
    }
    return new Response(Bun.file(path.join(distDir, "index.html")), {
      headers: { "Cache-Control": "no-cache" },
    });
  };
}
