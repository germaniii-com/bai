import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Asset, Job, MediaUsageResponse } from "@bai/shared";
import { createApp } from "../src";
import { makeStack, type TestStack } from "./harness";

async function waitForAsset(stack: TestStack): Promise<Asset> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const assets = stack.store.assets.list(10);
    if (assets.length > 0) return assets[0] as Asset;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("timeout waiting for an asset");
}

function postJson(body: unknown): RequestInit {
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

describe("image routes", () => {
  let stack: TestStack;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    stack = makeStack();
    app = createApp(stack.deps);
  });

  afterEach(() => stack.cleanup());

  test("generate → gallery → tags → recent", async () => {
    const res = await app.request("/api/image/generate", postJson({ mode: "t2i", prompt: "a red cube", tags: ["Cat"] }));
    expect(res.status).toBe(202);
    const { job } = (await res.json()) as { job: Job };
    expect(job.kind).toBe("image.generate");

    const asset = await waitForAsset(stack);

    const gallery = await app.request("/api/image/gallery?tags=cat");
    const galleryBody = (await gallery.json()) as { images: Asset[]; total: number };
    expect(galleryBody.total).toBe(1);
    expect(galleryBody.images[0]?.id).toBe(asset.id);

    const empty = await app.request("/api/image/gallery?tags=nope");
    expect(((await empty.json()) as { total: number }).total).toBe(0);

    const tags = await app.request("/api/image/tags");
    expect(((await tags.json()) as { tags: Array<{ tag: string }> }).tags.map((t) => t.tag)).toEqual(["cat"]);

    const recent = await app.request("/api/image/recent");
    const recentBody = (await recent.json()) as { job: Job; images: Asset[] };
    expect(recentBody.job.id).toBe(job.id);
    expect(recentBody.images).toHaveLength(1);
  });

  test("generate validates its body", async () => {
    const bad = await app.request("/api/image/generate", postJson({ mode: "t2i", prompt: "" }));
    expect(bad.status).toBe(400);
  });

  test("PUT /api/asset/:id/tags replaces tags; unknown → 404", async () => {
    await app.request("/api/image/generate", postJson({ mode: "t2i", prompt: "x", tags: ["old"] }));
    const asset = await waitForAsset(stack);
    const res = await app.request(`/api/asset/${asset.id}/tags`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tags: ["New", "tag"] }),
    });
    expect(res.status).toBe(200);
    await res.json();
    expect(stack.store.assetTags.listForAsset(asset.id)).toEqual(["new", "tag"]);

    const gallery = await app.request("/api/image/gallery?tags=new");
    expect(((await gallery.json()) as { total: number }).total).toBe(1);

    const missing = await app.request("/api/asset/ast_nope/tags", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tags: ["x"] }),
    });
    expect(missing.status).toBe(404);
  });

  test("GET /api/image/usage aggregates image generations", async () => {
    stack.store.mediaUsage.insert({
      provider: "openrouter",
      model: "google/gemini-3-pro-image",
      mode: "t2i",
      images: 2,
      costUsd: 0.08,
      durationMs: 1000,
      now: "2026-09-15T10:00:00.000Z",
    });
    stack.store.mediaUsage.insert({
      provider: "openrouter",
      model: "google/gemini-3-pro-image",
      mode: "i2i",
      ok: false,
      error: "boom",
      now: "2026-09-15T11:00:00.000Z",
    });

    const res = await app.request("/api/image/usage");
    expect(res.status).toBe(200);
    const body = (await res.json()) as MediaUsageResponse;
    expect(body.kpis.requests).toBe(2);
    expect(body.kpis.images).toBe(2);
    expect(body.kpis.errors).toBe(1);
    expect(body.kpis.spendUsd).toBeCloseTo(0.08);
    expect(body.byModel[0]).toMatchObject({ model: "google/gemini-3-pro-image", images: 2 });

    const filtered = await app.request("/api/image/usage?mode=i2i");
    expect(((await filtered.json()) as MediaUsageResponse).kpis.requests).toBe(1);
  });

  test("capabilities returns a provider/model + param spec (stub fallback)", async () => {
    const res = await app.request("/api/image/capabilities");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { provider: string; capabilities: { params: unknown[] } };
    expect(body.provider).toBe("stub");
    expect(body.capabilities.params.length).toBeGreaterThan(0);
  });

  test("GET /api/image/providers lists the workbench's media providers", async () => {
    const res = await app.request("/api/image/providers");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      providers: Array<{
        id: string;
        label: string;
        defaultModel: string;
        modes: string[];
        models?: Array<{ id: string; modes: string[] }>;
        connected?: boolean;
      }>;
    };
    expect(body.providers.map((p) => p.id)).toContain("openrouter");
    expect(body.providers.map((p) => p.id)).not.toContain("stub");
    expect(
      body.providers.every(
        (p) =>
          p.label.length > 0 &&
          p.defaultModel.length > 0 &&
          p.modes.length > 0 &&
          (p.models?.length ?? 0) > 0,
      ),
    ).toBe(true);
    // The page builds its flat model list from these, so ids must be present.
    expect(body.providers.every((p) => p.models?.every((m) => m.id.length > 0 && m.modes.length > 0))).toBe(true);
  });

  test("GET /api/image/providers exposes saved keys for image-only providers (hidden from chat)", async () => {
    const put = await app.request("/api/provider/fal/account/default", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "fal", key: "fal-secret-key" }),
    });
    expect(put.status).toBe(201);

    const res = await app.request("/api/image/providers");
    const body = (await res.json()) as {
      providers: Array<{ id: string; connected?: boolean; accounts?: Array<{ id: string; label: string }> }>;
    };
    const fal = body.providers.find((p) => p.id === "fal");
    expect(fal?.connected).toBe(true);
    expect(fal?.accounts?.map((a) => a.id)).toEqual(["default"]);
    // The key itself never crosses the wire.
    expect(JSON.stringify(body)).not.toContain("fal-secret-key");

    // Image-only providers stay out of the LLM/chat provider list.
    const providers = await app.request("/api/provider?models=0");
    const list = (await providers.json()) as { providers: Array<{ id: string }> };
    expect(list.providers.some((p) => p.id === "fal")).toBe(false);
  });

  test("account key reveal returns the stored key (no-store); unknown/env → 404", async () => {
    const put = await app.request("/api/provider/stability/account/default", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "stability", key: "sk-reveal-me" }),
    });
    expect(put.status).toBe(201);

    const res = await app.request("/api/provider/stability/account/default/key");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(((await res.json()) as { key: string }).key).toBe("sk-reveal-me");

    const missing = await app.request("/api/provider/stability/account/nope/key");
    expect(missing.status).toBe(404);
    // Env-backed accounts are not stored, so they can never be revealed.
    const env = await app.request("/api/provider/openai/account/env/key");
    expect(env.status).toBe(404);
  });

  test("delete removes the asset; unknown id → 404", async () => {
    await app.request("/api/image/generate", postJson({ mode: "t2i", prompt: "x" }));
    const asset = await waitForAsset(stack);
    const del = await app.request(`/api/asset/${asset.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(stack.store.assets.get(asset.id)).toBeUndefined();
    const again = await app.request(`/api/asset/${asset.id}`, { method: "DELETE" });
    expect(again.status).toBe(404);
  });

  test("retry re-enqueues a terminal job; unknown → 404", async () => {
    await app.request("/api/image/generate", postJson({ mode: "t2i", prompt: "x" }));
    const asset = await waitForAsset(stack);
    const job = stack.store.jobs.get(asset.jobId as string);
    expect(job?.status).toBe("done");

    const retry = await app.request(`/api/job/${job?.id}/retry`, { method: "POST" });
    expect(retry.status).toBe(202);
    const { job: next } = (await retry.json()) as { job: Job };
    expect(next.id).not.toBe(job?.id);
    expect(next.status).toBe("queued");

    const missing = await app.request("/api/job/job_nope/retry", { method: "POST" });
    expect(missing.status).toBe(404);
  });
});
