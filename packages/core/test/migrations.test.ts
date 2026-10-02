import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { MessageId, SessionId } from "@bai/shared";
import { Store } from "../src";
import { MIGRATIONS } from "../src/store/migrations";

/** Branded ids for the hand-seeded legacy rows. */
const LEGACY_SESSION = "ses_legacy" as SessionId;
const LEGACY_MESSAGE = "msg_legacy" as MessageId;

/**
 * Forward-only migration checks. Migrations are a numbered array applied by
 * index, so "an existing install" is simulated by applying every migration up
 * to (but excluding) the one under test, recording those indices exactly as
 * `migrate()` does, and reopening the file with a fresh Store — which applies
 * whatever is still pending.
 */
describe("migrations", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bai-migrations-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Build a legacy DB with only migrations `0..upToExclusive` applied. */
  function seedLegacyDb(file: string, upToExclusive: number): void {
    const db = new Database(file, { create: true });
    db.run("PRAGMA journal_mode = WAL;");
    db.run("CREATE TABLE IF NOT EXISTS _migrations (idx INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);");
    for (const [idx, sql] of MIGRATIONS.entries()) {
      if (idx >= upToExclusive) break;
      db.exec(sql);
      db.query("INSERT INTO _migrations (idx, applied_at) VALUES (?, ?)").run(idx, new Date().toISOString());
    }
    db.close();
  }

  test("message attribution columns are added to an existing install, data intact", () => {
    const file = join(dir, "legacy.db");
    // Migrations 001..011 — the schema as it shipped before attribution.
    seedLegacyDb(file, 12);

    // A session + an assistant message written by the OLD schema (no
    // attribution columns existed, so none could be written).
    const legacy = new Database(file);
    legacy.run(
      "INSERT INTO sessions (id, title, workbench, created_at, updated_at, meta) VALUES ('ses_legacy', 'Old chat', 'chat', 't0', 't0', '{}')",
    );
    legacy.run("INSERT INTO messages (id, session_id, role, created_at) VALUES ('msg_legacy', 'ses_legacy', 'assistant', 't1')");
    legacy.close();

    // Reopening runs the remaining migrations (012 and anything later).
    const store = new Store(file);
    try {
      const history = store.messages.history(LEGACY_SESSION);
      expect(history).toHaveLength(1);
      // The pre-migration row survives and simply carries no attribution —
      // surfaces hide the byline rather than guess at history.
      expect(history[0]?.id).toBe(LEGACY_MESSAGE);
      expect(history[0]?.agent).toBeUndefined();
      expect(history[0]?.provider).toBeUndefined();
      expect(history[0]?.model).toBeUndefined();

      // And the upgraded schema accepts attributed writes immediately.
      const fresh = store.messages.append(LEGACY_SESSION, "assistant", "t2", {
        agent: "chat",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
      });
      expect(fresh.agent).toBe("chat");
      const after = store.messages.history(LEGACY_SESSION);
      expect(after[1]?.model).toBe("claude-sonnet-4-5");
    } finally {
      store.close();
    }
  });

  test("reopening an already-migrated database is a no-op", () => {
    const file = join(dir, "current.db");
    // Apply ALL migrations, then reopen twice — migration bookkeeping must not
    // re-run (a re-run ALTER TABLE would fail on the duplicate column).
    const first = new Store(file);
    first.close();
    expect(() => new Store(file).close()).not.toThrow();
  });
});