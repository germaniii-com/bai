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
];
