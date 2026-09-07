import type { Input, InputId, PromptPayload, SessionId } from "@bai/shared";
import { newId } from "@bai/shared";
import { q, type SqliteDb } from "./db";

interface InputRow {
  id: string;
  session_id: string;
  payload: string;
  state: string;
  queued: number;
  created_at: string;
}

function toInput(row: InputRow): Input {
  return {
    id: row.id as InputId,
    sessionId: row.session_id as SessionId,
    payload: JSON.parse(row.payload) as PromptPayload,
    state: row.state as Input["state"],
    queued: row.queued === 1,
    createdAt: row.created_at,
  };
}

/**
 * Durable prompt admissions (opencode's session_input). Two delivery modes:
 * steers (queued = 0) promote at the next safe boundary; queued inputs
 * (queued = 1) wait until the session would otherwise go idle and promote
 * one at a time. The drain (run.ts) owns all promotion.
 */
export class InputsRepo {
  constructor(private db: SqliteDb) {}

  /** Durable admission — the prompt exists before any model call. */
  admit(sessionId: SessionId, payload: PromptPayload, now: string): Input {
    const id = newId.input();
    const queued = payload.queue === true;
    this.db
      .query(
        "INSERT INTO inputs (id, session_id, payload, state, queued, created_at) VALUES (?, ?, ?, 'admitted', ?, ?)",
      )
      .run(id, sessionId, JSON.stringify(payload), queued ? 1 : 0, now);
    return { id, sessionId, payload, state: "admitted", queued, createdAt: now };
  }

  /** Promote all admitted steer inputs (queued = 0) — atomic state flip. */
  promoteSteers(sessionId: SessionId): Input[] {
    const promote = this.db.transaction((): Input[] => {
      const rows = q<InputRow>(
        this.db,
        "SELECT * FROM inputs WHERE session_id = ? AND state = 'admitted' AND queued = 0 ORDER BY created_at, id",
      ).all(sessionId);
      if (rows.length === 0) return [];
      this.db
        .query(
          "UPDATE inputs SET state = 'promoted' WHERE session_id = ? AND state = 'admitted' AND queued = 0",
        )
        .run(sessionId);
      // Rows were read pre-update; reflect the promotion we just performed.
      return rows.map((row) => ({ ...toInput(row), state: "promoted" as const }));
    });
    return promote();
  }

  /**
   * Promote the oldest admitted queued input — ONE at a time (opencode's
   * promoteNextQueued): the drain calls this at the would-be-idle boundary
   * and re-evaluates after the promoted input's turns finish.
   */
  promoteNextQueued(sessionId: SessionId): Input | undefined {
    const promote = this.db.transaction((): Input | undefined => {
      const row = q<InputRow>(
        this.db,
        "SELECT * FROM inputs WHERE session_id = ? AND state = 'admitted' AND queued = 1 ORDER BY created_at, id LIMIT 1",
      ).get(sessionId);
      if (row === undefined || row === null) return undefined;
      this.db.query("UPDATE inputs SET state = 'promoted' WHERE id = ?").run(row.id);
      return { ...toInput(row), state: "promoted" as const };
    });
    return promote();
  }

  hasPendingSteers(sessionId: SessionId): boolean {
    const row = q<{ id: string }>(
      this.db,
      "SELECT id FROM inputs WHERE session_id = ? AND state = 'admitted' AND queued = 0 LIMIT 1",
    ).get(sessionId);
    return row !== undefined && row !== null;
  }

  hasPendingQueued(sessionId: SessionId): boolean {
    const row = q<{ id: string }>(
      this.db,
      "SELECT id FROM inputs WHERE session_id = ? AND state = 'admitted' AND queued = 1 LIMIT 1",
    ).get(sessionId);
    return row !== undefined && row !== null;
  }

  /** All admitted inputs (snapshot input — surfaces seed their queue from it). */
  pendingBySession(sessionId: SessionId): Input[] {
    return q<InputRow>(
      this.db,
      "SELECT * FROM inputs WHERE session_id = ? AND state = 'admitted' ORDER BY created_at, id",
    )
      .all(sessionId)
      .map(toInput);
  }

  /**
   * Send-now: flip a pending queued input to steer semantics. Undefined
   * when the input is unknown or no longer admitted (already promoted or
   * cancelled — the caller maps that to 409).
   */
  sendNow(sessionId: SessionId, inputId: InputId): Input | undefined {
    const flip = this.db.transaction((): Input | undefined => {
      const row = q<InputRow>(
        this.db,
        "SELECT * FROM inputs WHERE id = ? AND session_id = ? AND state = 'admitted'",
      ).get(inputId, sessionId);
      if (row === undefined || row === null) return undefined;
      this.db.query("UPDATE inputs SET queued = 0 WHERE id = ?").run(inputId);
      return { ...toInput(row), queued: false };
    });
    return flip();
  }

  /**
   * Cancel ONE pending input (queued or steering) — it never runs.
   * Undefined when unknown or no longer admitted.
   */
  cancelInput(sessionId: SessionId, inputId: InputId): Input | undefined {
    const cancel = this.db.transaction((): Input | undefined => {
      const row = q<InputRow>(
        this.db,
        "SELECT * FROM inputs WHERE id = ? AND session_id = ? AND state = 'admitted'",
      ).get(inputId, sessionId);
      if (row === undefined || row === null) return undefined;
      this.db.query("UPDATE inputs SET state = 'cancelled' WHERE id = ?").run(inputId);
      return { ...toInput(row), state: "cancelled" as const };
    });
    return cancel();
  }
}
