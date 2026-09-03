import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeCore, type TestCore } from "./harness";
import type { ModelInfo } from "@bai/shared";
import type { LlmRequest, Provider, ProviderStream, StreamEvent } from "../src/provider/types";
import { buildEnvBlock } from "../src/run/env";

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

const finalText = (delta: string): StreamEvent[] => [{ type: "text_delta", delta }, { type: "done", stopReason: "end_turn" }];

describe("env block (session metadata in the system prompt)", () => {
  test("buildEnvBlock renders cwd, workbench, agent, tools, platform, date", () => {
    const block = buildEnvBlock({
      cwd: "/tmp/proj",
      workbench: "code",
      title: "Fix the bug",
      agent: "build",
      tools: ["bash", "fs.read", "fs.write"],
      now: "2026-09-03T12:00:00.000Z",
    });
    expect(block).toContain("<env>");
    expect(block).toContain("Working directory: /tmp/proj (fs tool paths resolve relative to it; bash runs there)");
    expect(block).toContain('Workbench: code — "Fix the bug"');
    expect(block).toContain("Agent: build");
    expect(block).toContain("Available tools: bash, fs.read, fs.write");
    expect(block).toContain(`Platform: ${process.platform}`);
    expect(block).toContain("Date: 2026-09-03 (");
    expect(block).toContain("</env>");
  });

  test("plain chat sessions omit the working directory and tools lines when unset", () => {
    const block = buildEnvBlock({ workbench: "chat", title: "", agent: "chat", now: "2026-09-03T12:00:00.000Z" });
    expect(block).not.toContain("Working directory:");
    expect(block).not.toContain("Available tools:");
    expect(block).toContain("Workbench: chat");
    expect(block).toContain("Agent: chat");
  });

  test("fs-tool agents get absolute-path guidance; others don't", () => {
    const now = "2026-09-03T12:00:00.000Z";
    // With a cwd: prefer absolute paths under it.
    const withCwd = buildEnvBlock({
      cwd: "/tmp/proj",
      workbench: "code",
      title: "",
      agent: "build",
      tools: ["fs.read", "fs.write", "bash"],
      now,
    });
    expect(withCwd).toContain("fs tools: prefer absolute paths under the working directory");
    // Without a cwd but with registered workspaces: absolute-only, listed.
    const noCwd = buildEnvBlock({
      workbench: "chat",
      title: "",
      agent: "build",
      tools: ["fs.read", "fs.list"],
      workspaces: ["/tmp/ws-a", "/tmp/ws-b"],
      now,
    });
    expect(noCwd).toContain(
      "No session working directory — fs tools accept ONLY absolute paths inside these registered workspaces: /tmp/ws-a, /tmp/ws-b",
    );
    expect(noCwd).toContain("bash runs in the server process working directory:");
    // Without workspaces either: bash is the fallback.
    const bare = buildEnvBlock({ workbench: "chat", title: "", agent: "build", tools: ["fs.read"], workspaces: [], now });
    expect(bare).toContain("fs tool paths cannot be resolved; use bash for filesystem access");
    // A no-fs agent gets none of the guidance.
    const noFs = buildEnvBlock({ workbench: "chat", title: "", agent: "chat", tools: ["web.search"], now });
    expect(noFs).not.toContain("fs tools:");
    expect(noFs).not.toContain("fs tool paths cannot be resolved");
  });

  test("the drain rides the env block in the system message (cwd + tools for the agent)", async () => {
    let t: TestCore | undefined;
    const dir = mkdtempSync(join(tmpdir(), "bai-env-"));
    try {
      t = makeCore();
      t.config.models.default = "scripted/main";
      const provider = new ScriptedToolProvider([finalText("hello")]);
      t.providers.register(provider);
      const session = t.core.createSession({ workbench: "code", cwd: dir });
      await t.core.setSessionAgent(session.id, { agent: "build" });

      const finished = waitForRunFinished(t);
      t.core.submitPrompt(session.id, { text: "hi" });
      await finished;

      const system = (provider.requests[0] as LlmRequest).messages.find((m) => m.role === "system");
      expect(system).toBeDefined();
      const content = (system?.content as string) ?? "";
      expect(content).toContain(`Working directory: ${dir}`);
      expect(content).toContain("Agent: build");
      expect(content).toContain("Available tools:");
      // The persona still leads the system message.
      expect(content.indexOf("bai's build agent")).toBeLessThan(content.indexOf("<env>"));
      t.store.close();
      t = undefined;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function waitForRunFinished(t: TestCore): Promise<void> {
    return new Promise((resolve, reject) => {
      const sub = t.bus.subscribe();
      const deadline = Date.now() + 3000;
      const tick = (): void => {
        for (const evt of sub.take()) {
          if (evt.type === "run.finished") {
            t.bus.unsubscribe(sub.id);
            resolve();
            return;
          }
        }
        if (Date.now() > deadline) {
          t.bus.unsubscribe(sub.id);
          reject(new Error("timeout waiting for run.finished"));
          return;
        }
        setTimeout(tick, 5);
      };
      tick();
    });
  }
});
