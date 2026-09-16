import { Hono } from "hono";
import { bearerAuth } from "@bai/api";
import type { RouterDeps } from "./deps";
import { chatCompletions } from "./chat";
import { createRouterHelp } from "./help";
import { generateImages } from "./images";
import { listModels } from "./models";

export type { RouterDeps } from "./deps";

/**
 * The `/v1/*` gateway routes only (mounted into any bai server so external
 * OpenAI-compatible clients can point at a running bai).
 */
export function createRouterRoutes(deps: RouterDeps): Hono {
  const app = new Hono();
  // Mirror the main API: bearer auth only for non-loopback listeners.
  if (deps.token !== undefined && !deps.loopbackBind) {
    app.use("/v1/*", bearerAuth(deps.token));
  }
  return app
    .get("/v1/models", (c) => listModels(c, deps))
    .post("/v1/chat/completions", (c) => chatCompletions(c, deps))
    .post("/v1/images/generations", (c) => generateImages(c, deps));
}

/**
 * The standalone `bai --router` app: the gateway routes plus the `/api/help`
 * documentation page (+ OpenAPI JSON). No web UI.
 */
export function createRouterApp(deps: RouterDeps): Hono {
  return createRouterGateway(deps, { help: true });
}

/**
 * The composable extra-routes app: `/v1/*` always, `/api/help` when `help`.
 * `@bai/cli` mounts this into the main bai server, so every mode exposes the
 * gateway and `--router` adds the documentation page.
 */
export function createRouterGateway(deps: RouterDeps, opts: { help?: boolean } = {}): Hono {
  const app = new Hono();
  app.route("/", createRouterRoutes(deps));
  if (opts.help === true) app.route("/", createRouterHelp(deps));
  return app;
}
