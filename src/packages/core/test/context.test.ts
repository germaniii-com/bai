import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeCore, waitForEvent, type TestCore } from "./harness";
import {
  applyDiscipline,
  estimateTokens,
  pruneOldToolResults,
  stubIdenticalResults,
  KEEP_RESULTS,
} from "../src/context/discipline";
import { buildSummaryInput, shouldCompact, SUMMARY_PREFIX, fileRefAppendix } from "../src/context/compact";
import type { Provider, ProviderStream, StreamEvent, LlmRequest } from "../src/provider/types";
import type { Message, MessageId, ModelInfo, Part, PartId, SessionId } from "@bai/shared";

function part(ord: number, kind: Part["kind"], payload: unknown): Part {
  return { id: `part_${ord}` as PartId, messageId: "msg_1" as MessageId, ord, kind, payload };
}
function msg(id: string, role: Message["role"], parts: Part[]): Message {
  return { id: id as MessageId, sessionId: "ses_1" as SessionId, role, createdAt: "t", parts };
}

describe("token discipline", () => {
  test("estimateTokens uses chars/4 across payload kinds", () => {
    const messages = [
      msg("m1", "user", [part(0, "text", { text: "x".repeat(400) })]),
      msg("m2", "assistant", [
        part(0, "tool_call", { callId: "c", name: "fs.read", args: '{"path":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}' }),
        part(1, "tool_result", { callId: "c", content: "y".repeat(400) }),
      ]),
    ];
    // 400/4 + (7+8+32)/4≈11 + 400/4 → ~211
    expect(estimateTokens(messages)).toBeGreaterThan(200);
    expect(estimateTokens(messages)).toBeLessThan(220);
  });

  test("stubIdenticalResults collapses older identical large results, keeps the newest", () => {
    const big = "z".repeat(600);
    const messages = [
      msg("m1", "assistant", [
        part(0, "tool_call", { callId: "c1", name: "fs.read", args: '{"path":"a.txt"}' }),
        part(1, "tool_result", { callId: "c1", content: big }),
      ]),
      msg("m2", "assistant", [
        part(0, "tool_call", { callId: "c2", name: "fs.read", args: '{"path":"a.txt"}' }),
        part(1, "tool_result", { callId: "c2", content: big }),
      ]),
    ];
    stubIdenticalResults(messages);
    const first = (messages[0]?.parts[1]?.payload as { content: string }).content;
    const second = (messages[1]?.parts[1]?.payload as { content: string }).content;
    expect(first).toContain("repeated identical result");
    expect(second).toBe(big); // newest survives verbatim
  });

  test("pruneOldToolResults keeps the newest window and error results verbatim", () => {
    const messages: Message[] = [];
    const total = KEEP_RESULTS + 3;
    for (let i = 0; i < total; i++) {
      messages.push(
        msg(`m${i}`, "assistant", [
          part(0, "tool_call", { callId: `c${i}`, name: "fs.read", args: `{"path":"f${i}.txt"}` }),
          part(1, "tool_result", i === 1 ? { callId: `c${i}`, content: "e".repeat(600), isError: true } : { callId: `c${i}`, content: "r".repeat(600) }),
        ]),
      );
    }
    pruneOldToolResults(messages);
    const rendered = messages.map((m) => (m.parts[1]?.payload as { content: string }).content);
    // The newest KEEP_RESULTS stay verbatim…
    for (let i = total - KEEP_RESULTS; i < total; i++) {
      expect(rendered[i]).toBe("r".repeat(600));
    }
    // …older large results are summarized…
    expect(rendered[0]).toContain("ran earlier");
    expect(rendered[0]).toContain("f0.txt");
    // …but the error result keeps its exact text even when old.
    expect(rendered[1]).toBe("e".repeat(600));
  });

  test("applyDiscipline is deterministic across repeated runs", () => {
    const messages = [
      msg("m1", "assistant", [
        part(0, "tool_call", { callId: "c1", name: "fs.read", args: '{"path":"a"}' }),
        part(1, "tool_result", { callId: "c1", content: "w".repeat(2000) }),
      ]),
    ];
    const first = JSON.stringify(applyDiscipline(messages));
    const second = JSON.stringify(applyDiscipline(messages));
    expect(first).toBe(second);
  });
});

