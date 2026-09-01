import type { Session, SessionId, WorkbenchName } from "@bai/shared";
import { newId } from "@bai/shared";
import type { SQLQueryBindings } from "bun:sqlite";
import { q, type SqliteDb } from "./db";

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

  list(limit = 50, offset = 0, filters: { workbench?: string; cwd?: string } = {}): Session[] {
    // Dynamic WHERE from validated equality filters (parameterized — no
    // interpolation of values, only fixed clause text).
    const clauses: string[] = [];
    const params: SQLQueryBindings[] = [];
    if (filters.workbench !== undefined) {
      clauses.push("workbench = ?");
      params.push(filters.workbench);
    }
    if (filters.cwd !== undefined) {
      clauses.push("cwd = ?");
      params.push(filters.cwd);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = q<SessionRow>(
      this.db,
      `SELECT * FROM sessions ${where} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`,
    ).all(...params, limit, offset);
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
