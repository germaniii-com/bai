import type { Input, InputId, PromptPayload, SessionId } from "@bai/shared";
import { newId } from "@bai/shared";
import { q, type SqliteDb } from "./db";

interface InputRow {
  id: string;
  session_id: string;
  payload: string;
  state: string;
  created_at: string;
}

function toInput(row: InputRow): Input {
  return {
    id: row.id as InputId,
    sessionId: row.session_id as SessionId,
    payload: JSON.parse(row.payload) as PromptPayload,
    state: row.state as Input["state"],
    createdAt: row.created_at,
  };
}

export class InputsRepo {
  constructor(private db: SqliteDb) {}

  /** Durable admission — the prompt exists before any model call. */
  admit(sessionId: SessionId, payload: PromptPayload, now: string): Input {
    const id = newId.input();
    this.db
      .query("INSERT INTO inputs (id, session_id, payload, state, created_at) VALUES (?, ?, ?, 'admitted', ?)")
      .run(id, sessionId, JSON.stringify(payload), now);
    return { id, sessionId, payload, state: "admitted", createdAt: now };
  }

  /** Promote all admitted inputs (steer semantics) — atomic state flip. */
  promoteReady(sessionId: SessionId): Input[] {
    const promote = this.db.transaction((): Input[] => {
      const rows = q<InputRow>(this.db, "SELECT * FROM inputs WHERE session_id = ? AND state = 'admitted' ORDER BY created_at, id")
        .all(sessionId);
      if (rows.length === 0) return [];
      this.db
        .query("UPDATE inputs SET state = 'promoted' WHERE session_id = ? AND state = 'admitted'")
        .run(sessionId);
      // Rows were read pre-update; reflect the promotion we just performed.
      return rows.map((row) => ({ ...toInput(row), state: "promoted" as const }));
    });
    return promote();
  }

  cancelPending(sessionId: SessionId): number {
    const res = this.db
      .query("UPDATE inputs SET state = 'cancelled' WHERE session_id = ? AND state = 'admitted'")
      .run(sessionId);
    return res.changes;
  }

  listBySession(sessionId: SessionId): Input[] {
    return q<InputRow>(this.db, "SELECT * FROM inputs WHERE session_id = ? ORDER BY created_at, id")
      .all(sessionId)
      .map(toInput);
  }
}
