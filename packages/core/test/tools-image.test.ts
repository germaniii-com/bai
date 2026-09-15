import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MediaAssetRef } from "@bai/shared";
import { makeCore, type TestCore } from "./harness";
import type { ToolContext } from "../src";

function ctxFor(sessionId: string, cwd?: string): ToolContext {
  return {
    sessionId: sessionId as ToolContext["sessionId"],
    ...(cwd !== undefined ? { cwd } : {}),
    signal: new AbortController().signal,
    emitLive: () => {},
  };
}

function assetsOf(result: { meta?: Record<string, unknown> }): MediaAssetRef[] {
  return (result.meta?.assets ?? []) as MediaAssetRef[];
}

describe("image.generate tool", () => {
  let t: TestCore;

  beforeEach(() => {
    t = makeCore();
  });

  afterEach(() => {
    t.store.close();
    rmSync(t.dir, { recursive: true, force: true });
  });

  test("is registered and offered to the build agent", () => {
    expect(t.tools.has("image.generate")).toBe(true);
  });

  test("text-to-image runs a real job and returns the assets", async () => {
    const session = t.core.createSession({ workbench: "chat" });
    const result = await t.tools.execute(
      "image.generate",
      { prompt: "a red cube", count: 2 },
      ctxFor(session.id),
    );
    const assets = assetsOf(result);
    expect(assets).toHaveLength(2);
    expect(result.content).toContain("Generated 2 images");
    expect(result.content).toContain("T2I");
    const jobs = t.store.jobs.list().filter((j) => j.kind === "image.generate");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.status).toBe("done");
    // Recorded in the media analytics ledger too.
    expect(t.store.mediaUsage.list()).toHaveLength(1);
  });

  test("merges the Image Generation settings defaults (params + tags)", async () => {
    t.config.imageGen = { provider: "stub", model: "stub", params: { count: 2 }, tags: ["cat"] };
    const session = t.core.createSession({ workbench: "chat" });
    const result = await t.tools.execute("image.generate", { prompt: "a blue sphere" }, ctxFor(session.id));
    expect(assetsOf(result)).toHaveLength(2);
    expect(t.core.imageGallery(10, undefined, ["cat"]).images).toHaveLength(2);
  });

  test("explicit args win over the configured count", async () => {
    t.config.imageGen = { provider: "stub", model: "stub", params: { count: 3 } };
    const session = t.core.createSession({ workbench: "chat" });
    const result = await t.tools.execute("image.generate", { prompt: "x", count: 1 }, ctxFor(session.id));
    expect(assetsOf(result)).toHaveLength(1);
  });

  test("image-to-image needs a reference", async () => {
    const session = t.core.createSession({ workbench: "chat" });
    await expect(
      t.tools.execute("image.generate", { prompt: "x", workflow: "i2i" }, ctxFor(session.id)),
    ).rejects.toThrow(/reference/);
  });

  test("image-to-image reads a workspace file as the reference", async () => {
    writeFileSync(join(t.dir, "ref.png"), new Uint8Array([1, 2, 3, 4]));
    const session = t.core.createSession({ workbench: "code", cwd: t.dir });
    const result = await t.tools.execute(
      "image.generate",
      { prompt: "paint it", workflow: "i2i", reference: "ref.png" },
      ctxFor(session.id, t.dir),
    );
    const assets = assetsOf(result);
    expect(assets).toHaveLength(1);
    // The reference was stored as an asset (attachment).
    expect(t.store.assets.list().some((a) => a.meta.attachment === true)).toBe(true);
  });

  test("save_to copies the generated files into the workspace", async () => {
    const session = t.core.createSession({ workbench: "code", cwd: t.dir });
    const result = await t.tools.execute(
      "image.generate",
      { prompt: "a cat", save_to: "out" },
      ctxFor(session.id, t.dir),
    );
    expect(existsSync(join(t.dir, "out", "a-cat-1.png"))).toBe(true);
    expect(result.content).toContain("Wrote 1 file(s)");
  });

  test("a reference outside the workspace is refused", async () => {
    const session = t.core.createSession({ workbench: "code", cwd: t.dir });
    await expect(
      t.tools.execute(
        "image.generate",
        { prompt: "x", workflow: "i2i", reference: "/etc/hosts" },
        ctxFor(session.id, t.dir),
      ),
    ).rejects.toThrow(/outside this session's workspace/);
  });
});
