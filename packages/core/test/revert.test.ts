import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Event, MessageId, ModelInfo, SessionId } from "@bai/shared";
import { Snapshot, type LlmRequest, type Provider, type ProviderStream, type StreamEvent } from "../src";
import { makeCore, sleep, type TestCore } from "./harness";

/**
 * A provider that replays a per-turn script (run-drain.test.ts's pattern)
 * with an optional start gate for busy-state orchestration.
 */
class ScriptedProvider implements Provider {
  readonly requests: LlmRequest[] = [];
  constructor(
    private readonly script: Array<StreamEvent[] | ((req: LlmRequest) => StreamEvent[])>,
    private readonly gate?: Promise<void>,
  ) {}

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
      return this.streamOf([{ type: "text_delta", delta: "Title" }, { type: "done", stopReason: "end_turn" }]);
    }
    if (this.gate !== undefined) await this.gate;
    const index = this.requests.length;
    this.requests.push(req);
    const entry = this.script[index];
    const events = typeof entry === "function" ? entry(req) : (entry ?? [{ type: "done", stopReason: "end_turn" }]);
    return this.streamOf(events);
  }

  private streamOf(events: StreamEvent[]): ProviderStream {
    async function* generate(): AsyncGenerator<StreamEvent> {
      for (const evt of events) yield evt;
    }
    const iterator = generate();
    return { [Symbol.asyncIterator]: () => iterator, close: async () => {} };
  }
}

const finalText = (delta: string): StreamEvent[] => [{ type: "text_delta", delta }, { type: "done", stopReason: "end_turn" }];
const toolCall = (callId: string, name: string, args: string): StreamEvent[] => [
  { type: "tool_call_delta", id: callId, name, argsDelta: args },
  { type: "done", stopReason: "tool_calls" },
];

/** Subscribe first and accumulate every published event for later asserts. */
function collector(bus: TestCore["bus"]) {
  const seen: Event[] = [];
  const sub = bus.subscribe({
    onNotify: () => {
      for (const evt of sub.take()) seen.push(evt);
    },
  });
  return { seen, stop: () => bus.unsubscribe(sub.id) };
}

describe("revert / unrevert (service, message-only marker)", () => {
  let t: TestCore;

  beforeEach(() => {
    t = makeCore();
  });

  afterEach(() => {
    t.store.close();
    rmSync(t.dir, { recursive: true, force: true });
  });

  test("revert marks the boundary; unrevert clears it; no cwd → no snapshot fields", async () => {
    t.config.models.default = "scripted/main";
    t.providers.register(new ScriptedProvider([finalText("first reply"), finalText("second reply")]));
    const session = t.core.createSession({ workbench: "chat" });
    t.core.submitPrompt(session.id, { text: "one" });
    await t.core.drainNow(session.id);
    t.core.submitPrompt(session.id, { text: "two" });
    await t.core.drainNow(session.id);
    const messages = t.core.history(session.id);
    expect(messages).toHaveLength(4);
    const secondUser = messages[2];
    expect(secondUser?.role).toBe("user");

    const events = collector(t.bus);
    const reverted = await t.core.revertSession(session.id, secondUser!.id);
    events.stop();

    const revert = (reverted.meta as Record<string, unknown>).revert as { messageId: string; snapshot?: string };
    expect(revert.messageId).toBe(secondUser!.id);
    expect(revert.snapshot).toBeUndefined(); // no cwd → message-only revert
    expect(events.seen.some((e) => e.type === "session.updated")).toBe(true);
    // Nothing is deleted yet (two-phase): the transcript is intact.
    expect(t.core.history(session.id)).toHaveLength(4);

    const restored = await t.core.unrevertSession(session.id);
    expect((restored.meta as Record<string, unknown>).revert).toBeUndefined();
  });

  test("revert requires a known user message; unrevert without a revert is a no-op", async () => {
    t.config.models.default = "scripted/main";
    t.providers.register(new ScriptedProvider([finalText("reply")]));
    const session = t.core.createSession({ workbench: "chat" });
    t.core.submitPrompt(session.id, { text: "hello" });
    await t.core.drainNow(session.id);
    const [, assistant] = t.core.history(session.id);

    await expect(t.core.revertSession(session.id, "msg_nope" as MessageId)).rejects.toThrow("Unknown message");
    await expect(t.core.revertSession(session.id, assistant!.id)).rejects.toThrow("user message");
    await expect(t.core.revertSession("ses_nope" as SessionId, "msg_x" as MessageId)).rejects.toThrow("Unknown session");

    const unchanged = await t.core.unrevertSession(session.id);
    expect((unchanged.meta as Record<string, unknown>).revert).toBeUndefined();
  });

  test("revert/fork while the session is draining → Session is busy", async () => {
    t.config.models.default = "scripted/main";
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    t.providers.register(new ScriptedProvider([finalText("slow reply")], gate));
    const session = t.core.createSession({ workbench: "chat" });
    t.core.submitPrompt(session.id, { text: "hello" });
    await sleep(50); // the drain parks on the gate
    expect(t.core.coordinator.isActive(session.id)).toBe(true);

    const user = t.core.history(session.id).find((m) => m.role === "user");
    await expect(t.core.revertSession(session.id, user!.id)).rejects.toThrow("Session is busy");
    await expect(t.core.forkSession(session.id)).rejects.toThrow("Session is busy");

    release();
    await t.core.drainNow(session.id);
    // Idle again — revert succeeds.
    const reverted = await t.core.revertSession(session.id, user!.id);
    expect((reverted.meta as Record<string, unknown>).revert).toBeDefined();
  });
});

