import { mkdirSync } from "node:fs";
import path from "node:path";
import { Database, type SQLQueryBindings, type Statement } from "bun:sqlite";
import { MIGRATIONS } from "./migrations";

export type SqliteDb = Database;

/** Typed query helper — bun-types 1.4 requires both generics on db.query. */
export function q<T>(db: SqliteDb, sql: string): Statement<T, SQLQueryBindings[]> {
  return db.query<T, SQLQueryBindings[]>(sql);
}

/**
 * Open (creating if needed) the bai database with the single-writer
 * discipline: WAL mode, busy_timeout, foreign keys on.
 */
export function openDb(file: string): SqliteDb {
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file, { create: true });
  db.run("PRAGMA journal_mode = WAL;");
  db.run("PRAGMA busy_timeout = 5000;");
  db.run("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

/** macOS system libsqlite3 keeps WAL sidecars after close; clean them up. */
export function checkpointAndClose(db: SqliteDb): void {
  try {
    db.run("PRAGMA wal_checkpoint(TRUNCATE);");
  } catch {
    // best effort
  }
  db.close();
}

export function migrate(db: SqliteDb): void {
  db.run(
    "CREATE TABLE IF NOT EXISTS _migrations (idx INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);",
  );
  const appliedRows = q<{ idx: number }>(db, "SELECT idx FROM _migrations ORDER BY idx")
    .all();
  const applied = new Set(appliedRows.map((r) => r.idx));
  for (const [idx, sql] of MIGRATIONS.entries()) {
    if (applied.has(idx)) continue;
    const run = db.transaction(() => {
      db.exec(sql);
      db.query("INSERT INTO _migrations (idx, applied_at) VALUES (?, ?)").run(
        idx,
        new Date().toISOString(),
      );
    });
    run();
  }
}
