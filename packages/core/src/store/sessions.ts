import type { Session, SessionId, SessionsCursor, SessionsPage, WorkbenchName } from "@bai/shared";
import { newId } from "@bai/shared";
import type { SQLQueryBindings } from "bun:sqlite";
import { q, type SqliteDb } from "./db";
import { encodeCursor, escapeLike } from "./cursor";

/** Optional equality/substring filters every session list shares. */
export interface SessionsFilters {
  workbench?: string;
  cwd?: string;
  /** Case-insensitive substring over title or id (UI type-to-filter). */
  q?: string;
  /** Exclude child (subagent) sessions — meta.parent set. */
  roots?: boolean;
}

interface SessionRow {
  id: string;
  title: string;
  workbench: string;
  cwd: string | null;
  created_at: string;
  updated_at: string;
  meta: string;
}

function toSession(row: SessionRow): Session {
  return {
    id: row.id as SessionId,
    title: row.title,
    workbench: row.workbench as WorkbenchName,
    ...(row.cwd !== null ? { cwd: row.cwd } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    meta: safeParse(row.meta),
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

export class SessionsRepo {
  constructor(private db: SqliteDb) {}

  insert(opts: {
    title?: string;
    workbench: WorkbenchName;
    cwd?: string;
    meta?: Record<string, unknown>;
    now: string;
  }): Session {
    const id = newId.session();
    this.db
      .query(
        "INSERT INTO sessions (id, title, workbench, cwd, created_at, updated_at, meta) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        opts.title ?? "",
        opts.workbench,
        opts.cwd ?? null,
        opts.now,
        opts.now,
        JSON.stringify(opts.meta ?? {}),
      );
    return this.get(id) as Session;
  }

  get(id: string): Session | undefined {
    const row = q<SessionRow>(this.db, "SELECT * FROM sessions WHERE id = ?").get(id);
    return row ? toSession(row) : undefined;
  }

  /**
   * Shared WHERE builder. Dynamic from validated equality/substring filters —
   * parameterized (no value interpolation, only fixed clause text). Archived
   * sessions (meta.archived — the workspace-archive flow) are excluded by
   * default: every surface's lists hide them; getSession still returns them
   * so an open transcript doesn't break.
   */
  private where(filters: SessionsFilters): { sql: string; params: SQLQueryBindings[] } {
    const clauses: string[] = ["json_extract(meta, '$.archived') IS NOT 1"];
    const params: SQLQueryBindings[] = [];
    if (filters.workbench !== undefined) {
      clauses.push("workbench = ?");
      params.push(filters.workbench);
    }
    if (filters.cwd !== undefined) {
      clauses.push("cwd = ?");
      params.push(filters.cwd);
    }
    if (filters.roots === true) {
      clauses.push("json_extract(meta, '$.parent') IS NULL");
    }
    const trimmed = filters.q?.trim();
    if (trimmed !== undefined && trimmed.length > 0) {
      const like = `%${escapeLike(trimmed)}%`;
      clauses.push("(title LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\')");
      params.push(like, like);
    }
    return { sql: `WHERE ${clauses.join(" AND ")}`, params };
  }

  /** Offset-based list (legacy/internal reads; UI uses `listPage`). */
  list(limit = 50, offset = 0, filters: SessionsFilters = {}): Session[] {
    const { sql, params } = this.where(filters);
    const rows = q<SessionRow>(
      this.db,
      `SELECT * FROM sessions ${sql} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`,
    ).all(...params, limit, offset);
    return rows.map(toSession);
  }

  /** Total sessions matching the filters (all pages) — the list indicator. */
  count(filters: SessionsFilters = {}): number {
    const { sql, params } = this.where(filters);
    const row = q<{ n: number }>(this.db, `SELECT COUNT(*) AS n FROM sessions ${sql}`).get(...params);
    return row?.n ?? 0;
  }

  /**
   * Keyset-paged list (newest first) with an `(updated_at, id)` cursor —
   * stable under live reordering (offset would skip/duplicate rows as
   * sessions bump to the top). Fetches limit+1 to report `hasMore` and the
   * cursor for the next older page.
   */
  listPage(limit = 50, cursor?: SessionsCursor, filters: SessionsFilters = {}): SessionsPage {
    const safeLimit = Math.max(1, Math.min(Math.floor(limit), 200));
    const { sql, params } = this.where(filters);
    const cursorClause =
      cursor !== undefined ? `${sql} AND (updated_at < ? OR (updated_at = ? AND id < ?))` : sql;
    const cursorParams: SQLQueryBindings[] =
      cursor !== undefined ? [cursor.updatedAt, cursor.updatedAt, cursor.id] : [];
    const rows = q<SessionRow>(
      this.db,
      `SELECT * FROM sessions ${cursorClause} ORDER BY updated_at DESC, id DESC LIMIT ?`,
    ).all(...params, ...cursorParams, safeLimit + 1);
    const hasMore = rows.length > safeLimit;
    const pageRows = hasMore ? rows.slice(0, safeLimit) : rows;
    const oldest = pageRows[pageRows.length - 1];
    return {
      sessions: pageRows.map(toSession),
      hasMore,
      total: this.count(filters),
      ...(hasMore && oldest !== undefined
        ? { nextCursor: encodeCursor({ updatedAt: oldest.updated_at, id: oldest.id } satisfies SessionsCursor) }
        : {}),
    };
  }

  /**
   * ALL sessions rooted at `cwd`, archived or not — the workspace
   * remove/restore flows' bulk archive/unarchive input (no limit: a
   * workspace's full session history participates).
   */
  listByCwd(cwd: string): Session[] {
    const rows = q<SessionRow>(
      this.db,
      "SELECT * FROM sessions WHERE cwd = ? ORDER BY updated_at DESC, id DESC",
    ).all(cwd);
    return rows.map(toSession);
  }

  update(id: string, patch: { title?: string; cwd?: string; meta?: Record<string, unknown>; now: string }): Session | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    const title = patch.title ?? existing.title;
    const cwd = patch.cwd !== undefined ? patch.cwd : existing.cwd ?? null;
    const meta = JSON.stringify(patch.meta ?? existing.meta);
    this.db
      .query("UPDATE sessions SET title = ?, cwd = ?, meta = ?, updated_at = ? WHERE id = ?")
      .run(title, cwd, meta, patch.now, id);
    return this.get(id);
  }

  touch(id: string, now: string): void {
    this.db.query("UPDATE sessions SET updated_at = ? WHERE id = ?").run(now, id);
  }
}
