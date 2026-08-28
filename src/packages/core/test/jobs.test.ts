import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeCore, waitForEvent, type TestCore } from "./harness";

describe("job queue (structured stubs)", () => {
  let t: TestCore;

  beforeEach(() => {
    t = makeCore();
  });

  afterEach(() => {
    t.store.close();
    rmSync(t.dir, { recursive: true, force: true });
  });

  test("image.generate → done + valid placeholder PNG asset", async () => {
    const assetCreated = waitForEvent(t.bus, "asset.created");
    const job = t.core.enqueueJob("image.generate", undefined, { prompt: "a red cube", count: 2 });
    expect(job.status).toBe("queued");

    const assetEvt = await assetCreated;
    const asset = assetEvt.payload.asset;
    expect(asset.kind).toBe("image");
    expect(asset.mime).toBe("image/png");

    const bytes = readFileSync(asset.path);
    // PNG signature: 89 50 4E 47 0D 0A 1A 0A
    expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    const stored = t.store.jobs.get(job.id);
    expect(stored?.status).toBe("done");
    // count=2 → two assets for the job
    expect(t.store.assets.byJob(job.id)).toHaveLength(2);
  });

  test("video.generate → done + placeholder clip asset", async () => {
    const assetCreated = waitForEvent(t.bus, "asset.created");
    const job = t.core.enqueueJob("video.generate", undefined, { prompt: "waves" });
    const assetEvt = await assetCreated;
    expect(assetEvt.payload.asset.kind).toBe("video");
    expect(t.store.jobs.get(job.id)?.status).toBe("done");
  });

  test("job.updated events fire through the pipeline", async () => {
    const job = t.core.enqueueJob("image.generate", undefined, { prompt: "x" });
    const done = waitForEvent(t.bus, "job.updated", { timeoutMs: 3000 });
    let latest = t.store.jobs.get(job.id);
    for (let i = 0; i < 100; i++) {
      latest = t.store.jobs.get(job.id);
      if (latest?.status === "done") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const evt = await done;
    expect(evt.payload.job.id).toBe(job.id);
    expect(latest?.status).toBe("done");
  });
});
