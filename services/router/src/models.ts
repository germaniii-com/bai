import type { Context } from "hono";
import type { RouterDeps } from "./deps";

/** `GET /v1/models` — the routable model catalog (every connected provider). */
export async function listModels(c: Context, deps: RouterDeps): Promise<Response> {
  const models = await deps.router.models();
  // `created` is the catalog's last models.dev fetch (OpenAI's field is
  // epoch SECONDS); 0 = never fetched — same convention as /api/provider.
  const created = Math.floor(deps.router.catalogUpdatedAt() / 1000);
  return c.json({
    object: "list",
    data: models.map((m) => ({
      id: m.id,
      object: "model",
      created,
      owned_by: m.provider,
      ...(m.contextWindow !== undefined ? { context_window: m.contextWindow } : {}),
    })),
  });
}
