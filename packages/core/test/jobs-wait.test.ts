import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus, JobQueue, MediaGenError, Store, type JobExecutor } from "../src";

function makeQueue(executors: Record<string, JobExecutor>): {
  store: Store;
  queue: JobQueue;
  cleanup: () => Promise<void>;
} {
  const dir = mkdtempSync(join(tmpdir(), "bai-jobs-wait-"));
  const store = new Store(join(dir, "test.db"));
  const queue = new JobQueue({ store, bus: new Bus(), assetsDir: join(dir, "assets"), executors });
  return {
    store,
    queue,
    cleanup: async () => {
      await queue.stop({ timeoutMs: 200 });
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("timeout waiting for condition");
}

describe("JobQueue.waitFor", () => {
  test("resolves when the job completes", async () => {
    const stack = makeQueue({ "image.generate": async () => ({ files: [] }) });
    const job = stack.queue.enqueue("image.generate", undefined, { prompt: "x" });
    const done = await stack.queue.waitFor(job.id);
    expect(done?.status).toBe("done");
    await stack.cleanup();
  });

  test("resolves when the job fails", async () => {
    const stack = makeQueue({
      "image.generate": async () => {
        throw new MediaGenError("boom", { retryable: false });
      },
    });
    const job = stack.queue.enqueue("image.generate", undefined, { prompt: "x" });
    const done = await stack.queue.waitFor(job.id);
    expect(done?.status).toBe("error");
    expect(done?.error).toBe("boom");
    await stack.cleanup();
  });

  test("resolves immediately for terminal and unknown jobs", async () => {
    const stack = makeQueue({ "image.generate": async () => ({ files: [] }) });
    const job = stack.queue.enqueue("image.generate", undefined, { prompt: "x" });
    await stack.queue.waitFor(job.id);
    expect((await stack.queue.waitFor(job.id))?.status).toBe("done");
    expect(await stack.queue.waitFor("job_missing" as never)).toBeUndefined();
    await stack.cleanup();
  });

  test("an abort resolves the wait so the caller can cancel", async () => {
    const stack = makeQueue({
      "image.generate": async (_job, ctx) =>
        await new Promise<never>((_resolve, reject) => {
          ctx.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    const job = stack.queue.enqueue("image.generate", undefined, { prompt: "x" });
    await waitFor(() => stack.store.jobs.get(job.id)?.status === "running");

    const ac = new AbortController();
    const waiting = stack.queue.waitFor(job.id, ac.signal);
    ac.abort();
    const current = await waiting;
    expect(current?.status).toBe("running");
    stack.queue.cancel(job.id);
    await waitFor(() => stack.store.jobs.get(job.id)?.status === "cancelled");
    await stack.cleanup();
  });
});
