import type { SessionId, SkillEventId, SkillUsageQuery, SkillUsageResponse, SkillUsageTotals } from "@bai/shared";
import type { SQLQueryBindings } from "bun:sqlite";
import { newId } from "@bai/shared";
import { q, type SqliteDb } from "./db";

/**
 * One recorded `skills.view` tool call (skill analytics): a full SKILL.md
 * view or a linked-file read, with the invoking agent/session and the
 * outcome. Failed lookups (unknown skill, traversal guard, unreadable file)
 * record ok = false plus the error message — the D26 failed-call precedent.
 */
export interface SkillEventRecord {
  id: SkillEventId;
  sessionId?: SessionId;
  skill: string;
  /** Agent that made the call (ToolContext.agent); undefined when unknown. */
  agent?: string;
  /** Linked file that was read; undefined = full SKILL.md view. */
  filePath?: string;
  ok: boolean;
  /** Error message for FAILED lookups; undefined on success. */
  error?: string;
  /** Size of the returned content in bytes (0 for failures). */
  bytes: number;
  createdAt: string;
}

interface SkillEventRow {
  id: string;
  session_id: string | null;
  skill: string;
  agent: string | null;
  file_path: string | null;
  ok: number;
  error: string | null;
  bytes: number;
  created_at: string;
}

function toRecord(row: SkillEventRow): SkillEventRecord {
  return {
    id: row.id as SkillEventId,
    ...(row.session_id !== null ? { sessionId: row.session_id as SessionId } : {}),
    skill: row.skill,
    ...(row.agent !== null ? { agent: row.agent } : {}),
    ...(row.file_path !== null ? { filePath: row.file_path } : {}),
    ok: row.ok === 1,
    ...(row.error !== null ? { error: row.error } : {}),
    bytes: row.bytes,
    createdAt: row.created_at,
  };
}

/**
 * The skill usage analytics store — one append-only row per `skills.view`
 * call. Plain aggregate data like the usage repo: not event-sourced, no bus
 * integration; surfaces read it through the skill-usage analytics API.
 */
export class SkillUsageRepo {
  constructor(private db: SqliteDb) {}

  insert(opts: {
    sessionId?: SessionId;
    skill: string;
    agent?: string;
    filePath?: string;
    ok?: boolean;
    error?: string;
    bytes?: number;
    now: string;
  }): SkillEventRecord {
    const id = newId.skillEvent();
    this.db
      .query(
        `INSERT INTO skill_events (id, session_id, skill, agent, file_path, ok, error, bytes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        opts.sessionId ?? null,
        opts.skill,
        opts.agent ?? null,
        opts.filePath ?? null,
        opts.ok === false ? 0 : 1,
        opts.error ?? null,
        opts.bytes ?? 0,
        opts.now,
      );
    return this.get(id) as SkillEventRecord;
  }

  get(id: string): SkillEventRecord | undefined {
    const row = q<SkillEventRow>(this.db, "SELECT * FROM skill_events WHERE id = ?").get(id);
    return row ? toRecord(row) : undefined;
  }

  /** Most recent rows (debugging/tests; the API aggregates, never pages). */
  list(limit = 100): SkillEventRecord[] {
    return q<SkillEventRow>(this.db, "SELECT * FROM skill_events ORDER BY created_at DESC, id DESC LIMIT ?")
      .all(limit)
      .map(toRecord);
  }

  /**
   * The skill usage aggregation (GET /api/skill/usage): KPIs, per-skill
   * totals, and the per-bucket views series. Time buckets ride the UTC
   * RFC3339 prefix (day=10, month=7, year=4 chars), which sorts
   * lexicographically — the usage repo's bucketing, verbatim.
   */
  analytics(query: SkillUsageQuery): SkillUsageResponse {
    const granLen = query.granularity === "month" ? 7 : query.granularity === "year" ? 4 : 10;

    // --- WHERE (shared by the filtered queries) ---
    const where: string[] = [];
    const whereParams: SQLQueryBindings[] = [];
    if (query.from !== undefined && query.from.length > 0) {
      where.push("created_at >= ?");
      whereParams.push(query.from);
    }
    if (query.to !== undefined && query.to.length > 0) {
      where.push("created_at < ?");
      whereParams.push(query.to);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

    // --- KPIs ---
    const kpiRow = q<{ views: number; errors: number; sessions: number }>(
      this.db,
      `SELECT COUNT(*) AS views,
              COALESCE(SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END), 0) AS errors,
              COUNT(DISTINCT session_id) AS sessions
       FROM skill_events ${whereSql}`,
    ).get(...whereParams);

    // --- per-skill totals (the top-skills table) ---
    const bySkill = q<{
      skill: string;
      views: number;
      errors: number;
      sessions: number;
      last_used_at: string | null;
    }>(
      this.db,
      `SELECT skill, COUNT(*) AS views,
              COALESCE(SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END), 0) AS errors,
              COUNT(DISTINCT session_id) AS sessions,
              MAX(created_at) AS last_used_at
       FROM skill_events ${whereSql}
       GROUP BY skill
       ORDER BY views DESC, skill`,
    ).all(...whereParams);

    // --- per-bucket views series ---
    const series = q<{ bucket: string; views: number }>(
      this.db,
      `SELECT substr(created_at, 1, ?) AS bucket, COUNT(*) AS views
       FROM skill_events ${whereSql}
       GROUP BY bucket
       ORDER BY bucket`,
    ).all(granLen, ...whereParams);

    return {
      kpis: {
        views: kpiRow?.views ?? 0,
        errors: kpiRow?.errors ?? 0,
        sessions: kpiRow?.sessions ?? 0,
      },
      bySkill: bySkill.map((r) => ({
        skill: r.skill,
        views: r.views,
        errors: r.errors,
        sessions: r.sessions,
        ...(r.last_used_at !== null ? { lastUsedAt: r.last_used_at } : {}),
      })),
      series,
    };
  }

  /** Per-skill totals for the Skills page detail pane (successful views only). */
  forSkill(name: string): SkillUsageTotals {
    const row = q<{ views: number; sessions: number; last_used_at: string | null }>(
      this.db,
      `SELECT COUNT(*) AS views,
              COUNT(DISTINCT session_id) AS sessions,
              MAX(created_at) AS last_used_at
       FROM skill_events WHERE skill = ? AND ok = 1`,
    ).get(name);
    return {
      views: row?.views ?? 0,
      sessions: row?.sessions ?? 0,
      ...(row?.last_used_at != null ? { lastUsedAt: row.last_used_at } : {}),
    };
  }
}
