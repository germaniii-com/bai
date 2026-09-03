import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { newId, systemClock, type Asset, type Clock, type Job, type JobId, type JobKind, type SessionId } from "@bai/shared";
import type { Bus } from "../event/bus";
import type { Store } from "../store/store";
import type { JobExecutor } from "../workbench/types";

export interface JobQueueDeps {
  store: Store;
  bus: Bus;
  clock?: Clock;
  assetsDir: string;
  executors: Partial<Record<JobKind, JobExecutor>>;
}

/**
 * Sequential in-process job worker. Media jobs are I/O-bound, so the main
 * event loop suffices; state is persisted (SQLite) so crashes recover.
 * Cancellation via AbortSignal; progress reported as job.updated events.
 */
export class JobQueue {
  private running = false;
  private aborters = new Map<JobId, AbortController>();
  private readonly clock: Clock;

  constructor(private deps: JobQueueDeps) {
    this.clock = deps.clock ?? systemClock;
  }

  enqueue(kind: JobKind, sessionId: SessionId | undefined, input: unknown): Job {
    const job = this.deps.store.jobs.insert({
      kind,
      ...(sessionId !== undefined ? { sessionId } : {}),
      input,
      now: this.clock.iso(),
    });
    this.emit(job);
    this.schedule();
    return job;
  }

  cancel(jobId: JobId): Job | undefined {
    this.aborters.get(jobId)?.abort();
    const job = this.deps.store.jobs.get(jobId);
    if (job && job.status === "queued") {
      const cancelled = this.deps.store.jobs.update(jobId, { status: "cancelled", now: this.clock.iso() });
      if (cancelled) this.emit(cancelled);
      return cancelled;
    }
    return job;
  }

  private emit(job: Job): void {
    this.deps.bus.publish({
      seq: 0,
      type: "job.updated",
      ts: this.clock.iso(),
      ...(job.sessionId !== undefined ? { sessionId: job.sessionId } : {}),
      payload: { job },
    });
  }

  private schedule(): void {
    if (this.running) return;
    this.running = true;
    setTimeout(() => {
      void this.drain();
    }, 0);
  }

  private async drain(): Promise<void> {
    try {
      for (;;) {
        const job = this.deps.store.jobs.nextQueued();
        if (!job) break;
        await this.run(job);
      }
    } finally {
      this.running = false;
    }
  }

  private async run(job: Job): Promise<void> {
    const executor = this.deps.executors[job.kind];
    if (!executor) {
      this.fail(job, `No executor registered for job kind "${job.kind}"`);
      return;
    }
    const ac = new AbortController();
    this.aborters.set(job.id, ac);
    const running = this.deps.store.jobs.update(job.id, { status: "running", now: this.clock.iso() });
    if (running) this.emit(running);
    try {
      const result = await executor(
        { id: job.id, input: job.input },
        {
          progress: (pct) => {
            const updated = this.deps.store.jobs.update(job.id, { progress: pct, now: this.clock.iso() });
            if (updated) this.emit(updated);
          },
          signal: ac.signal,
          ...(job.sessionId !== undefined ? { sessionId: job.sessionId } : {}),
        },
      );
      const assetIds: string[] = [];
      for (const file of result.files) {
        const asset = this.persistAsset(job, file);
        assetIds.push(asset.id);
        this.deps.bus.publish({
          seq: 0,
          type: "asset.created",
          ts: this.clock.iso(),
          ...(job.sessionId !== undefined ? { sessionId: job.sessionId } : {}),
          payload: { asset },
        });
      }
      const done = this.deps.store.jobs.update(job.id, {
        status: "done",
        output: result.output ?? { assetIds },
        now: this.clock.iso(),
      });
      if (done) this.emit(done);
    } catch (err) {
      if (ac.signal.aborted) {
        const cancelled = this.deps.store.jobs.update(job.id, { status: "cancelled", now: this.clock.iso() });
        if (cancelled) this.emit(cancelled);
      } else {
        this.fail(job, err instanceof Error ? err.message : String(err));
      }
    } finally {
      this.aborters.delete(job.id);
    }
  }

  private persistAsset(job: Job, file: { kind: string; mime: string; ext: string; bytes: Uint8Array; meta?: Record<string, unknown> }): Asset {
    const id = newId.asset();
    const dir = path.join(this.deps.assetsDir, file.kind);
    mkdirSync(dir, { recursive: true });
    const file2 = path.join(dir, `${id}.${file.ext}`);
    writeFileSync(file2, file.bytes);
    return this.deps.store.assets.insert({
      kind: file.kind as Asset["kind"],
      mime: file.mime,
      path: file2,
      bytes: file.bytes.byteLength,
      meta: { ...(file.meta ?? {}) },
      jobId: job.id,
      now: this.clock.iso(),
    });
  }

  private fail(job: Job, message: string): void {
    const failed = this.deps.store.jobs.update(job.id, { status: "error", error: message, now: this.clock.iso() });
    if (failed) this.emit(failed);
  }
}
