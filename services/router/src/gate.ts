import type { Context, MiddlewareHandler } from "hono";
import type { RouterDeps } from "./deps";

/**
 * Live enablement gate. `router.enabled` is read per request, so toggling
 * "Run as router" in Settings takes effect without a restart. A disabled
 * router behaves as if its routes were not installed (404), while the rest of
 * the server keeps working.
 */
export function routerGate(deps: RouterDeps): MiddlewareHandler {
  return async (c, next) => {
    if (deps.enabled !== undefined && !deps.enabled()) {
      return routerDisabled(c);
    }
    await next();
  };
}

/** 404 body for a disabled router. */
export function routerDisabled(c: Context): Response {
  return c.json(
    {
      error: {
        message: "router disabled (Settings → Model Providers → Run as router)",
        type: "router_disabled",
        code: null,
      },
    },
    404,
  );
}
