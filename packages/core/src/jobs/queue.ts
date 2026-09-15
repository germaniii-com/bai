import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { newId, systemClock, type Asset, type Clock, type Job, type JobId, type JobKind, type SessionId } from "@bai/shared";
import type { Bus } from "../event/bus";
import type { Store } from "../store/store";
import type { JobExecutor } from "../workbench/types";
import { isRetryableJobError } from "../workbench/media/adapter";

export interface JobLimits {
  /** Per-attempt wall-clock ceiling for the whole job (ms). */
  timeoutMs: number;
  /** Maximum attempts for retryable failures (>= 1). */
  maxAttempts: number;
  /** Base backoff between attempts (ms); doubles per attempt, capped. */
  backoffMs: number;
  /** How many jobs may run concurrently (>= 1). */
  concurrency: number;
}

const DEFAULT_LIMITS: JobLimits = { timeoutMs: 180_000, maxAttempts: 3, backoffMs: 1500, concurrency: 3 };
const MAX_BACKOFF_MS = 30_000;

/** Analytics dimensions gathered per job (for the media_events row). */
interface JobMeta {
  started: number;
  provider?: string;
  model?: string;
  account?: string;
  mode?: "t2i" | "i2i";
}

export interface JobQueueDeps {
  store: Store;
  bus: Bus;
  clock?: Clock;
  assetsDir: string;
  executors: Partial<Record<JobKind, JobExecutor>>;
  /** Live job-runtime limits (config jobs.*); defaults when unset. */
  limits?: () => JobLimits;
}

/**
 * In-process media job worker. Jobs are persisted (SQLite) so a crash is
 * recoverable, and up to `concurrency` run at once (media work is provider
 * I/O bound — parallel generations with independent prompts). A hung provider
 * can never wedge the queue: every run has a deadline, and transient failures
 * retry with abortable backoff. Interrupted jobs are reconciled on `start()`;
 * `stop()` cancels in-flight work on shutdown.
 */
export class JobQueue {
  private inFlight = new Map<JobId, Promise<void>>();
  private pumpScheduled = false;
  private stopping = false;
  private scheduledTimer: ReturnType<typeof setTimeout> | undefined;
  private aborters = new Map<JobId, AbortController>();
  /** Per-job analytics dimensions reported by the executor via `ctx.describe`. */
  private jobMeta = new Map<JobId, JobMeta>();
  /** Callers awaiting a job's terminal status (the agent image tool). */
  private waiters = new Map<JobId, Array<(job: Job | undefined) => void>>();
  private readonly clock: Clock;

  constructor(private deps: JobQueueDeps) {
    this.clock = deps.clock ?? systemClock;
  }

  private limits(): JobLimits {
    const configured = this.deps.limits?.();
    return {
      timeoutMs: configured?.timeoutMs ?? DEFAULT_LIMITS.timeoutMs,
      maxAttempts: Math.max(1, configured?.maxAttempts ?? DEFAULT_LIMITS.maxAttempts),
      backoffMs: Math.max(0, configured?.backoffMs ?? DEFAULT_LIMITS.backoffMs),
      concurrency: Math.max(1, configured?.concurrency ?? DEFAULT_LIMITS.concurrency),
    };
  }

  /**
   * Boot the worker: reconcile jobs left `running` by a previous process
   * (marked `error` — cost-safe, the user retries deliberately) and drain any
   * `queued` rows left behind. Call once at startup.
   */
  start(): void {
    this.stopping = false;
    const recovered = this.deps.store.jobs.resetRunning("interrupted by restart", this.clock.iso());
    if (recovered > 0) {
      console.warn(`[bai] jobs: marked ${recovered} interrupted job(s) as error`);
    }
    this.schedule();
  }

