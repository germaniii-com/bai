import type { Message, MessageId, Part, PartId, PartKind, Role, SessionId } from "@bai/shared";
import { newId } from "@bai/shared";
import { q, type SqliteDb } from "./db";

interface MessageRow {
  id: string;
  session_id: string;
  role: string;
  created_at: string;
}

interface PartRow {
  id: string;
  message_id: string;
  ord: number;
  kind: string;
  payload: string;
}

function toPart(row: PartRow): Part {
  return {
    id: row.id as PartId,
    messageId: row.message_id as MessageId,
    ord: row.ord,
    kind: row.kind as PartKind,
    payload: JSON.parse(row.payload) as unknown,
  };
}

/** Cursor for paged history reads (opaque to clients — base64url JSON). */
export interface HistoryCursor {
  id: string;
  createdAt: string;
}

export function encodeHistoryCursor(cursor: HistoryCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeHistoryCursor(raw: string): HistoryCursor | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const { id, createdAt } = parsed as { id?: unknown; createdAt?: unknown };
    if (typeof id !== "string" || typeof createdAt !== "string") return undefined;
    return { id, createdAt };
  } catch {
    return undefined;
  }
}

export interface HistoryPage {
  messages: Message[];
  /** True when older messages exist before this page. */
  hasMore: boolean;
  /** Opaque cursor to fetch the next (older) page — absent when !hasMore. */
  nextCursor?: string;
}

export class MessagesRepo {
  constructor(private db: SqliteDb) {}

  append(sessionId: SessionId, role: Role, now: string): Message {
    const id = newId.message();
    this.db
      .query("INSERT INTO messages (id, session_id, role, created_at) VALUES (?, ?, ?, ?)")
      .run(id, sessionId, role, now);
    return { id, sessionId, role, createdAt: now, parts: [] };
  }

  /**
   * History for a session, oldest first, parts attached.
   * No opts → full history (provider/discipline/fork paths).
   * With `{limit}` → newest N messages (TUI window); with `{before}` →
   * the N messages strictly older than the cursor. Use `historyPage` when
   * the caller also needs `hasMore`/`nextCursor`.
   */
  history(sessionId: SessionId, opts: { limit?: number; before?: HistoryCursor } = {}): Message[] {
    return this.historyPage(sessionId, opts).messages;
  }

  /** Paged history read — newest-first scan, oldest-first return. */
  historyPage(
    sessionId: SessionId,
    opts: { limit?: number; before?: HistoryCursor } = {},
  ): HistoryPage {
    const { limit, before } = opts;
    if (limit === undefined) {
      const msgRows = q<MessageRow>(this.db,
          "SELECT * FROM messages WHERE session_id = ? ORDER BY created_at, id",
        )
        .all(sessionId);
      if (msgRows.length === 0) return { messages: [], hasMore: false };
      return { messages: this.attachParts(sessionId, msgRows), hasMore: false };
    }
    const safeLimit = Math.max(1, Math.min(Math.floor(limit), 500));
    const msgRows = (
      before === undefined
        ? q<MessageRow>(this.db,
            "SELECT * FROM messages WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT ?",
          ).all(sessionId, safeLimit + 1)
        : q<MessageRow>(this.db,
            `SELECT * FROM messages WHERE session_id = ?
             AND (created_at < ? OR (created_at = ? AND id < ?))
             ORDER BY created_at DESC, id DESC LIMIT ?`,
          ).all(sessionId, before.createdAt, before.createdAt, before.id, safeLimit + 1)
    );
    const hasMore = msgRows.length > safeLimit;
    const pageRows = hasMore ? msgRows.slice(0, safeLimit) : msgRows;
    if (pageRows.length === 0) return { messages: [], hasMore: false };
    // Oldest-first for surfaces.
    const ordered = [...pageRows].reverse();
    const messages = this.attachParts(sessionId, ordered);
    const oldest = pageRows[pageRows.length - 1];
    return {
      messages,
      hasMore,
      ...(hasMore && oldest !== undefined
        ? { nextCursor: encodeHistoryCursor({ id: oldest.id, createdAt: oldest.created_at }) }
        : {}),
    };
  }

