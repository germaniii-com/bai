import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { ModelInfo } from "@bai/shared";
import { Store } from "../src";
import { MIGRATIONS } from "../src/store/migrations";
import type { LlmRequest, Provider, ProviderStream, StreamEvent } from "../src/provider/types";
import { makeCore, sleep, type TestCore } from "./harness";

describe("usage store", () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bai-usage-"));
    store = new Store(join(dir, "test.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("roundtrip: tokens, dimensions, and the rate snapshot survive the row", () => {
    const ses = store.sessions.insert({ workbench: "chat", now: "2026-01-01T00:00:00Z" });
    const record = store.usage.insert({
      sessionId: ses.id,
      kind: "run",
      agent: "build",
      workspace: "/tmp/ws",
      provider: "anthropic",
      account: "acct_1",
      model: "claude-sonnet-4-5",
      inputTokens: 100,
      outputTokens: 50,
      reasoningTokens: 20,
      cacheReadTokens: 900,
      cacheWriteTokens: 30,
      cacheWrite1hTokens: 10,
      rates: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6 },
      now: "2026-01-01T00:00:01Z",
    });
    expect(record.id.startsWith("usg_")).toBe(true);

    const fetched = store.usage.get(record.id);
    expect(fetched).toMatchObject({
      sessionId: ses.id,
      kind: "run",
      agent: "build",
      workspace: "/tmp/ws",
      provider: "anthropic",
      account: "acct_1",
      model: "claude-sonnet-4-5",
      inputTokens: 100,
      outputTokens: 50,
      reasoningTokens: 20,
      cacheReadTokens: 900,
      cacheWriteTokens: 30,
      cacheWrite1hTokens: 10,
      rates: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6 },
      createdAt: "2026-01-01T00:00:01Z",
    });
  });

  test("background rows (title/compaction) carry no agent; optional fields default", () => {
    const row = store.usage.insert({
      kind: "title",
      provider: "anthropic",
      model: "claude-haiku-4-5",
      inputTokens: 7,
      outputTokens: 3,
      now: "2026-01-01T00:00:01Z",
    });
    expect(row.agent).toBeUndefined();
    expect(row.workspace).toBeUndefined();
    expect(row.account).toBeUndefined();
    expect(row.sessionId).toBeUndefined();
    expect(row.reasoningTokens).toBeUndefined();
    // Zero rates when the caller omits them — tokens stay exact, spend 0.
    expect(row.rates).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 });
  });

  test("list is newest-first", () => {
    store.usage.insert({ kind: "run", provider: "a", model: "m", now: "2026-01-01T00:00:01Z" });
    store.usage.insert({ kind: "run", provider: "a", model: "m", now: "2026-01-01T00:00:02Z" });
    const rows = store.usage.list();
    expect(rows).toHaveLength(2);
    expect(rows[0]?.createdAt).toBe("2026-01-01T00:00:02Z");
  });

  test("migration 003 applies to an existing pre-003 database at boot", () => {
    // Simulate a database created by the previous build: run migrations
    // 001–002 only, then let Store's openDb migrate forward. (_migrations
    // itself is created by the migrate() runner, not by migration 001.)
    const file = join(dir, "legacy.db");
    const legacy = new Database(file, { create: true });
    legacy.run("PRAGMA journal_mode = WAL;");
    legacy.run("CREATE TABLE IF NOT EXISTS _migrations (idx INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);");
    for (const sql of MIGRATIONS.slice(0, 2)) legacy.exec(sql);
    legacy.run("INSERT INTO _migrations (idx, applied_at) VALUES (0, '2026-01-01T00:00:00Z'), (1, '2026-01-01T00:00:00Z')");
    legacy.close();

    const upgraded = new Store(file);
    try {
      // The usage table exists and accepts rows — the analytics schema is
      // live on the old database with no manual step.
      const row = upgraded.usage.insert({ kind: "run", provider: "p", model: "m", now: "2026-01-01T00:00:00Z" });
      expect(upgraded.usage.get(row.id)?.kind).toBe("run");
      // Pre-existing data is untouched.
      expect(upgraded.sessions.list(10, 0)).toHaveLength(0);
    } finally {
      upgraded.close();
    }
  });
});

/** Scripted provider that reports usage on every call (run + title). */
class UsageScriptedProvider implements Provider {
  name(): string {
    return "scripted";
  }

  async models(): Promise<ModelInfo[]> {
    return [{ id: "scripted/main", provider: "scripted", label: "Scripted", supportsTools: true }];
  }