  /** Stop the worker: cancel in-flight jobs and wait briefly for them to settle. */
  async stop(opts: { timeoutMs?: number } = {}): Promise<void> {
    this.stopping = true;
    if (this.scheduledTimer !== undefined) {
      clearTimeout(this.scheduledTimer);
      this.scheduledTimer = undefined;
    }
    this.pumpScheduled = false;
    for (const ac of this.aborters.values()) ac.abort();
    const deadline = Date.now() + (opts.timeoutMs ?? 3000);
    while (this.inFlight.size > 0 && Date.now() < deadline) {
      await sleep(20);
    }
    // Safety net for executors that ignored the abort signal.
    for (const id of this.aborters.keys()) this.markCancelled(id);
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
    const job = this.deps.store.jobs.get(jobId);
    if (job === undefined) return undefined;
    this.aborters.get(jobId)?.abort();
    if (job.status === "queued") {
      const cancelled = this.deps.store.jobs.update(jobId, {
        status: "cancelled",
        note: null,
        now: this.clock.iso(),
      });
      if (cancelled) this.emit(cancelled);
      return cancelled;
    }
    return job;
  }

  /** Re-enqueue a terminal job's input as a fresh job (surface "Retry"). */
  retry(jobId: JobId): Job | undefined {
    const job = this.deps.store.jobs.get(jobId);
    if (job === undefined) return undefined;
    if (job.status === "queued" || job.status === "running") return job;
    return this.enqueue(job.kind, job.sessionId, job.input);
  }

