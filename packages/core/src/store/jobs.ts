import type { Job, JobId, JobKind, JobStatus, SessionId } from "@bai/shared";
import { newId } from "@bai/shared";
import { q, type SqliteDb } from "./db";

interface JobRow {
  id: string;
  kind: string;
  session_id: string | null;
  status: string;
  input: string;
  output: string | null;
  error: string | null;
  progress: number | null;
  attempt: number;
  note: string | null;
  created_at: string;
  updated_at: string;
}

function toJob(row: JobRow): Job {
  return {
    id: row.id as JobId,
    kind: row.kind as JobKind,
    ...(row.session_id !== null ? { sessionId: row.session_id as SessionId } : {}),
    status: row.status as JobStatus,
    input: JSON.parse(row.input) as unknown,
    ...(row.output !== null ? { output: JSON.parse(row.output) as unknown } : {}),
    ...(row.error !== null ? { error: row.error } : {}),
    ...(row.progress !== null ? { progress: row.progress } : {}),
    ...(row.attempt > 0 ? { attempt: row.attempt } : {}),
    ...(row.note !== null ? { note: row.note } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class JobsRepo {
  constructor(private db: SqliteDb) {}

  insert(opts: { kind: JobKind; sessionId?: SessionId; input: unknown; now: string }): Job {
    const id = newId.job();
    this.db
      .query("INSERT INTO jobs (id, kind, session_id, status, input, created_at, updated_at) VALUES (?, ?, ?, 'queued', ?, ?, ?)")
      .run(id, opts.kind, opts.sessionId ?? null, JSON.stringify(opts.input ?? null), opts.now, opts.now);
    return this.get(id) as Job;
  }

  get(id: string): Job | undefined {
    const row = q<JobRow>(this.db, "SELECT * FROM jobs WHERE id = ?").get(id);
    return row ? toJob(row) : undefined;
  }

  nextQueued(): Job | undefined {
    const row = q<JobRow>(
      this.db,
      "SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at, id LIMIT 1",
    ).get();
    return row ? toJob(row) : undefined;
  }

  list(limit = 50): Job[] {
    return q<JobRow>(this.db, "SELECT * FROM jobs ORDER BY created_at DESC, id DESC LIMIT ?")
      .all(limit)
      .map(toJob);
  }

  /** All jobs for one session, newest first (bounded). */
  listBySession(sessionId: SessionId, limit = 100): Job[] {
    return q<JobRow>(
      this.db,
      "SELECT * FROM jobs WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT ?",
    )
      .all(sessionId, limit)
      .map(toJob);
  }

  /** The newest job of a kind (the image page's output-area seed). */
  latestOfKind(kind: JobKind): Job | undefined {
    const row = q<JobRow>(
      this.db,
      "SELECT * FROM jobs WHERE kind = ? ORDER BY created_at DESC, id DESC LIMIT 1",
    ).get(kind);
    return row ? toJob(row) : undefined;
  }

  /**
   * Recovery: any job left `running` by a previous process is marked `error`
   * with the given note. Cost-safe — a crash mid-provider-call may already
   * have billed upstream, so the user retries deliberately rather than the
   * queue silently re-charging. Returns the number of rows reset.
   */
  resetRunning(note: string, now: string): number {
    const result = this.db
      .query("UPDATE jobs SET status = 'error', error = ?, note = NULL, updated_at = ? WHERE status = 'running'")
      .run(note, now);
    return Number(result.changes ?? 0);
  }

  update(
    id: string,
    patch: {
      status?: JobStatus;
      output?: unknown;
      error?: string | null;
      progress?: number | null;
      attempt?: number;
      /** `null` clears the transient note; omitted leaves it untouched. */
      note?: string | null;
      now: string;
    },
  ): Job | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    const error = patch.error !== undefined ? patch.error : existing.error ?? null;
    const progress = patch.progress !== undefined ? patch.progress : existing.progress ?? null;
    const attempt = patch.attempt !== undefined ? patch.attempt : existing.attempt ?? 0;
    const note = patch.note !== undefined ? patch.note : existing.note ?? null;
    this.db
      .query("UPDATE jobs SET status = ?, output = ?, error = ?, progress = ?, attempt = ?, note = ?, updated_at = ? WHERE id = ?")
      .run(
        patch.status ?? existing.status,
        patch.output !== undefined ? JSON.stringify(patch.output) : existing.output !== undefined ? JSON.stringify(existing.output) : null,
        error,
        progress,
        attempt,
        note,
        patch.now,
        id,
      );
    return this.get(id);
  }
}
