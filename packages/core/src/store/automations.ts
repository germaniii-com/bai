import type { Automation, AutomationId, AutomationRun, AutomationRunId, AutomationRunStatus, AutomationSchedule, AutomationStatus, SessionId } from "@bai/shared";
import { newId } from "@bai/shared";
import { q, type SqliteDb } from "./db";

/**
 * Automations storage. Two tables: `automations` (definition + scheduling
 * state) and `automation_runs` (one row per fire). Mirrors the media
 * `JobsRepo`: plain SQL, no bus integration — the scheduler broadcasts.
 */

interface AutomationRow {
  id: string;
  name: string;
  prompt: string;
  schedule: string;
  schedule_display: string;
  agent: string | null;
  model: string | null;
  workspace: string | null;
  enabled: number;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: string;
  last_error: string | null;
  last_session_id: string | null;
  created_at: string;
  updated_at: string;
}

function toAutomation(row: AutomationRow): Automation {
  return {
    id: row.id as AutomationId,
    name: row.name,
    prompt: row.prompt,
    schedule: JSON.parse(row.schedule) as AutomationSchedule,
    scheduleDisplay: row.schedule_display,
    ...(row.agent !== null ? { agent: row.agent } : {}),
    ...(row.model !== null ? { model: row.model } : {}),
    ...(row.workspace !== null ? { workspace: row.workspace } : {}),
    enabled: row.enabled === 1,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    lastStatus: row.last_status as AutomationStatus,
    ...(row.last_error !== null ? { lastError: row.last_error } : {}),
    ...(row.last_session_id !== null ? { lastSessionId: row.last_session_id as SessionId } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface AutomationInsert {
  name: string;
  prompt: string;
  schedule: AutomationSchedule;
  scheduleDisplay: string;
  agent?: string;
  model?: string;
  workspace?: string;
  enabled: boolean;
  nextRunAt: string | null;
  now: string;
}

export interface AutomationPatch {
  name?: string;
  prompt?: string;
  schedule?: AutomationSchedule;
  scheduleDisplay?: string;
  /** null clears the field; undefined keeps it. */
  agent?: string | null;
  model?: string | null;
  workspace?: string | null;
  enabled?: boolean;
  nextRunAt?: string | null;
  lastRunAt?: string | null;
  lastStatus?: AutomationStatus;
  lastError?: string | null;
  lastSessionId?: SessionId | null;
}

export class AutomationsRepo {
  constructor(private db: SqliteDb) {}

  insert(opts: AutomationInsert): Automation {
    const id = newId.automation();
    this.db
      .query(
        "INSERT INTO automations (id, name, prompt, schedule, schedule_display, agent, model, workspace, enabled, next_run_at, last_run_at, last_status, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'idle', ?, ?)",
      )
      .run(
        id,
        opts.name,
        opts.prompt,
        JSON.stringify(opts.schedule),
        opts.scheduleDisplay,
        opts.agent ?? null,
        opts.model ?? null,
        opts.workspace ?? null,
        opts.enabled ? 1 : 0,
        opts.nextRunAt,
        opts.now,
        opts.now,
      );
    return this.get(id) as Automation;
  }

  get(id: string): Automation | undefined {
    const row = q<AutomationRow>(this.db, "SELECT * FROM automations WHERE id = ?").get(id);
    return row ? toAutomation(row) : undefined;
  }

  getByName(name: string): Automation | undefined {
    const row = q<AutomationRow>(this.db, "SELECT * FROM automations WHERE name = ?").get(name);
    return row ? toAutomation(row) : undefined;
  }

  list(): Automation[] {
    return q<AutomationRow>(this.db, "SELECT * FROM automations ORDER BY created_at, id")
      .all()
      .map(toAutomation);
  }

  /** Enabled automations whose `next_run_at` has arrived. */
  due(nowIso: string): Automation[] {
    return q<AutomationRow>(
      this.db,
      "SELECT * FROM automations WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at, id",
    )
      .all(nowIso)
      .map(toAutomation);
  }

  update(id: string, patch: AutomationPatch, now: string): Automation | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    const schedule = patch.schedule ?? existing.schedule;
    const scheduleDisplay = patch.scheduleDisplay ?? existing.scheduleDisplay;
    const agent = patch.agent === undefined ? (existing.agent ?? null) : patch.agent;
    const model = patch.model === undefined ? (existing.model ?? null) : patch.model;
    const workspace = patch.workspace === undefined ? (existing.workspace ?? null) : patch.workspace;
    const nextRunAt = patch.nextRunAt === undefined ? existing.nextRunAt : patch.nextRunAt;
    const lastRunAt = patch.lastRunAt === undefined ? existing.lastRunAt : patch.lastRunAt;
    const lastStatus = patch.lastStatus ?? existing.lastStatus;
    const lastError = patch.lastError === undefined ? (existing.lastError ?? null) : patch.lastError;
    const lastSessionId =
      patch.lastSessionId === undefined ? (existing.lastSessionId ?? null) : patch.lastSessionId;
    this.db
      .query(
        "UPDATE automations SET name = ?, prompt = ?, schedule = ?, schedule_display = ?, agent = ?, model = ?, workspace = ?, " +
          "enabled = ?, next_run_at = ?, last_run_at = ?, last_status = ?, last_error = ?, last_session_id = ?, updated_at = ? WHERE id = ?",
      )
      .run(
        patch.name ?? existing.name,
        patch.prompt ?? existing.prompt,
        JSON.stringify(schedule),
        scheduleDisplay,
        agent,
        model,
        workspace,
        (patch.enabled ?? existing.enabled) ? 1 : 0,
        nextRunAt,
        lastRunAt,
        lastStatus,
        lastError,
        lastSessionId,
        now,
        id,
      );
    return this.get(id);
  }

  remove(id: string): boolean {
    this.db.query("DELETE FROM automation_runs WHERE automation_id = ?").run(id);
    const result = this.db.query("DELETE FROM automations WHERE id = ?").run(id);
    return result.changes > 0;
  }
}

interface AutomationRunRow {
  id: string;
  automation_id: string;
  session_id: string | null;
  status: string;
  error: string | null;
  output: string | null;
  started_at: string;
  finished_at: string | null;
}

function toRun(row: AutomationRunRow): AutomationRun {
  return {
    id: row.id as AutomationRunId,
    automationId: row.automation_id as AutomationId,
    ...(row.session_id !== null ? { sessionId: row.session_id as SessionId } : {}),
    status: row.status as AutomationRunStatus,
    ...(row.error !== null ? { error: row.error } : {}),
    ...(row.output !== null ? { output: row.output } : {}),
    startedAt: row.started_at,
    ...(row.finished_at !== null ? { finishedAt: row.finished_at } : {}),
  };
}

export class AutomationRunsRepo {
  constructor(private db: SqliteDb) {}

  insert(opts: { automationId: AutomationId; sessionId?: SessionId; now: string }): AutomationRun {
    const id = newId.automationRun();
    this.db
      .query(
        "INSERT INTO automation_runs (id, automation_id, session_id, status, started_at) VALUES (?, ?, ?, 'running', ?)",
      )
      .run(id, opts.automationId, opts.sessionId ?? null, opts.now);
    return this.get(id) as AutomationRun;
  }

  get(id: string): AutomationRun | undefined {
    const row = q<AutomationRunRow>(this.db, "SELECT * FROM automation_runs WHERE id = ?").get(id);
    return row ? toRun(row) : undefined;
  }

  /** Attach the session a run created (launch resolves slightly after insert). */
  setSession(id: string, sessionId: SessionId): AutomationRun | undefined {
    this.db.query("UPDATE automation_runs SET session_id = ? WHERE id = ?").run(sessionId, id);
    return this.get(id);
  }

  finish(
    id: string,
    patch: { status: AutomationRunStatus; error?: string; output?: string; now: string },
  ): AutomationRun | undefined {
    this.db
      .query("UPDATE automation_runs SET status = ?, error = ?, output = ?, finished_at = ? WHERE id = ?")
      .run(patch.status, patch.error ?? null, patch.output ?? null, patch.now, id);
    return this.get(id);
  }

  listByAutomation(automationId: string, limit = 50): AutomationRun[] {
    return q<AutomationRunRow>(
      this.db,
      "SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY started_at DESC, id DESC LIMIT ?",
    )
      .all(automationId, limit)
      .map(toRun);
  }

  /** Mark runs left `running` by a dead process as errors (boot recovery). */
  recoverRunning(now: string): AutomationRun[] {
    const running = q<AutomationRunRow>(
      this.db,
      "SELECT * FROM automation_runs WHERE status = 'running' ORDER BY started_at",
    ).all();
    if (running.length === 0) return [];
    this.db
      .query("UPDATE automation_runs SET status = 'error', error = ?, finished_at = ? WHERE status = 'running'")
      .run("interrupted by restart", now);
    return running.map((row) => toRun({ ...row, status: "error", error: "interrupted by restart", finished_at: now }));
  }
}