  /**
   * Await a job's terminal status (`done`/`error`/`cancelled`). Resolves
   * immediately for an unknown or already-terminal job. When `signal` aborts,
   * the wait resolves with the current row (the caller decides whether to
   * cancel) — an interrupted run must never park here.
   */
  waitFor(jobId: JobId, signal?: AbortSignal): Promise<Job | undefined> {
    const job = this.deps.store.jobs.get(jobId);
    if (job === undefined || isTerminal(job.status)) return Promise.resolve(job);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: Job | undefined): void => {
        if (settled) return;
        settled = true;
        const list = this.waiters.get(jobId);
        if (list !== undefined) {
          const next = list.filter((entry) => entry !== finish);
          if (next.length > 0) this.waiters.set(jobId, next);
          else this.waiters.delete(jobId);
        }
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const onAbort = (): void => finish(this.deps.store.jobs.get(jobId));
      if (signal !== undefined) {
        if (signal.aborted) {
          finish(job);
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }
      const list = this.waiters.get(jobId) ?? [];
      list.push(finish);
      this.waiters.set(jobId, list);
    });
  }

  private emit(job: Job): void {
    this.deps.bus.publish({
      seq: 0,
      type: "job.updated",
      ts: this.clock.iso(),
      ...(job.sessionId !== undefined ? { sessionId: job.sessionId } : {}),
      payload: { job },
    });
    this.settle(job);
  }

  /** Resolve any waiters once the job reaches a terminal status. */
  private settle(job: Job): void {
    if (!isTerminal(job.status)) return;
    const list = this.waiters.get(job.id);
    if (list === undefined) return;
    this.waiters.delete(job.id);
    for (const resolve of list) resolve(job);
  }

  private schedule(): void {
    if (this.pumpScheduled || this.stopping) return;
    this.pumpScheduled = true;
    this.scheduledTimer = setTimeout(() => {
      this.scheduledTimer = undefined;
      this.pumpScheduled = false;
      this.pump();
    }, 0);
    (this.scheduledTimer as unknown as { unref?: () => void }).unref?.();
  }

  /**
   * Start as many queued jobs as the concurrency limit allows. `run()` flips a
   * job to `running` synchronously before its first await, so the next
   * `nextQueued()` never re-picks it.
   */
  private pump(): void {
    if (this.stopping) return;
    const limit = this.limits().concurrency;
    while (!this.stopping && this.inFlight.size < limit) {
      let job: Job | undefined;
      try {
        job = this.deps.store.jobs.nextQueued();
      } catch {
        return; // store closed during teardown — nothing left to drain
      }
      if (job === undefined) break;
      const id = job.id;
      const promise = this.run(job)
        .catch((err) => {
          console.warn(`[bai] job ${id} crashed: ${err instanceof Error ? err.message : String(err)}`);
        })
        .finally(() => {
          this.inFlight.delete(id);
          if (!this.stopping) this.schedule();
        });
      this.inFlight.set(id, promise);
    }
  }

  private setProgress(id: JobId, pct: number): void {
    const clamped = Math.max(0, Math.min(1, pct));
    const updated = this.deps.store.jobs.update(id, { progress: clamped, now: this.clock.iso() });
    if (updated) this.emit(updated);
  }

  private async run(job: Job): Promise<void> {
    const executor = this.deps.executors[job.kind];
    if (!executor) {
      this.fail(job, `No executor registered for job kind "${job.kind}"`);
      return;
    }
    const limits = this.limits();
    const ac = new AbortController();
    this.aborters.set(job.id, ac);
    let timedOut = false;
    const deadline = Date.now() + limits.timeoutMs;
    const started = Date.now();
    const meta: JobMeta = { started };
    this.jobMeta.set(job.id, meta);
    const running = this.deps.store.jobs.update(job.id, {
      status: "running",
      attempt: 1,
      note: null,
      now: this.clock.iso(),
    });
    if (running) this.emit(running);

    let attempt = 0;
    try {
      for (;;) {
        attempt += 1;
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          timedOut = true;
          break;
        }
        const timer = setTimeout(() => {
          timedOut = true;
          ac.abort();
        }, remaining);
        (timer as unknown as { unref?: () => void }).unref?.();
        try {
          const result = await executor(
            { id: job.id, input: job.input },
            {
              progress: (pct) => this.setProgress(job.id, pct),
              signal: ac.signal,
              describe: (reported) => Object.assign(meta, reported),
              ...(job.sessionId !== undefined ? { sessionId: job.sessionId } : {}),
            },
          );
          if (ac.signal.aborted) {
            // Cancelled (or timed out) while the executor was finishing: do
            // NOT persist assets for an aborted job.
            if (timedOut) this.fail(job, timeoutMessage(limits.timeoutMs), attempt);
            else this.markCancelled(job.id);
            return;
          }
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
            error: null,
            note: null,
            progress: 1,
            attempt,
            now: this.clock.iso(),
          });
          if (done) this.emit(done);
          console.info(
            `[bai] job ${job.id} (${job.kind}) done in ${Date.now() - started}ms (attempt ${attempt})`,
          );
          const cost = costOf(result.output);
          this.recordMedia(job, meta, {
            ok: true,
            images: result.files.length,
            ...(cost !== undefined ? { costUsd: cost } : {}),
          });
          return;
        } catch (err) {
          if (ac.signal.aborted) {
            if (timedOut) this.fail(job, timeoutMessage(limits.timeoutMs), attempt);
            else this.markCancelled(job.id);
            return;
          }
          const message = err instanceof Error ? err.message : String(err);
          const canRetry =
            isRetryableJobError(err) && attempt < limits.maxAttempts && Date.now() < deadline;
          if (canRetry) {
            const backoff = Math.min(limits.backoffMs * 2 ** (attempt - 1), MAX_BACKOFF_MS);
            const note = `retrying ${attempt + 1}/${limits.maxAttempts} after: ${message}`;
            console.warn(`[bai] job ${job.id} (${job.kind}) attempt ${attempt} failed — ${note}`);
            const updated = this.deps.store.jobs.update(job.id, {
              status: "running",
              attempt,
              note,
              now: this.clock.iso(),
            });
            if (updated) this.emit(updated);
            await abortableSleep(backoff, ac.signal);
            if (ac.signal.aborted) {
              if (timedOut) this.fail(job, timeoutMessage(limits.timeoutMs), attempt);
              else this.markCancelled(job.id);
              return;
            }
            continue;
          }
          this.fail(job, message, attempt);
          return;
        } finally {
          clearTimeout(timer);
        }
      }
      // Deadline exceeded before the next attempt.
      this.fail(job, timeoutMessage(limits.timeoutMs), attempt);
    } finally {
      this.aborters.delete(job.id);
      this.jobMeta.delete(job.id);
    }
  }

  private persistAsset(
    job: Job,
    file: { kind: string; mime: string; ext: string; bytes: Uint8Array; meta?: Record<string, unknown> },
  ): Asset {
    const id = newId.asset();
    const dir = path.join(this.deps.assetsDir, file.kind);
    mkdirSync(dir, { recursive: true });
    const finalPath = path.join(dir, `${id}.${file.ext}`);
    const tmpPath = `${finalPath}.tmp`;
    try {
      writeFileSync(tmpPath, file.bytes);
      renameSync(tmpPath, finalPath);
    } catch (err) {
      safeUnlink(tmpPath);
      throw err;
    }
    try {
      const asset = this.deps.store.assets.insert({
        kind: file.kind as Asset["kind"],
        mime: file.mime,
        path: finalPath,
        bytes: file.bytes.byteLength,
        meta: { ...(file.meta ?? {}) },
        jobId: job.id,
        now: this.clock.iso(),
      });
      const tags = tagsFromMeta(file.meta);
      if (tags.length > 0) this.deps.store.assetTags.insert(asset.id, tags);
      return asset;
    } catch (err) {
      // The file was written but the row failed — never leave an orphan.
      safeUnlink(finalPath);
      throw err;
    }
  }

  private markCancelled(id: JobId): void {
    const job = this.deps.store.jobs.get(id);
    if (job === undefined || job.status !== "running") return;
    const cancelled = this.deps.store.jobs.update(id, { status: "cancelled", note: null, now: this.clock.iso() });
    if (cancelled) this.emit(cancelled);
  }

  private fail(job: Job, message: string, attempt?: number): void {
    const failed = this.deps.store.jobs.update(job.id, {
      status: "error",
      error: message,
      note: null,
      ...(attempt !== undefined ? { attempt } : {}),
      now: this.clock.iso(),
    });
    if (failed) this.emit(failed);
    console.warn(`[bai] job ${job.id} (${job.kind}) failed: ${message}`);
    this.recordMedia(job, this.jobMeta.get(job.id), { ok: false, error: message });
  }

  /**
   * Record one image-generation usage row (the media_events analytics ledger)
   * at the job's terminal outcome. Best-effort — analytics must never break a
   * job. Cancellations are deliberately not recorded (user aborts aren't
   * failures, the D26 precedent).
   */
  private recordMedia(
    job: Job,
    meta: JobMeta | undefined,
    outcome: { ok: boolean; images?: number; costUsd?: number; error?: string },
  ): void {
    if (job.kind !== "image.generate") return;
    try {
      this.deps.store.mediaUsage.insert({
        provider: meta?.provider ?? "unknown",
        ...(meta?.account !== undefined ? { account: meta.account } : {}),
        model: meta?.model ?? "unknown",
        mode: meta?.mode ?? "t2i",
        images: outcome.images ?? 0,
        costUsd: outcome.costUsd ?? 0,
        durationMs: meta !== undefined ? Math.max(0, Date.now() - meta.started) : 0,
        ok: outcome.ok,
        ...(outcome.error !== undefined ? { error: outcome.error } : {}),
        now: this.clock.iso(),
      });
    } catch {
      // Analytics is advisory — never break a job.
    }
  }
}

/** Pull a finite `costUsd` out of a job result output, when present. */
function costOf(output: unknown): number | undefined {
  if (typeof output !== "object" || output === null) return undefined;
  const cost = (output as { costUsd?: unknown }).costUsd;
  return typeof cost === "number" && Number.isFinite(cost) ? cost : undefined;
}

/** A job that will not change status again. */
function isTerminal(status: Job["status"]): boolean {
  return status === "done" || status === "error" || status === "cancelled";
}

function tagsFromMeta(meta: Record<string, unknown> | undefined): string[] {
  const raw = meta?.tags;
  if (!Array.isArray(raw)) return [];
  return raw.filter((t): t is string => typeof t === "string" && t.length > 0);
}

function timeoutMessage(timeoutMs: number): string {
  return `timed out after ${Math.round(timeoutMs / 1000)}s`;
}

function safeUnlink(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    // best effort
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Sleep that returns promptly when the signal aborts (cancellation). */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
      resolve();
    };
    timer = setTimeout(finish, ms);
    (timer as unknown as { unref?: () => void }).unref?.();
    onAbort = finish;
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