  /** Attach parts for exactly the given message rows (one IN query). */
  private attachParts(sessionId: SessionId, msgRows: MessageRow[]): Message[] {
    if (msgRows.length === 0) return [];
    const ids = msgRows.map((r) => r.id);
    const placeholders = ids.map(() => "?").join(",");
    const partRows = q<PartRow>(this.db,
        `SELECT p.* FROM parts p WHERE p.message_id IN (${placeholders}) ORDER BY p.ord, p.id`,
      ).all(...ids);
    // Scope parts to this session's rows (message ids are globally unique,
    // so the IN set is already exact — sessionId kept for call clarity).
    void sessionId;
    const byMessage = new Map<string, Part[]>();
    for (const row of partRows) {
      const list = byMessage.get(row.message_id) ?? [];
      list.push(toPart(row));
      byMessage.set(row.message_id, list);
    }
    return msgRows.map((row) => ({
      id: row.id as MessageId,
      sessionId: row.session_id as SessionId,
      role: row.role as Role,
      createdAt: row.created_at,
      parts: byMessage.get(row.id) ?? [],
    }));
  }

  /**
   * Hard-delete the boundary message and everything after it (created_at, id
   * order), parts included — the revert-cleanup primitive. Returns the removed
   * message ids, oldest first; unknown boundary → nothing removed.
   */
  removeFrom(sessionId: SessionId, messageId: MessageId): MessageId[] {
    return this.db.transaction(() => {
      const rows = q<{ id: string }>(
        this.db,
        "SELECT id FROM messages WHERE session_id = ? ORDER BY created_at, id",
      ).all(sessionId);
      const idx = rows.findIndex((r) => r.id === messageId);
      if (idx < 0) return [];
      const doomed = rows.slice(idx).map((r) => r.id);
      for (const id of doomed) {
        // Parts first — no ON DELETE CASCADE on the schema.
        this.db.query("DELETE FROM parts WHERE message_id = ?").run(id);
        this.db.query("DELETE FROM messages WHERE id = ? AND session_id = ?").run(id, sessionId);
      }
      return doomed as MessageId[];
    })();
  }

  /**
   * Copy messages strictly before `uptoMessageId` (ALL messages when omitted
   * or not found — opencode's fork semantics) from one session into another
   * with FRESH ids — the fork primitive. Ordering (created_at), roles and
   * parts (ord/kind/payload) are preserved verbatim; returns old → new
   * message id.
   */
  copyRange(
    fromSessionId: SessionId,
    toSessionId: SessionId,
    uptoMessageId?: MessageId,
  ): Map<MessageId, MessageId> {
    return this.db.transaction(() => {
      const source = this.history(fromSessionId);
      const idx = uptoMessageId === undefined ? -1 : source.findIndex((m) => m.id === uptoMessageId);
      const slice = idx < 0 ? source : source.slice(0, idx);
      const idMap = new Map<MessageId, MessageId>();
      for (const msg of slice) {
        const id = newId.message();
        idMap.set(msg.id, id);
        this.db
          .query("INSERT INTO messages (id, session_id, role, created_at) VALUES (?, ?, ?, ?)")
          .run(id, toSessionId, msg.role, msg.createdAt);
        for (const part of msg.parts) {
          this.db
            .query("INSERT INTO parts (id, message_id, ord, kind, payload) VALUES (?, ?, ?, ?, ?)")
            .run(newId.part(), id, part.ord, part.kind, JSON.stringify(part.payload ?? null));
        }
      }
      return idMap;
    })();
  }
}

export class PartsRepo {
  constructor(private db: SqliteDb) {}

  append(messageId: MessageId, ord: number, kind: PartKind, payload: unknown): Part {
    const id = newId.part();
    this.db
      .query("INSERT INTO parts (id, message_id, ord, kind, payload) VALUES (?, ?, ?, ?, ?)")
      .run(id, messageId, ord, kind, JSON.stringify(payload ?? null));
    return { id, messageId, ord, kind, payload: payload ?? null };
  }

  updatePayload(partId: PartId, payload: unknown): void {
    this.db
      .query("UPDATE parts SET payload = ? WHERE id = ?")
      .run(JSON.stringify(payload ?? null), partId);
  }

  get(partId: string): Part | undefined {
    const row = q<PartRow>(this.db, "SELECT * FROM parts WHERE id = ?").get(partId);
    return row ? toPart(row) : undefined;
  }

  /** Next free `ord` for a message (MAX(ord)+1; 0 when empty). */
  nextOrd(messageId: MessageId): number {
    const row = q<{ max: number | null }>(this.db, "SELECT MAX(ord) AS max FROM parts WHERE message_id = ?").get(messageId);
    return (row?.max ?? -1) + 1;
  }
}