describe("forkSession (service)", () => {
  let t: TestCore;

  beforeEach(() => {
    t = makeCore();
    t.config.models.default = "scripted/main";
    t.providers.register(new ScriptedProvider([finalText("a"), finalText("b")]));
  });

  afterEach(() => {
    t.store.close();
    rmSync(t.dir, { recursive: true, force: true });
  });

  test("fork copies everything before the boundary with fresh ids; title counts up", async () => {
    const session = t.core.createSession({ title: "Original", workbench: "chat" });
    t.core.submitPrompt(session.id, { text: "one" });
    await t.core.drainNow(session.id);
    t.core.submitPrompt(session.id, { text: "two" });
    await t.core.drainNow(session.id);
    const messages = t.core.history(session.id);
    const secondUser = messages[2]!;

    const events = collector(t.bus);
    const forked = await t.core.forkSession(session.id, secondUser.id);
    events.stop();

    expect(forked.title).toBe("Original (fork #1)");
    expect((forked.meta as Record<string, unknown>).forkedFrom).toBe(session.id);
    expect((forked.meta as Record<string, unknown>).parent).toBeUndefined();

    const copied = t.core.history(forked.id);
    expect(copied).toHaveLength(2); // strictly before the boundary
    expect(copied[0]?.id).not.toBe(messages[0]!.id);
    expect((copied[0]?.parts[0]?.payload as { text: string }).text).toBe("one");
    expect((copied[1]?.parts[0]?.payload as { text: string }).text).toBe("a");
    // createdAt preserved so ordering/history renders identically.
    expect(copied[0]?.createdAt).toBe(messages[0]!.createdAt);

    // The new session's durable log can rebuild the transcript from events.
    const types = events.seen.filter((e) => e.sessionId === forked.id).map((e) => e.type);
    expect(types).toContain("session.created");
    expect(types.filter((x) => x === "message.created")).toHaveLength(2);

    // Forking a fork counts up (opencode's "(fork #N)" regex).
    const reforked = await t.core.forkSession(forked.id);
    expect(reforked.title).toBe("Original (fork #2)");
    expect(t.core.history(reforked.id)).toHaveLength(2);
  });

  test("fork remaps the compaction pointer; strips parent/revert", async () => {
    const session = t.core.createSession({ workbench: "chat" });
    t.core.submitPrompt(session.id, { text: "one" });
    await t.core.drainNow(session.id);
    t.core.submitPrompt(session.id, { text: "two" });
    await t.core.drainNow(session.id);
    const messages = t.core.history(session.id);
    // Point compaction at the FIRST user message (it will be copied) and
    // stamp a parent link + a pending revert into the copied range.
    t.store.sessions.update(session.id, {
      meta: {
        ...(session.meta as Record<string, unknown>),
        compactionMessageId: messages[0]!.id,
        parent: "ses_other" as SessionId,
      },
      now: "2026-01-01T00:00:09Z",
    });
    await t.core.revertSession(session.id, messages[2]!.id);

    const forked = await t.core.forkSession(session.id);
    const meta = forked.meta as Record<string, unknown>;
    expect(meta.parent).toBeUndefined();
    expect(meta.revert).toBeUndefined();
    // The pointer followed the remap: it names the copy of the summary.
    const copied = t.core.history(forked.id);
    expect(meta.compactionMessageId).toBe(copied[0]!.id);
  });
});

