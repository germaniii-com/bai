import { timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";

/** Constant-time string comparison. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Bearer-token gate. Applied to /api/* only when the listener is bound beyond
 * loopback — local single-user traffic on 127.0.0.1 bypasses by design.
 */
export function bearerAuth(token: string): MiddlewareHandler {
  return async (c, next) => {
    const header = c.req.header("Authorization") ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (presented.length === 0 || !safeEqual(presented, token)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  };
}
