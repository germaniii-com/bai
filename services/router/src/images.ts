import { Buffer } from "node:buffer";
import type { Context } from "hono";
import type { Asset, MediaGenRequest, MediaParamValue } from "@bai/shared";
import type { RouterDeps } from "./deps";
import { ACCOUNT_HEADER } from "./chat";

interface OpenAiImageRequest {
  model?: string;
  prompt?: unknown;
  n?: unknown;
  size?: unknown;
  response_format?: unknown;
  [key: string]: unknown;
}

/**
 * `POST /v1/images/generations` — OpenAI-compatible image routing. `model` may
 * be bai's `provider/model` id (the image workbench resolves the provider);
 * `x-bai-account` selects a saved account. The request is enqueued on the
 * shared image job queue and the produced assets are returned as base64.
 */
export async function generateImages(c: Context, deps: RouterDeps): Promise<Response> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { message: "invalid JSON body", type: "invalid_request_error", code: null } }, 400);
  }
  const req = (typeof body === "object" && body !== null ? body : {}) as OpenAiImageRequest;
  const prompt = typeof req.prompt === "string" ? req.prompt.trim() : "";
  if (prompt.length === 0) {
    return c.json({ error: { message: "`prompt` is required", type: "invalid_request_error", code: null } }, 400);
  }
  const account = c.req.header(ACCOUNT_HEADER) ?? undefined;
  const { provider, model } = splitModel(typeof req.model === "string" ? req.model : undefined);

  const request: MediaGenRequest = {
    mode: "t2i",
    prompt,
    ...(model !== undefined ? { model } : {}),
    ...(provider !== undefined ? { provider } : {}),
    ...(account !== undefined ? { account } : {}),
    params: imageParams(req),
  };

  try {
    const job = deps.core.enqueueImageGeneration(request);
    const done = await deps.jobs.waitFor(job.id, c.req.raw.signal);
    if (done === undefined || done.status !== "done") {
      const message =
        done?.error ?? (done?.status === "cancelled" ? "image generation cancelled" : "image generation failed");
      return c.json({ error: { message, type: "router_error", code: null } }, 502);
    }
    const assets = deps.store.assets.byJob(job.id).filter((asset) => asset.kind === "image");
    if (assets.length === 0) {
      return c.json({ error: { message: "provider returned no images", type: "router_error", code: null } }, 502);
    }
    const data = await Promise.all(assets.map((asset) => toImageDatum(asset)));
    return c.json({
      created: Math.floor(Date.now() / 1000),
      ...(typeof req.model === "string" ? { model: req.model } : {}),
      data,
    });
  } catch (err) {
    return c.json(
      { error: { message: err instanceof Error ? err.message : String(err), type: "router_error", code: null } },
      502,
    );
  }
}

/** `provider/model` → parts; a bare id is a model with no explicit provider. */
function splitModel(model: string | undefined): { provider?: string; model?: string } {
  if (model === undefined || model.length === 0) return {};
  const idx = model.indexOf("/");
  if (idx < 0) return { model };
  return { provider: model.slice(0, idx), model: model.slice(idx + 1) };
}

/** OpenAI image fields → the workbench's generic param vocabulary. */
function imageParams(req: OpenAiImageRequest): Record<string, MediaParamValue> {
  const params: Record<string, MediaParamValue> = {};
  if (typeof req.n === "number") params.count = req.n;
  if (typeof req.size === "string") params.size = req.size;
  for (const [key, value] of Object.entries(req)) {
    if (key === "model" || key === "prompt" || key === "n" || key === "size" || key === "response_format") continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") params[key] = value;
  }
  return params;
}

async function toImageDatum(asset: Asset): Promise<{ b64_json: string; mime_type?: string }> {
  const bytes = new Uint8Array(await Bun.file(asset.path).arrayBuffer());
  return { b64_json: Buffer.from(bytes).toString("base64"), mime_type: asset.mime };
}
