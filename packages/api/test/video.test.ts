import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Asset, Job, VideoProviderInfo } from "@bai/shared";
import { createApp } from "../src";
import { makeStack, type TestStack } from "./harness";

async function waitForVideo(stack: TestStack): Promise<Asset> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const assets = stack.store.assets.list(10).filter((a) => a.kind === "video");
    if (assets.length > 0) return assets[0] as Asset;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("timeout waiting for a video asset");
}

function postJson(body: unknown): RequestInit {
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

describe("video routes", () => {
  let stack: TestStack;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    stack = makeStack();
    app = createApp(stack.deps);
  });

  afterEach(() => stack.cleanup());

  test("generate → gallery → recent via the offline stub", async () => {
    const res = await app.request("/api/video/generate", postJson({ workflow: "t2v", prompt: "a red cube", tags: ["Clip"] }));
    expect(res.status).toBe(202);
    const { job } = (await res.json()) as { job: Job };
    expect(job.kind).toBe("video.generate");

    const asset = await waitForVideo(stack);
    expect(asset.meta.workflow).toBe("t2v");

    // The queue extracts a first-frame poster; it is served on its own route.
    expect(typeof asset.meta.posterPath).toBe("string");
    const poster = await app.request(`/api/asset/${asset.id}/poster`);
    expect(poster.status).toBe(200);
    expect(poster.headers.get("content-type")).toBe("image/jpeg");

    const gallery = await app.request("/api/video/gallery?tags=clip");
    const galleryBody = (await gallery.json()) as { videos: Asset[]; total: number };
    expect(galleryBody.total).toBe(1);
    expect(galleryBody.videos[0]?.id).toBe(asset.id);

    const recent = await app.request("/api/video/recent");
    const recentBody = (await recent.json()) as { job: Job; videos: Asset[] };
    expect(recentBody.job.id).toBe(job.id);
    expect(recentBody.videos).toHaveLength(1);
  });

  test("generate validates its body", async () => {
    const bad = await app.request("/api/video/generate", postJson({ prompt: "x" }));
    expect(bad.status).toBe(400);
  });

  test("providers lists the video registry", async () => {
    const res = await app.request("/api/video/providers");
    expect(res.status).toBe(200);
    const { providers } = (await res.json()) as { providers: VideoProviderInfo[] };
    const ids = providers.map((p) => p.id);
    expect(ids).toContain("fal");
    expect(ids).toContain("runway");
    expect(providers.find((p) => p.id === "fal")?.workflows).toContain("t2v");
  });

  test("capabilities defaults to the stub with the full workflow vocabulary", async () => {
    const res = await app.request("/api/video/capabilities");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { provider: string; capabilities: { workflows: unknown[] } };
    expect(body.provider).toBe("stub");
    expect(body.capabilities.workflows).toHaveLength(10);
  });
});
