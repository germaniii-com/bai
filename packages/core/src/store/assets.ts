import type { Asset, AssetId, AssetKind, JobId, MediaGalleryCursor } from "@bai/shared";
import { newId } from "@bai/shared";
import type { SQLQueryBindings } from "bun:sqlite";
import { encodeCursor } from "./cursor";
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

/** Gallery filters for {@link AssetsRepo.listPage}. */
export interface AssetFilters {
  kind?: string;
  /** Match ANY of these normalized tags. */
  tags?: string[];
}

export interface AssetsPage {
  assets: Asset[];
  hasMore: boolean;
  nextCursor?: string;
  total: number;
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

  /** Build the shared WHERE for {@link listPage} / {@link count}. */
  private where(filters: AssetFilters): { sql: string; params: SQLQueryBindings[] } {
    const clauses: string[] = [];
    const params: SQLQueryBindings[] = [];
    if (filters.kind !== undefined) {
      clauses.push("a.kind = ?");
      params.push(filters.kind);
    }
    const tags = filters.tags?.filter((t) => t.length > 0) ?? [];
    if (tags.length > 0) {
      clauses.push(`a.id IN (SELECT asset_id FROM asset_tags WHERE tag IN (${tags.map(() => "?").join(", ")}))`);
      params.push(...tags);
    }
    return { sql: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "", params };
  }

  /**
   * Keyset-paged assets for the gallery (newest first). Tags match ANY; the
   * `(created_at, id)` cursor is stable under inserts.
   */
  listPage(limit = 60, cursor?: MediaGalleryCursor, filters: AssetFilters = {}): AssetsPage {
    const safeLimit = Math.max(1, Math.min(Math.floor(limit), 200));
    const { sql, params } = this.where(filters);
    const cursorClause =
      cursor !== undefined ? `${sql}${sql.length > 0 ? " AND" : "WHERE"} (a.created_at < ? OR (a.created_at = ? AND a.id < ?))` : sql;
    const cursorParams: SQLQueryBindings[] =
      cursor !== undefined ? [cursor.createdAt, cursor.createdAt, cursor.id] : [];
    const rows = q<AssetRow>(
      this.db,
      `SELECT a.* FROM assets a ${cursorClause} ORDER BY a.created_at DESC, a.id DESC LIMIT ?`,
    ).all(...params, ...cursorParams, safeLimit + 1);
    const hasMore = rows.length > safeLimit;
    const pageRows = hasMore ? rows.slice(0, safeLimit) : rows;
    const oldest = pageRows[pageRows.length - 1];
    return {
      assets: pageRows.map(toAsset),
      hasMore,
      total: this.count(filters),
      ...(hasMore && oldest !== undefined
        ? { nextCursor: encodeCursor({ createdAt: oldest.created_at, id: oldest.id } satisfies MediaGalleryCursor) }
        : {}),
    };
  }

  /** Total assets matching the same filters (all pages). */
  count(filters: AssetFilters = {}): number {
    const { sql, params } = this.where(filters);
    const row = q<{ n: number }>(this.db, `SELECT COUNT(*) AS n FROM assets a ${sql}`).get(...params);
    return row?.n ?? 0;
  }

  /** Delete one asset row (tags/cascade handled by the caller). */
  remove(id: string): void {
    this.db.query("DELETE FROM assets WHERE id = ?").run(id);
  }

  /** Replace one asset's metadata JSON (edited tags). */
  updateMeta(id: string, meta: Record<string, unknown>): void {
    this.db.query("UPDATE assets SET meta = ? WHERE id = ?").run(JSON.stringify(meta), id);
  }
}
