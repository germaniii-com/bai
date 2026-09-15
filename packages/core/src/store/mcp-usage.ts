import type {
  McpEventId,
  McpInteractionKind,
  McpUsageQuery,
  McpUsageResponse,
  McpUsageTotals,
  SessionId,
} from "@bai/shared";
import type { SQLQueryBindings } from "bun:sqlite";
import { newId } from "@bai/shared";
import { q, type SqliteDb } from "./db";

/**
 * One recorded MCP interaction (MCP usage analytics): a namespaced
 * `mcp/<server>/<tool>` call or one of the `mcp/list_resources`,
 * `mcp/read_resource`, `mcp/list_prompts`, `mcp/get_prompt` helpers, with the
 * invoking session/agent, the outcome, and the call cost. Failed calls
 * (server error, disconnect, protocol failure) record ok = false plus the
 * error message — the D26 failed-call precedent. Raw arguments are never
 * stored: `argsDigest` is a SHA-256 of the JSON args (first 16 hex chars).
 */
export interface McpEventRecord {
  id: McpEventId;
  sessionId?: SessionId;
  server: string;
  tool: string;
  kind: McpInteractionKind;
  /** Agent that made the call (ToolContext.agent); undefined when unknown. */
  agent?: string;
  ok: boolean;
  /** Error message for FAILED calls; undefined on success. */
  error?: string;
  /** Wall-clock call duration in milliseconds. */
  durationMs: number;
  /** Bytes of returned content (0 for failures). */
  bytes: number;
  /** SHA-256 of the JSON args, first 16 hex chars (never the raw args). */
  argsDigest?: string;
  createdAt: string;
}

interface McpEventRow {
  id: string;
  session_id: string | null;
  server: string;
  tool: string;
  kind: string;
  agent: string | null;
  ok: number;
  error: string | null;
  duration_ms: number;
  bytes: number;
  args_digest: string | null;
  created_at: string;
}

function toRecord(row: McpEventRow): McpEventRecord {
  return {
    id: row.id as McpEventId,
    ...(row.session_id !== null ? { sessionId: row.session_id as SessionId } : {}),
    server: row.server,
    tool: row.tool,
    kind: row.kind as McpInteractionKind,
    ...(row.agent !== null ? { agent: row.agent } : {}),
    ok: row.ok === 1,
    ...(row.error !== null ? { error: row.error } : {}),
    durationMs: row.duration_ms,
    bytes: row.bytes,
    ...(row.args_digest !== null ? { argsDigest: row.args_digest } : {}),
    createdAt: row.created_at,
  };
}

/**
 * The MCP usage analytics store — one append-only row per MCP interaction.
 * Plain aggregate data like the usage/skill_events repos: not event-sourced,
 * no bus integration; surfaces read it through the mcp-usage analytics API.
 */
export class McpUsageRepo {
  constructor(private db: SqliteDb) {}

