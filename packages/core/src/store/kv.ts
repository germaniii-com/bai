import { q, type SqliteDb } from "./db";

export class KvRepo {
  constructor(private db: SqliteDb) {}

  get(key: string): unknown | undefined {
    const row = q<{ value: string }>(this.db, "SELECT value FROM kv WHERE key = ?").get(key);
    if (!row) return undefined;
    try {
      return JSON.parse(row.value) as unknown;
    } catch {
      return undefined;
    }
  }

  set(key: string, value: unknown): void {
    this.db
      .query("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, JSON.stringify(value ?? null));
  }

  delete(key: string): void {
    this.db.query("DELETE FROM kv WHERE key = ?").run(key);
  }
}
