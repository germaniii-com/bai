/** Numbered, forward-only migrations. Never edit an applied migration. */
export const MIGRATIONS: string[] = [
  // 001 — initial schema (ARCHITECTURE.md §7)
  `
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    workbench TEXT NOT NULL,
    cwd TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    meta TEXT NOT NULL DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    role TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS parts (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL REFERENCES messages(id),
    ord INTEGER NOT NULL,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS inputs (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    payload TEXT NOT NULL,
    state TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS events (
    aggregate_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (aggregate_id, seq)
  );

  CREATE TABLE IF NOT EXISTS permissions (
    id TEXT PRIMARY KEY,
    session_id TEXT REFERENCES sessions(id),
    tool TEXT NOT NULL,
    args_digest TEXT NOT NULL,
    status TEXT NOT NULL,
    rule TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    session_id TEXT REFERENCES sessions(id),
    status TEXT NOT NULL,
    input TEXT NOT NULL,
    output TEXT,
    error TEXT,
    progress REAL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS assets (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    mime TEXT NOT NULL,
    path TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    meta TEXT NOT NULL DEFAULT '{}',
    job_id TEXT REFERENCES jobs(id),
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_parts_message ON parts(message_id, ord);
  CREATE INDEX IF NOT EXISTS idx_inputs_session_state ON inputs(session_id, state);
  CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
  CREATE INDEX IF NOT EXISTS idx_assets_job ON assets(job_id);
  `,
  // 002 — permission asks carry renderable detail (summary/diff, see AskDetail)
  `ALTER TABLE permissions ADD COLUMN detail TEXT;`,
  // 003 — per-request LLM usage analytics (D26). One row per provider call
  // (kind: run | title | compaction) with token counts and the EFFECTIVE
  // per-component rates (USD per 1M tokens) snapshotted at insert time —
  // dollars are computed at fetch time as Σ(tokens × rate) / 1e6, so
  // history stays correct regardless of later catalog price edits.
  `
  CREATE TABLE IF NOT EXISTS usage (
    id TEXT PRIMARY KEY,
    session_id TEXT REFERENCES sessions(id),
    kind TEXT NOT NULL,
    agent TEXT,
    workspace TEXT,
    provider TEXT NOT NULL,
    account TEXT,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens INTEGER,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_1h_tokens INTEGER NOT NULL DEFAULT 0,
    input_rate_usd_1m REAL NOT NULL DEFAULT 0,
    output_rate_usd_1m REAL NOT NULL DEFAULT 0,
    cache_read_rate_usd_1m REAL NOT NULL DEFAULT 0,
    cache_write_rate_usd_1m REAL NOT NULL DEFAULT 0,
    cache_write_1h_rate_usd_1m REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_usage_created ON usage(created_at);
  CREATE INDEX IF NOT EXISTS idx_usage_model ON usage(model, created_at);
  CREATE INDEX IF NOT EXISTS idx_usage_dims ON usage(kind, agent, provider, account);
  `,
  // 004 — usage rows also record FAILED LLM calls (D26): the provider error
  // message rides `error` (NULL for successful calls), so analytics can graph
  // error volume/rate per bucket and per model. Failed rows carry zero tokens.
  `ALTER TABLE usage ADD COLUMN error TEXT;`,
  // 005 — message-queue delivery (steer vs queue, opencode parity): the
  // queue flag leaves the payload JSON for a queryable column so the drain
  // can select steers and queued heads without parsing JSON. Existing rows
  // backfill from the payload flag.
  `
  ALTER TABLE inputs ADD COLUMN queued INTEGER NOT NULL DEFAULT 0;
  UPDATE inputs SET queued = 1 WHERE json_extract(payload, '$.queue') = 1;
  `,
];