describe("compaction helpers", () => {
  test("shouldCompact keys on the window with a floor", () => {
    expect(shouldCompact(96_000, 128_000)).toBe(true); // 96k ≥ 75% of 128k
    expect(shouldCompact(90_000, 128_000)).toBe(false); // 90k < 96k
    expect(shouldCompact(50_000, 128_000)).toBe(false);
    expect(shouldCompact(81_000, undefined)).toBe(true); // floor 80k
    expect(shouldCompact(10_000, undefined)).toBe(false);
    expect(shouldCompact(undefined, 200_000)).toBe(false);
  });

  test("buildSummaryInput flattens roles and caps tool results; appendix harvests files", () => {
    const messages = [
      msg("m1", "user", [part(0, "text", { text: "fix the bug in src/a.ts" })]),
      msg("m2", "assistant", [
        part(0, "tool_call", { callId: "c1", name: "fs.read", args: '{"path":"src/a.ts"}' }),
        part(1, "tool_result", { callId: "c1", content: "code ".repeat(1000) }),
      ]),
      msg("m3", "assistant", [
        part(0, "tool_call", { callId: "c2", name: "fs.edit", args: '{"path":"src/a.ts","oldString":"x","newString":"y"}' }),
        part(1, "tool_result", { callId: "c2", content: "Edited src/a.ts" }),
      ]),
    ];
    const input = buildSummaryInput(messages);
    expect(input).toContain("[User]: fix the bug in src/a.ts");
    expect(input).toContain("[Assistant tool calls]: fs.read(");
    expect(input).toContain("[Tool result]:");
    const appendix = fileRefAppendix(messages);
    expect(appendix).toContain("<read-files>");
    expect(appendix).toContain("src/a.ts");
    expect(appendix).toContain("<modified-files>");
  });
});

/** Summarizer fake: echoes a canned summary when called with the summary prompt. */
class FakeSummarizer implements Provider {
  requests: LlmRequest[] = [];
  name(): string {
    return "fake";
  }
  async models(): Promise<ModelInfo[]> {
    return [
      { id: "fake/main", provider: "fake", label: "Big" },
      { id: "fake/mini", provider: "fake", label: "Mini" },
    ];
  }
  async stream(req: LlmRequest): Promise<ProviderStream> {
    this.requests.push(req);
    const isSummaryCall = (req.messages[0] as { content?: string })?.content?.startsWith("You are a conversation summarizer") ?? false;
    const events: StreamEvent[] = isSummaryCall
      ? [
          { type: "text_delta", delta: "Goal: fix the bug.\nProgress: edited src/a.ts.\nNext Steps: verify." },
          { type: "done", stopReason: "end_turn" },
        ]
      : [{ type: "text_delta", delta: "ok" }, { type: "done", stopReason: "end_turn" }];
    async function* g() {
      for (const e of events) yield e;
    }
    const it = g();
    return { [Symbol.asyncIterator]: () => it, close: async () => {} };
  }
}

describe("compaction flow", () => {
  let t: TestCore;
  let dir: string;

  beforeEach(() => {
    t = makeCore();
    dir = mkdtempSync(join(tmpdir(), "bai-compact-"));
  });

  afterEach(() => {
    t.store.close();
    rmSync(t.dir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  test("usage over threshold triggers a summary pointer; history slices at it", async () => {
    const summarizer = new FakeSummarizer();
    t.providers.register(summarizer);
    t.config.models.default = "fake/main";

    const session = t.core.createSession({ workbench: "code", cwd: dir });
    writeFileSync(join(dir, "note.txt"), "seed");

    // Seed a big fake usage so the threshold trips on the first drain end.
    const existing = t.core.getSession(session.id);
    t.core.renameSession(session.id, existing?.title ?? "t"); // no-op rename for typing warmth
    const meta = { ...(existing?.meta ?? {}), lastUsage: { inputTokens: 90_000 } };
    (t as unknown as { store: { sessions: { update(id: string, o: unknown): unknown } } }).store.sessions.update(session.id, {
      meta,
      now: new Date().toISOString(),
    });

    const finished = waitForEvent(t.bus, "run.finished");
    t.core.submitPrompt(session.id, { text: "hello" });
    await finished;

    // Compaction wrote a summary message and the pointer.
    const after = t.core.getSession(session.id);
    const afterMeta = after?.meta as { compactionMessageId?: string; lastUsage?: unknown };
    expect(afterMeta.compactionMessageId).toBeDefined();
    expect(afterMeta.lastUsage).toBeUndefined(); // re-armed

    const summaryMessage = t.core.history(session.id).find((m) => m.id === afterMeta.compactionMessageId);
    expect(summaryMessage).toBeDefined();
    const text = (summaryMessage?.parts[0]?.payload as { text: string }).text;
    expect(text.startsWith(SUMMARY_PREFIX)).toBe(true);
    expect(text).toContain("Goal: fix the bug");
    // The summary call rode the small model path.
    const summaryReq = summarizer.requests.find((r) => (r.messages[0] as { content?: string })?.content?.startsWith("You are a conversation summarizer"));
    expect(summaryReq).toBeDefined();
  });

  test("below-threshold usage never compacts", async () => {
    const summarizer = new FakeSummarizer();
    t.providers.register(summarizer);
    t.config.models.default = "fake/main";
    const session = t.core.createSession({ workbench: "code", cwd: dir });
    const existing = t.core.getSession(session.id);
    const meta = { ...(existing?.meta ?? {}), lastUsage: { inputTokens: 1_000 } };
    (t as unknown as { store: { sessions: { update(id: string, o: unknown): unknown } } }).store.sessions.update(session.id, {
      meta,
      now: new Date().toISOString(),
    });
    const finished = waitForEvent(t.bus, "run.finished");
    t.core.submitPrompt(session.id, { text: "hello" });
    await finished;
    const afterMeta = t.core.getSession(session.id)?.meta as { compactionMessageId?: string };
    expect(afterMeta.compactionMessageId).toBeUndefined();
  });
});