  async stream(req: LlmRequest): Promise<ProviderStream> {
    const first = req.messages[0];
    const isTitleCall = first?.role === "system" && (first as { content: string }).content.startsWith("You are a title generator");
    if (isTitleCall) {
      return this.streamOf([
        { type: "text_delta", delta: "Title" },
        { type: "usage", inputTokens: 7, outputTokens: 3 },
        { type: "done", stopReason: "end_turn" },
      ]);
    }
    // The main run succeeds with full usage detail (the failing-provider
    // case is covered by FailingStreamProvider below).
    return this.streamOf([
      { type: "text_delta", delta: "hello" },
      {
        type: "usage",
        inputTokens: 42,
        outputTokens: 9,
        reasoningTokens: 4,
        cacheReadTokens: 100,
        cacheWriteTokens: 20,
      },
      { type: "done", stopReason: "end_turn" },
    ]);
  }

  private streamOf(events: StreamEvent[]): ProviderStream {
    async function* generate(): AsyncGenerator<StreamEvent> {
      for (const evt of events) yield evt;
    }
    return { [Symbol.asyncIterator]: () => generate(), close: async () => {} };
  }
}

/** Provider whose stream call rejects — the OpenAI-SDK 400 shape. */
class FailingStreamProvider implements Provider {
  name(): string {
    return "failing";
  }

  async models(): Promise<ModelInfo[]> {
    return [{ id: "failing/main", provider: "failing", label: "Failing", supportsTools: true }];
  }

  async stream(_req: LlmRequest): Promise<ProviderStream> {
    throw Object.assign(new Error("400 Provider returned error"), { status: 400 });
  }
}

describe("usage capture (D26 integration)", () => {
  let t: TestCore;

  beforeEach(() => {
    t = makeCore();
  });

  afterEach(() => {
    t.store.close();
    rmSync(t.dir, { recursive: true, force: true });
  });

  test("a run turn records one kind:'run' row with the full dimension set", async () => {
    t.config.models.default = "scripted/main";
    t.providers.register(new UsageScriptedProvider());
    const session = t.core.createSession({ workbench: "code", cwd: "/tmp/usage-ws" });

    t.core.submitPrompt(session.id, { text: "hi" });
    await t.core.drainNow(session.id);
    await sleep(20); // the rate lookup + insert are async fire-and-forget

    // The default-titled session also fires the detached title refine —
    // filter to the run row itself (the title row is asserted separately).
    const runRows = t.store.usage.list().filter((r) => r.kind === "run");
    expect(runRows).toHaveLength(1);
    expect(runRows[0]).toMatchObject({
      sessionId: session.id,
      workspace: "/tmp/usage-ws",
      provider: "scripted",
      model: "main",
      inputTokens: 42,
      outputTokens: 9,
      reasoningTokens: 4,
      cacheReadTokens: 100,
      cacheWriteTokens: 20,
    });
    expect(typeof runRows[0]?.agent).toBe("string");
  });

  test("the title generator's call records a kind:'title' row (unattributed)", async () => {
    t.config.models.default = "scripted/main";
    t.providers.register(new UsageScriptedProvider());
    // Fresh session → default title → the first prompt fires the detached
    // title refine (skipped only for the stub provider).
    const session = t.core.createSession({ workbench: "chat" });

    t.core.submitPrompt(session.id, { text: "hi" });
    await t.core.drainNow(session.id);
    await sleep(50); // title refine + rate lookups settle

    const kinds = t.store.usage.list().map((r) => r.kind).sort();
    expect(kinds).toContain("run");
    expect(kinds).toContain("title");
    const titleRow = t.store.usage.list().find((r) => r.kind === "title");
    expect(titleRow).toMatchObject({ provider: "scripted", model: "main", inputTokens: 7, outputTokens: 3 });
    expect(titleRow?.agent).toBeUndefined();
    expect(titleRow?.sessionId).toBe(session.id);
  });

  test("a failed provider call records a zero-token error row (D26)", async () => {
    t.config.models.default = "failing/main";
    t.providers.register(new FailingStreamProvider());
    const session = t.core.createSession({ workbench: "chat" });

    t.core.submitPrompt(session.id, { text: "hi" });
    await t.core.drainNow(session.id); // resolves — the error rides run.finished
    await sleep(20);

    const rows = t.store.usage.list().filter((r) => r.kind === "run");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: "failing",
      model: "main",
      error: "400 Provider returned error",
    });
    expect(rows[0]?.inputTokens).toBe(0);
    expect(rows[0]?.outputTokens).toBe(0);
    // The failure still surfaces on the session (unchanged behavior).
    const history = t.core.history(session.id);
    expect(history.find((m) => m.role === "assistant")).toBeUndefined();
  });
});
