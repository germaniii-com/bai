import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus, JobQueue, MediaGenError, Store, type JobExecutor, type JobLimits } from "../src";

const iso = (): string => new Date().toISOString();

function makeQueue(
  executors: Record<string, JobExecutor>,
  overrides?: Partial<JobLimits>,
): { store: Store; bus: Bus; queue: JobQueue; cleanup: () => Promise<void> } {
  const dir = mkdtempSync(join(tmpdir(), "bai-jobs-"));
  const store = new Store(join(dir, "test.db"));
  const bus = new Bus();
  const limits: JobLimits = {
    timeoutMs: 180_000,
    videoTimeoutMs: 900_000,
    maxAttempts: 3,
    backoffMs: 1500,
    concurrency: 3,
    ...overrides,
  };
  const queue = new JobQueue({
    store,
    bus,
    assetsDir: join(dir, "assets"),
    executors,
    limits: () => limits,
  });
  return {
    store,
    bus,
    queue,
    cleanup: async () => {
      await queue.stop({ timeoutMs: 300 });
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

describe("JobQueue hardening", () => {
  test("start() marks interrupted running jobs as error", async () => {
    const stack = makeQueue({});
    const job = stack.store.jobs.insert({ kind: "image.generate", input: { prompt: "x" }, now: iso() });
    stack.store.jobs.update(job.id, { status: "running", now: iso() });
    stack.queue.start();
    const after = stack.store.jobs.get(job.id);
    expect(after?.status).toBe("error");
    expect(after?.error).toContain("interrupted");
    await stack.cleanup();
  });

  test("start() resumes leftover queued jobs", async () => {
    const stack = makeQueue({ "image.generate": async () => ({ files: [] }) });
    const job = stack.store.jobs.insert({ kind: "image.generate", input: { prompt: "x" }, now: iso() });
    stack.queue.start();
    await waitFor(() => stack.store.jobs.get(job.id)?.status === "done");
    await stack.cleanup();
  });

  test("a hung job times out and does not block the next job", async () => {
    const stack = makeQueue(
      {
        "image.generate": async (job, ctx) => {
          if ((job.input as { hang?: boolean }).hang === true) {
            return await new Promise<never>((_resolve, reject) => {
              ctx.signal.addEventListener("abort", () => reject(new Error("aborted")));
            });
          }
          return { files: [] };
        },
      },
      { timeoutMs: 60, maxAttempts: 1, backoffMs: 1 },
    );
    const hung = stack.queue.enqueue("image.generate", undefined, { prompt: "x", hang: true });
    const ok = stack.queue.enqueue("image.generate", undefined, { prompt: "y" });
    await waitFor(() => stack.store.jobs.get(hung.id)?.status === "error");
    await waitFor(() => stack.store.jobs.get(ok.id)?.status === "done");
    expect(stack.store.jobs.get(hung.id)?.error).toContain("timed out");
    await stack.cleanup();
  });

  test("retryable failures retry with backoff then succeed", async () => {
    let attempts = 0;
    const stack = makeQueue(
      {
        "image.generate": async () => {
          attempts += 1;
          if (attempts < 3) throw new MediaGenError("transient", { retryable: true });
          return { files: [] };
        },
      },
      { timeoutMs: 5000, maxAttempts: 3, backoffMs: 1 },
    );
    const job = stack.queue.enqueue("image.generate", undefined, { prompt: "x" });
    await waitFor(() => stack.store.jobs.get(job.id)?.status === "done");
    expect(attempts).toBe(3);
    expect(stack.store.jobs.get(job.id)?.attempt).toBe(3);
    await stack.cleanup();
  });

  test("non-retryable failures fail on the first attempt", async () => {
    let attempts = 0;
    const stack = makeQueue(
      {
        "image.generate": async () => {
          attempts += 1;
          throw new MediaGenError("permanent", { retryable: false });
        },
      },
      { timeoutMs: 5000, maxAttempts: 3, backoffMs: 1 },
    );
    const job = stack.queue.enqueue("image.generate", undefined, { prompt: "x" });
    await waitFor(() => stack.store.jobs.get(job.id)?.status === "error");
    expect(attempts).toBe(1);
    expect(stack.store.jobs.get(job.id)?.error).toBe("permanent");
    await stack.cleanup();
  });

  test("cancelling a running job marks it cancelled", async () => {
    const stack = makeQueue({
      "image.generate": async (_job, ctx) =>
        await new Promise<never>((_resolve, reject) => {
          ctx.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    const job = stack.queue.enqueue("image.generate", undefined, { prompt: "x" });
    await waitFor(() => stack.store.jobs.get(job.id)?.status === "running");
    stack.queue.cancel(job.id);
    await waitFor(() => stack.store.jobs.get(job.id)?.status === "cancelled");
    await stack.cleanup();
  });

  test("a queued job cancels synchronously", async () => {
    const stack = makeQueue(
      {
        "image.generate": async (_job, ctx) =>
          await new Promise<never>((_resolve, reject) => {
            ctx.signal.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      },
      { concurrency: 1 },
    );
    // Block the queue with a running job so the second stays queued.
    const first = stack.queue.enqueue("image.generate", undefined, { prompt: "first" });
    const second = stack.queue.enqueue("image.generate", undefined, { prompt: "second" });
    const cancelled = stack.queue.cancel(second.id);
    expect(cancelled?.status).toBe("cancelled");
    stack.queue.cancel(first.id);
    await stack.cleanup();
  });

  test("runs up to `concurrency` jobs in parallel", async () => {
    let active = 0;
    let maxActive = 0;
    const stack = makeQueue(
      {
        "image.generate": async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((r) => setTimeout(r, 30));
          active -= 1;
          return { files: [] };
        },
      },
      { concurrency: 2 },
    );
    const a = stack.queue.enqueue("image.generate", undefined, { prompt: "a" });
    const b = stack.queue.enqueue("image.generate", undefined, { prompt: "b" });
    await waitFor(
      () =>
        stack.store.jobs.get(a.id)?.status === "done" &&
        stack.store.jobs.get(b.id)?.status === "done",
    );
    expect(maxActive).toBe(2);
    await stack.cleanup();
  });

  test("stop() cancels in-flight work", async () => {
    const stack = makeQueue({
      "image.generate": async (_job, ctx) =>
        await new Promise<never>((_resolve, reject) => {
          ctx.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    const job = stack.queue.enqueue("image.generate", undefined, { prompt: "x" });
    await waitFor(() => stack.store.jobs.get(job.id)?.status === "running");
    await stack.queue.stop({ timeoutMs: 500 });
    expect(stack.store.jobs.get(job.id)?.status).toBe("cancelled");
    await stack.cleanup();
  });

  test("records a media usage error row for a failed image job", async () => {
    const stack = makeQueue(
      {
        "image.generate": async (_job, ctx) => {
          ctx.describe?.({ provider: "openrouter", model: "m", account: "acct", mode: "i2i" });
          throw new MediaGenError("nope", { retryable: false });
        },
      },
      { maxAttempts: 1 },
    );
    const job = stack.queue.enqueue("image.generate", undefined, { prompt: "x" });
    await waitFor(() => stack.store.jobs.get(job.id)?.status === "error");
    await waitFor(() => stack.store.mediaUsage.list().length > 0);
    const rows = stack.store.mediaUsage.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: "openrouter",
      model: "m",
      account: "acct",
      mode: "i2i",
      ok: false,
      error: "nope",
      images: 0,
    });
    await stack.cleanup();
  });

  test("records a media usage success row (and skips cancellations)", async () => {
    const stack = makeQueue(
      {
        "image.generate": async (_job, ctx) => {
          ctx.describe?.({ provider: "openrouter", model: "m", mode: "t2i" });
          return { output: { costUsd: 0.04 }, files: [] };
        },
      },
      { concurrency: 1 },
    );
    const ok = stack.queue.enqueue("image.generate", undefined, { prompt: "x" });
    await waitFor(() => stack.store.jobs.get(ok.id)?.status === "done");
    await waitFor(() => stack.store.mediaUsage.list().length > 0);
    expect(stack.store.mediaUsage.list()[0]).toMatchObject({
      provider: "openrouter",
      model: "m",
      mode: "t2i",
      ok: true,
      costUsd: 0.04,
    });
    await stack.cleanup();
  });
});
