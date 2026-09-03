import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeCore, waitForEvent, type TestCore } from "./harness";
import { fsPathInsideCwd } from "../src/permissions/ask";
import type { ModelInfo } from "@bai/shared";
import type { LlmRequest, Provider, ProviderStream, StreamEvent } from "../src/provider/types";

class ScriptedToolProvider implements Provider {
  readonly requests: LlmRequest[] = [];

  constructor(private readonly script: Array<StreamEvent[] | ((req: LlmRequest) => StreamEvent[])>) {}

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
    const index = this.requests.length;
    this.requests.push(req);
    const entry = this.script[index];
    const events = typeof entry === "function" ? entry(req) : (entry ?? [{ type: "done", stopReason: "end_turn" } as StreamEvent]);
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

const toolCall = (callId: string, name: string, args: string): StreamEvent[] => [
  { type: "tool_call_delta", id: callId, name, argsDelta: args },
  { type: "done", stopReason: "tool_use" },
];

const finalText = (delta: string): StreamEvent[] => [{ type: "text_delta", delta }, { type: "done", stopReason: "end_turn" }];

describe("fsPathInsideCwd", () => {
  const cwd = "/tmp/proj";

  test("relative paths resolve against the cwd", () => {
    expect(fsPathInsideCwd("fs.write", { path: "src/x.ts" }, cwd)).toBe(true);
    expect(fsPathInsideCwd("fs.write", { path: "sub/../x.txt" }, cwd)).toBe(true);
  });

  test("absolute paths inside count; siblings and escapes do not", () => {
    expect(fsPathInsideCwd("fs.edit", { path: "/tmp/proj/a.txt" }, cwd)).toBe(true);
    expect(fsPathInsideCwd("fs.write", { path: "/tmp/proj-other/a.txt" }, cwd)).toBe(false);
    expect(fsPathInsideCwd("fs.write", { path: "../escape.txt" }, cwd)).toBe(false);
    expect(fsPathInsideCwd("fs.write", { path: "/etc/passwd" }, cwd)).toBe(false);
  });

  test("only fs tools qualify; list/glob without a path operate on the cwd", () => {
    expect(fsPathInsideCwd("bash", { command: "ls" }, cwd)).toBe(false);
    expect(fsPathInsideCwd("fs.write", { content: "no path" }, cwd)).toBe(false);
    expect(fsPathInsideCwd("fs.glob", { pattern: "**/*.ts" }, cwd)).toBe(true);
    expect(fsPathInsideCwd("fs.list", {}, cwd)).toBe(true);
  });
});

describe("cwd-relative permission defaults", () => {
  let t: TestCore;
  let dir: string;

  beforeEach(() => {
    t = makeCore();
    dir = mkdtempSync(join(tmpdir(), "bai-cwd-"));
    writeFileSync(join(dir, "existing.txt"), "original\n");
  });

  afterEach(() => {
    t.store.close();
    rmSync(t.dir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  test("fs.write inside the session cwd is allowed without an ask", async () => {
    const session = t.core.createSession({ workbench: "code", cwd: dir });
    const result = await t.core.permissions.authorize({
      tool: "fs.write",
      sessionId: session.id,
      metadata: { path: "out.txt", content: "x" },
      cwd: dir,
    });
    expect(result.allowed).toBe(true);
    expect(t.store.permissions.pendingBySession(session.id)).toHaveLength(0);
  });

  test("fs.write outside the cwd still asks", async () => {
    const session = t.core.createSession({ workbench: "code", cwd: dir });
    const outside = mkdtempSync(join(tmpdir(), "bai-outside-"));
    try {
      const askArrived = waitForEvent(t.bus, "permission.asked", { timeoutMs: 3000 });
      const ctrl = new AbortController();
      const pending = t.core.permissions.authorize({
        tool: "fs.write",
        sessionId: session.id,
        metadata: { path: join(outside, "out.txt"), content: "x" },
        cwd: dir,
        signal: ctrl.signal,
      });
      await askArrived; // the ask fired — outside is fail-closed
      ctrl.abort();
      expect((await pending).cancelled).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("explicit config still wins inside the cwd (ask and deny)", async () => {
    const session = t.core.createSession({ workbench: "code", cwd: dir });

    t.config.permissions = { "fs.write": "deny" };
    const denied = await t.core.permissions.authorize({
      tool: "fs.write",
      sessionId: session.id,
      metadata: { path: "out.txt", content: "x" },
      cwd: dir,
    });
    expect(denied.allowed).toBe(false);

    t.config.permissions = { "fs.write": "ask" };
    const askArrived = waitForEvent(t.bus, "permission.asked", { timeoutMs: 3000 });
    const ctrl = new AbortController();
    const pending = t.core.permissions.authorize({
      tool: "fs.write",
      sessionId: session.id,
      metadata: { path: "out.txt", content: "x" },
      cwd: dir,
      signal: ctrl.signal,
    });
    await askArrived; // explicit "ask" beats the cwd default
    ctrl.abort();
    expect((await pending).cancelled).toBe(true);
  });

  test("bash never gains the cwd default (it can escape the directory)", async () => {
    const session = t.core.createSession({ workbench: "code", cwd: dir });
    const askArrived = waitForEvent(t.bus, "permission.asked", { timeoutMs: 3000 });
    const ctrl = new AbortController();
    const pending = t.core.permissions.authorize({
      tool: "bash",
      sessionId: session.id,
      metadata: { command: "ls" },
      cwd: dir,
      signal: ctrl.signal,
    });
    await askArrived;
    ctrl.abort();
    expect((await pending).cancelled).toBe(true);
  });

  test("end-to-end: a build run writes inside its cwd with no permission round-trip", async () => {
    t.config.models.default = "scripted/main";
    const provider = new ScriptedToolProvider([
      toolCall("w1", "fs.write", JSON.stringify({ path: "out.txt", content: "written silently" })),
      finalText("done"),
    ]);
    t.providers.register(provider);
    const session = t.core.createSession({ workbench: "code", cwd: dir });
    await t.core.setSessionAgent(session.id, { agent: "build" });

    const events: string[] = [];
    const sub = t.bus.subscribe({ onNotify: () => { for (const e of sub.take()) events.push(e.type); } });
    const finished = waitForEvent(t.bus, "run.finished", { timeoutMs: 3000 });
    t.core.submitPrompt(session.id, { text: "write the file" });
    await finished;
    await new Promise((r) => setTimeout(r, 20));
    t.bus.unsubscribe(sub.id);

    expect(readFileSync(join(dir, "out.txt"), "utf8")).toBe("written silently");
    expect(events).not.toContain("permission.asked");
    expect(t.store.permissions.pendingBySession(session.id)).toHaveLength(0);
  });
});
