import type { Asset, AssetId, AssetKind, JobId } from "@bai/shared";
import { newId } from "@bai/shared";
import { q, type SqliteDb } from "./db";

interface AssetRow {
  id: string;
  kind: string;
  mime: string;
  path: string;
  bytes: number;
  meta: string;
  job_id: string | null;
  created_at: string;
}

function toAsset(row: AssetRow): Asset {
  return {
    id: row.id as AssetId,
    kind: row.kind as AssetKind,
    mime: row.mime,
    path: row.path,
    bytes: row.bytes,
    meta: safeParse(row.meta),
    ...(row.job_id !== null ? { jobId: row.job_id as JobId } : {}),
    createdAt: row.created_at,
  };
}

function safeParse(json: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(json);
    return typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export class AssetsRepo {
  constructor(private db: SqliteDb) {}

  insert(opts: {
    kind: AssetKind;
    mime: string;
    path: string;
    bytes: number;
    meta?: Record<string, unknown>;
    jobId?: JobId;
    now: string;
  }): Asset {
    const id = newId.asset();
    this.db
      .query("INSERT INTO assets (id, kind, mime, path, bytes, meta, job_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, opts.kind, opts.mime, opts.path, opts.bytes, JSON.stringify(opts.meta ?? {}), opts.jobId ?? null, opts.now);
    return this.get(id) as Asset;
  }

  get(id: string): Asset | undefined {
    const row = q<AssetRow>(this.db, "SELECT * FROM assets WHERE id = ?").get(id);
    return row ? toAsset(row) : undefined;
  }

  list(limit = 100, offset = 0): Asset[] {
    return q<AssetRow>(this.db, "SELECT * FROM assets ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?")
      .all(limit, offset)
      .map(toAsset);
  }

  byJob(jobId: JobId): Asset[] {
    return q<AssetRow>(this.db, "SELECT * FROM assets WHERE job_id = ? ORDER BY created_at")
      .all(jobId)
      .map(toAsset);
  }
}
