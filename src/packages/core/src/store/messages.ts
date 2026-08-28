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

export class MessagesRepo {
  constructor(private db: SqliteDb) {}

  append(sessionId: SessionId, role: Role, now: string): Message {
    const id = newId.message();
    this.db
      .query("INSERT INTO messages (id, session_id, role, created_at) VALUES (?, ?, ?, ?)")
      .run(id, sessionId, role, now);
    return { id, sessionId, role, createdAt: now, parts: [] };
  }

  /** Full history for a session, oldest first, parts attached. */
  history(sessionId: SessionId): Message[] {
    const msgRows = q<MessageRow>(this.db, 
        "SELECT * FROM messages WHERE session_id = ? ORDER BY created_at, id",
      )
      .all(sessionId);
    if (msgRows.length === 0) return [];
    const partRows = q<PartRow>(this.db, 
        `SELECT p.* FROM parts p JOIN messages m ON m.id = p.message_id
         WHERE m.session_id = ? ORDER BY p.ord, p.id`,
      )
      .all(sessionId);
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
}