describe("Snapshot (shadow git repo)", () => {
  let dir: string;
  let snapshot: Snapshot;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bai-snap-"));
    snapshot = new Snapshot(join(dir, "shadow"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("non-git worktree is disabled; track/patch/revert/restore round-trip a git one", async () => {
    const plain = mkdtempSync(join(tmpdir(), "bai-plain-"));
    try {
      expect(await snapshot.enabled(plain)).toBe(false);
      expect(await snapshot.track(plain)).toBeUndefined();
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }

    const repo = join(dir, "repo");
    mkdirSync(repo);
    const git = async (...args: string[]): Promise<void> => {
      const proc = Bun.spawn({ cmd: ["git", "-C", repo, ...args], stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const code = await proc.exited;
      if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${await new Response(proc.stderr).text()}`);
    };
    await git("init");
    writeFileSync(join(repo, "a.txt"), "original\n");

    const before = await snapshot.track(repo);
    expect(before).toBeDefined();

    // The batch "changes" the worktree: modify a tracked file, add a new one.
    writeFileSync(join(repo, "a.txt"), "changed\n");
    writeFileSync(join(repo, "new.txt"), "brand new\n");
    const files = await snapshot.patch(repo, before!);
    expect(files).toContain("a.txt");
    expect(files).toContain("new.txt");

    // Roll the batch back: the modification is undone, the new file deleted.
    await snapshot.revert(repo, [{ hash: before!, files: files! }]);
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("original\n");
    expect(existsSync(join(repo, "new.txt"))).toBe(false);

    // Restore puts the worktree back to the tracked tree (unrevert target).
    writeFileSync(join(repo, "a.txt"), "changed again\n");
    await snapshot.restore(repo, before!);
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("original\n");

    // The diff between the snapshot and the current worktree names the change.
    writeFileSync(join(repo, "a.txt"), "changed\n");
    const diff = await snapshot.diff(repo, before!);
    expect(diff).toContain("a.txt");
    expect(diff).toContain("-original");
    expect(diff).toContain("+changed");
  });
});

describe("revert × drain (patch parts, file rollback, cleanup at next prompt)", () => {
  let t: TestCore;
  let repo: string;

  beforeEach(async () => {
    t = makeCore();
    t.config.models.default = "scripted/main";
    repo = mkdtempSync(join(tmpdir(), "bai-revert-run-"));
    // Snapshots only engage inside a git worktree — init the fixture repo.
    const proc = Bun.spawn({ cmd: ["git", "-C", repo, "init"], stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    await proc.exited;
  });

  afterEach(() => {
    t.store.close();
    rmSync(t.dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  test("mutating batch records a patch part; revert rolls the file back; next prompt commits the deletion", async () => {
    writeFileSync(join(repo, "a.txt"), "original\n");
    // fs.write refuses to overwrite an unread file — the batch reads first
    // (also making the revert's recorded diff meaningful).
    t.providers.register(
      new ScriptedProvider([
        toolCall("c0", "fs.read", JSON.stringify({ path: "a.txt" })),
        toolCall("c1", "fs.write", JSON.stringify({ path: "a.txt", content: "changed\n" })),
        finalText("done editing"),
      ]),
    );
    const session = t.core.createSession({ workbench: "chat", cwd: repo });

    t.core.submitPrompt(session.id, { text: "change it" });
    await t.core.drainNow(session.id);
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("changed\n");

    // The fs.write turn's assistant message carries a patch part (the revert
    // rollback input) — note each provider turn is its own assistant message,
    // so the patch rides the second one, not the fs.read turn's.
    const history = t.core.history(session.id);
    const patchMsg = history.find((m) => m.parts.some((p) => p.kind === "patch"));
    expect(patchMsg).toBeDefined();
    const patchPart = patchMsg?.parts.find((p) => p.kind === "patch");
    expect((patchPart?.payload as { files: string[] }).files).toContain("a.txt");

    // Revert to the user message: file rolled back, snapshot + diff recorded.
    const user = history.find((m) => m.role === "user");
    const reverted = await t.core.revertSession(session.id, user!.id);
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("original\n");
    const revert = (reverted.meta as Record<string, unknown>).revert as { messageId: string; snapshot?: string; diff?: string };
    expect(revert.snapshot).toBeDefined();
    expect(revert.diff).toContain("a.txt");

    // The next prompt commits the revert: the tail is hard-deleted, the
    // marker cleared, and message.removed events emitted.
    const events = collector(t.bus);
    t.core.submitPrompt(session.id, { text: "next" });
    await t.core.drainNow(session.id);
    await sleep(20);
    events.stop();

    const after = t.core.history(session.id);
    expect(after.some((m) => m.id === user!.id)).toBe(false);
    expect(after.some((m) => m.id === patchMsg!.id)).toBe(false);
    expect(after.filter((m) => m.role === "user")).toHaveLength(1); // only the new prompt
    expect((t.store.sessions.get(session.id)!.meta as Record<string, unknown>).revert).toBeUndefined();

    const removedEvents = events.seen
      .filter((e) => e.type === "message.removed")
      .map((e) => (e.payload as { messageId: string }).messageId);
    expect(removedEvents).toContain(user!.id);
    expect(removedEvents).toContain(patchMsg!.id);
  });

  test("unrevert restores both the file and the hidden messages", async () => {
    writeFileSync(join(repo, "b.txt"), "original\n");
    t.providers.register(
      new ScriptedProvider([
        toolCall("c0", "fs.read", JSON.stringify({ path: "b.txt" })),
        toolCall("c1", "fs.write", JSON.stringify({ path: "b.txt", content: "changed\n" })),
        finalText("done editing"),
      ]),
    );
    const session = t.core.createSession({ workbench: "chat", cwd: repo });
    t.core.submitPrompt(session.id, { text: "change it" });
    await t.core.drainNow(session.id);
    const messages = t.core.history(session.id);
    const assistant = messages.find((m) => m.role === "assistant")!;

    await t.core.revertSession(session.id, messages[0]!.id);
    expect(readFileSync(join(repo, "b.txt"), "utf8")).toBe("original\n");
    // Two-phase: the messages still exist (hidden client-side only).
    expect(t.core.history(session.id).some((m) => m.id === assistant.id)).toBe(true);

    await t.core.unrevertSession(session.id);
    expect(readFileSync(join(repo, "b.txt"), "utf8")).toBe("changed\n");
    const restored = t.core.history(session.id);
    expect(restored.some((m) => m.id === assistant.id)).toBe(true);
    expect((t.store.sessions.get(session.id)!.meta as Record<string, unknown>).revert).toBeUndefined();
  });
});
