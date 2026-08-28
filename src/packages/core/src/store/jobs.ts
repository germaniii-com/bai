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
    const row = q<JobRow>(this.db, "SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at, id LIMIT 1")
      .get();
    return row ? toJob(row) : undefined;
  }

  update(id: string, patch: { status?: JobStatus; output?: unknown; error?: string; progress?: number; now: string }): Job | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    this.db
      .query("UPDATE jobs SET status = ?, output = ?, error = ?, progress = ?, updated_at = ? WHERE id = ?")
      .run(
        patch.status ?? existing.status,
        patch.output !== undefined ? JSON.stringify(patch.output) : existing.output !== undefined ? JSON.stringify(existing.output) : null,
        patch.error ?? existing.error ?? null,
        patch.progress ?? existing.progress ?? null,
        patch.now,
        id,
      );
    return this.get(id);
  }

  list(limit = 50): Job[] {
    return q<JobRow>(this.db, "SELECT * FROM jobs ORDER BY created_at DESC, id DESC LIMIT ?")
      .all(limit)
      .map(toJob);
  }
}