  insert(opts: {
    sessionId?: SessionId;
    server: string;
    tool: string;
    kind?: McpInteractionKind;
    agent?: string;
    ok?: boolean;
    error?: string;
    durationMs?: number;
    bytes?: number;
    argsDigest?: string;
    now: string;
  }): McpEventRecord {
    const id = newId.mcpEvent();
    this.db
      .query(
        `INSERT INTO mcp_events (
           id, session_id, server, tool, kind, agent, ok, error, duration_ms, bytes, args_digest, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        opts.sessionId ?? null,
        opts.server,
        opts.tool,
        opts.kind ?? "tool",
        opts.agent ?? null,
        opts.ok === false ? 0 : 1,
        opts.error ?? null,
        opts.durationMs ?? 0,
        opts.bytes ?? 0,
        opts.argsDigest ?? null,
        opts.now,
      );
    return this.get(id) as McpEventRecord;
  }

  get(id: string): McpEventRecord | undefined {
    const row = q<McpEventRow>(this.db, "SELECT * FROM mcp_events WHERE id = ?").get(id);
    return row ? toRecord(row) : undefined;
  }

  /** Most recent rows (debugging/tests; the API aggregates, never pages). */
  list(limit = 100): McpEventRecord[] {
    return q<McpEventRow>(this.db, "SELECT * FROM mcp_events ORDER BY created_at DESC, id DESC LIMIT ?")
      .all(limit)
      .map(toRecord);
  }

  /**
   * The MCP usage aggregation (GET /api/mcp/usage): KPIs, per-server and
   * per-tool totals, and the per-bucket calls/errors series. Time buckets
   * ride the UTC RFC3339 prefix (day=10, month=7, year=4 chars), which sorts
   * lexicographically — the usage repo's bucketing, verbatim.
   */
  analytics(query: McpUsageQuery): McpUsageResponse {
    const granLen = query.granularity === "month" ? 7 : query.granularity === "year" ? 4 : 10;

    // --- WHERE (shared by every filtered query) ---
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
    for (const [column, value] of [
      ["server", query.server],
      ["agent", query.agent],
      ["kind", query.kind],
    ] as const) {
      if (value !== undefined && value.length > 0) {
        where.push(`${column} = ?`);
        whereParams.push(value);
      }
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

    // --- KPIs ---
    const kpiRow = q<{
      calls: number;
      errors: number;
      sessions: number;
      servers: number;
      bytes: number;
      avg_duration: number;
    }>(
      this.db,
      `SELECT COUNT(*) AS calls,
              COALESCE(SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END), 0) AS errors,
              COUNT(DISTINCT session_id) AS sessions,
              COUNT(DISTINCT CASE WHEN server = '(all)' THEN NULL ELSE server END) AS servers,
              COALESCE(SUM(bytes), 0) AS bytes,
              COALESCE(AVG(duration_ms), 0) AS avg_duration
       FROM mcp_events ${whereSql}`,
    ).get(...whereParams);

    // --- per-server totals (the MCP activity table) ---
    const byServer = q<{
      server: string;
      calls: number;
      errors: number;
      sessions: number;
      last_used_at: string | null;
    }>(
      this.db,
      `SELECT server, COUNT(*) AS calls,
              COALESCE(SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END), 0) AS errors,
              COUNT(DISTINCT session_id) AS sessions,
              MAX(created_at) AS last_used_at
       FROM mcp_events ${whereSql}
       GROUP BY server
       ORDER BY calls DESC, server`,
    ).all(...whereParams);

    // --- per-server-per-tool totals (the tool breakdown) ---
    const byTool = q<{
      server: string;
      tool: string;
      kind: string;
      calls: number;
      errors: number;
      avg_duration: number;
      bytes: number;
    }>(
      this.db,
      `SELECT server, tool, kind, COUNT(*) AS calls,
              COALESCE(SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END), 0) AS errors,
              COALESCE(AVG(duration_ms), 0) AS avg_duration,
              COALESCE(SUM(bytes), 0) AS bytes
       FROM mcp_events ${whereSql}
       GROUP BY server, tool, kind
       ORDER BY calls DESC, server, tool`,
    ).all(...whereParams);

    // --- per-bucket calls/errors series ---
    const series = q<{ bucket: string; calls: number; errors: number }>(
      this.db,
      `SELECT substr(created_at, 1, ?) AS bucket, COUNT(*) AS calls,
              COALESCE(SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END), 0) AS errors
       FROM mcp_events ${whereSql}
       GROUP BY bucket
       ORDER BY bucket`,
    ).all(granLen, ...whereParams);

    return {
      kpis: {
        calls: kpiRow?.calls ?? 0,
        errors: kpiRow?.errors ?? 0,
        sessions: kpiRow?.sessions ?? 0,
        servers: kpiRow?.servers ?? 0,
        totalBytes: kpiRow?.bytes ?? 0,
        avgDurationMs: kpiRow?.avg_duration ?? 0,
      },
      byServer: byServer.map((r) => ({
        server: r.server,
        calls: r.calls,
        errors: r.errors,
        sessions: r.sessions,
        ...(r.last_used_at !== null ? { lastUsedAt: r.last_used_at } : {}),
      })),
      byTool: byTool.map((r) => ({
        server: r.server,
        tool: r.tool,
        kind: r.kind as McpInteractionKind,
        calls: r.calls,
        errors: r.errors,
        avgDurationMs: r.avg_duration,
        bytes: r.bytes,
      })),
      series,
    };
  }

  /** Per-server totals for the MCP settings detail (successful + failed). */
  forServer(name: string): McpUsageTotals {
    const row = q<{ calls: number; errors: number; sessions: number; last_used_at: string | null }>(
      this.db,
      `SELECT COUNT(*) AS calls,
              COALESCE(SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END), 0) AS errors,
              COUNT(DISTINCT session_id) AS sessions,
              MAX(created_at) AS last_used_at
       FROM mcp_events WHERE server = ?`,
    ).get(name);
    return {
      calls: row?.calls ?? 0,
      errors: row?.errors ?? 0,
      sessions: row?.sessions ?? 0,
      ...(row?.last_used_at != null ? { lastUsedAt: row.last_used_at } : {}),
    };
  }
}
