import type { Event, EventType, SessionId } from "@bai/shared";
import { isEventType } from "@bai/shared";
import { q, type SqliteDb } from "./db";

interface EventRow {
  aggregate_id: string;
  seq: number;
  type: string;
  payload: string;
  created_at: string;
}

function toEvent(row: EventRow): Event {
  const type = isEventType(row.type) ? row.type : "server.hello";
  const payload = JSON.parse(row.payload) as unknown;
  return {
    seq: row.seq,
    type,
    ts: row.created_at,
    ...(row.aggregate_id.startsWith("ses_") ? { sessionId: row.aggregate_id as SessionId } : {}),
    payload,
  } as unknown as Event;
}

/**
 * Durable per-aggregate event rows. The next sequence number is allocated
 * inside the same transaction as the state change it describes.
 */
export class EventsRepo {
  constructor(private db: SqliteDb) {}

  append(aggregateId: string, type: EventType, payload: unknown, now: string): Event {
    const insert = this.db.transaction((): number => {
      const row = q<{ m: number | null }>(this.db, "SELECT MAX(seq) AS m FROM events WHERE aggregate_id = ?")
        .get(aggregateId);
      const seq = (row?.m ?? 0) + 1;
      this.db
        .query("INSERT INTO events (aggregate_id, seq, type, payload, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(aggregateId, seq, type, JSON.stringify(payload ?? null), now);
      return seq;
    });
    const seq = insert();
    return {
      seq,
      type,
      ts: now,
      ...(aggregateId.startsWith("ses_") ? { sessionId: aggregateId as SessionId } : {}),
      payload,
    } as Event;
  }

  /** Rows with seq > after, ascending. The DB is the buffer — no gaps. */
  replay(aggregateId: string, after: number): Event[] {
    return q<EventRow>(this.db, 
        "SELECT * FROM events WHERE aggregate_id = ? AND seq > ? ORDER BY seq",
      )
      .all(aggregateId, after)
      .map(toEvent);
  }

  latestSeq(aggregateId: string): number {
    const row = q<{ m: number | null }>(this.db, "SELECT MAX(seq) AS m FROM events WHERE aggregate_id = ?")
      .get(aggregateId);
    return row?.m ?? 0;
  }
}
