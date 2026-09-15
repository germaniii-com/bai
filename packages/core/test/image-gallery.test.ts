import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { readMediaGen } from "@bai/shared";
import { makeCore, waitForEvent, type TestCore } from "./harness";

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("timeout waiting for condition");
}

describe("image gallery (recipes + tags + paging + delete)", () => {
  let t: TestCore;

  beforeEach(() => {
    t = makeCore();
  });

  afterEach(() => {
    t.store.close();
    rmSync(t.dir, { recursive: true, force: true });
  });

  test("a generation records one media usage row", async () => {
    const created = waitForEvent(t.bus, "asset.created");
    t.core.enqueueImageGeneration({ mode: "i2i", prompt: "x", params: { count: 2 } });
    await created;
    await waitFor(() => t.store.mediaUsage.list().length > 0);
    const rows = t.store.mediaUsage.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: "stub", model: "stub", mode: "i2i", images: 2, ok: true });
  });

  test("a generation stamps its recipe and normalized tags", async () => {
    const created = waitForEvent(t.bus, "asset.created");
    t.core.enqueueImageGeneration({ mode: "t2i", prompt: "a red cube", tags: [" Cat ", "dog", "cat"] });
    const asset = (await created).payload.asset;

    const gen = readMediaGen(asset.meta);
    expect(gen?.mode).toBe("t2i");
    expect(gen?.prompt).toBe("a red cube");
    expect(gen?.tags).toEqual(["cat", "dog"]);
    expect(t.store.assetTags.listForAsset(asset.id)).toEqual(["cat", "dog"]);
  });

  test("gallery filters by tag (ANY) and reports tags", async () => {
    const created = waitForEvent(t.bus, "asset.created");
    t.core.enqueueImageGeneration({ mode: "t2i", prompt: "x", tags: ["cat", "dog"] });
    await created;

    expect(t.core.imageGallery(10).images).toHaveLength(1);
    expect(t.core.imageGallery(10).total).toBe(1);
    expect(t.core.imageGallery(10, undefined, ["cat"]).images).toHaveLength(1);
    expect(t.core.imageGallery(10, undefined, ["dog", "nope"]).images).toHaveLength(1);
    expect(t.core.imageGallery(10, undefined, ["nope"]).images).toHaveLength(0);
    expect(t.core.imageTags().map((x) => x.tag)).toEqual(["cat", "dog"]);
  });

  test("tag search is fuzzy — 'gemini' matches a 'gemini 3 pro' tag", async () => {
    const created = waitForEvent(t.bus, "asset.created");
    t.core.enqueueImageGeneration({ mode: "t2i", prompt: "x", tags: ["gemini 3 pro"] });
    await created;

    expect(t.core.imageGallery(10, undefined, ["gemini"]).images).toHaveLength(1);
    expect(t.core.imageGallery(10, undefined, ["pro"]).images).toHaveLength(1);
    expect(t.core.imageGallery(10, undefined, ["g3p"]).images).toHaveLength(1);
    expect(t.core.imageGallery(10, undefined, ["gemini nope"]).images).toHaveLength(0);
    expect(t.core.imageGallery(10, undefined, ["nope"]).images).toHaveLength(0);
    expect(t.core.imageTags("gemini").map((t) => t.tag)).toContain("gemini 3 pro");
    expect(t.core.imageTags("g3p").map((t) => t.tag)).toContain("gemini 3 pro");
  });

  test("setAssetTags replaces tags in meta, recipe, and the index", async () => {
    const created = waitForEvent(t.bus, "asset.created");
    t.core.enqueueImageGeneration({ mode: "t2i", prompt: "x", tags: ["old"] });
    const asset = (await created).payload.asset;

    const updatedEvent = waitForEvent(t.bus, "asset.updated");
    const updated = t.core.setAssetTags(asset.id, [" New ", "tag"]);
    expect(updated).toBeDefined();
    expect((await updatedEvent).payload.asset.id).toBe(asset.id);

    expect(t.store.assetTags.listForAsset(asset.id)).toEqual(["new", "tag"]);
    expect(readMediaGen(updated?.meta)?.tags).toEqual(["new", "tag"]);
    expect(t.core.imageGallery(10, undefined, ["new"]).images).toHaveLength(1);
    expect(t.core.imageGallery(10, undefined, ["old"]).images).toHaveLength(0);
    expect(t.core.imageTags().map((x) => x.tag)).toEqual(["new", "tag"]);
    expect(t.core.setAssetTags("ast_nope", ["x"])).toBeUndefined();
  });

  test("deleteAsset removes the row, tags and file", async () => {
    const created = waitForEvent(t.bus, "asset.created");
    t.core.enqueueImageGeneration({ mode: "t2i", prompt: "x", tags: ["a"] });
    const asset = (await created).payload.asset;
    expect(existsSync(asset.path)).toBe(true);

    expect(t.core.deleteAsset(asset.id)).toBe(true);
    expect(existsSync(asset.path)).toBe(false);
    expect(t.core.imageGallery(10).images).toHaveLength(0);
    expect(t.core.imageTags()).toHaveLength(0);
    expect(t.core.deleteAsset(asset.id)).toBe(false);
  });

  test("imageRecent returns the newest job and its images", async () => {
    const created = waitForEvent(t.bus, "asset.created");
    t.core.enqueueImageGeneration({ mode: "i2i", prompt: "style me", params: { count: 2 } });
    await created;

    const recent = t.core.imageRecent();
    expect(recent.job?.kind).toBe("image.generate");
    expect(recent.images).toHaveLength(2);
    expect(readMediaGen(recent.images[0]?.meta)?.mode).toBe("i2i");
  });

  test("capabilities fall back to the stub adapter without credentials", async () => {
    const caps = await t.core.imageCapabilities();
    expect(caps.provider).toBe("stub");
    expect(caps.capabilities.params.map((p) => p.key)).toContain("size");
  });
});
