import type { PermissionAction, PermissionRequest, PermissionRequestId, PermissionStatus, SessionId } from "@bai/shared";
import { newId } from "@bai/shared";
import { q, type SqliteDb } from "./db";

interface PermissionRow {
  id: string;
  session_id: string | null;
  tool: string;
  args_digest: string;
  status: string;
  rule: string | null;
  detail: string | null;
  created_at: string;
}

function toRequest(row: PermissionRow): PermissionRequest {
  let detail: PermissionRequest["detail"];
  if (row.detail !== null && row.detail.length > 0) {
    try {
      detail = JSON.parse(row.detail) as PermissionRequest["detail"];
    } catch {
      detail = undefined;
    }
  }
  return {
    id: row.id as PermissionRequestId,
    ...(row.session_id !== null ? { sessionId: row.session_id as SessionId } : {}),
    tool: row.tool,
    argsDigest: row.args_digest,
    status: row.status as PermissionStatus,
    ...(row.rule !== null ? { rule: row.rule } : {}),
    ...(detail !== undefined ? { detail } : {}),
    createdAt: row.created_at,
  };
}

export class PermissionsRepo {
  constructor(private db: SqliteDb) {}

  insert(opts: {
    sessionId?: SessionId;
    tool: string;
    argsDigest: string;
    rule?: string;
    /** Renderable ask context (AskDetail) persisted so snapshots replay it. */
    detail?: unknown;
    now: string;
  }): PermissionRequest {
    const id = newId.permissionRequest();
    this.db
      .query("INSERT INTO permissions (id, session_id, tool, args_digest, status, rule, detail, created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)")
      .run(id, opts.sessionId ?? null, opts.tool, opts.argsDigest, opts.rule ?? null, opts.detail !== undefined ? JSON.stringify(opts.detail) : null, opts.now);
    return this.get(id) as PermissionRequest;
  }

  get(id: string): PermissionRequest | undefined {
    const row = q<PermissionRow>(this.db, "SELECT * FROM permissions WHERE id = ?").get(id);
    return row ? toRequest(row) : undefined;
  }

  reply(id: string, status: PermissionStatus, rule?: string): PermissionRequest | undefined {
    this.db
      .query("UPDATE permissions SET status = ?, rule = COALESCE(?, rule) WHERE id = ? AND status = 'pending'")
      .run(status, rule ?? null, id);
    return this.get(id);
  }

  pendingBySession(sessionId: SessionId): PermissionRequest[] {
    return q<PermissionRow>(this.db, "SELECT * FROM permissions WHERE session_id = ? AND status = 'pending' ORDER BY created_at")
      .all(sessionId)
      .map(toRequest);
  }

  /**
   * Every pending ask across ALL sessions, oldest first — the surfaces'
   * global indicator seed (TUI sessions list, web badge). Session-less
   * asks (session_id NULL) are included; callers attribute them as they
   * see fit.
   */
  pendingAll(): PermissionRequest[] {
    return q<PermissionRow>(this.db, "SELECT * FROM permissions WHERE status = 'pending' ORDER BY created_at")
      .all()
      .map(toRequest);
  }
}

export type { PermissionAction };
