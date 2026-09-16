import type { Context } from "hono";
import type { RouterDeps } from "./deps";

/** `GET /v1/models` — the routable model catalog (every connected provider). */
export async function listModels(c: Context, deps: RouterDeps): Promise<Response> {
  const models = await deps.router.models();
  return c.json({
    object: "list",
    data: models.map((m) => ({
      id: m.id,
      object: "model",
      created: 0,
      owned_by: m.provider,
      ...(m.contextWindow !== undefined ? { context_window: m.contextWindow } : {}),
    })),
  });
}
