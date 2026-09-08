import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeCore, waitForEvent, type TestCore } from "./harness";
import type { ModelInfo } from "@bai/shared";
import type { LlmRequest, Provider, ProviderStream, StreamEvent } from "../src/provider/types";
import { buildSkillsBlock } from "../src/run/skills";

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

describe("skills index block (system prompt)", () => {
  test("buildSkillsBlock renders the scan-first instruction and one line per skill", () => {
    const block = buildSkillsBlock([
      { name: "arxiv", description: "Search arXiv papers by keyword, author, category, or ID.", body: "b", source: "file", path: "/x", linkedFiles: [] },
      { name: "deploy", description: "Ship releases.", body: "b", source: "file", path: "/y", linkedFiles: [] },
    ]);
    expect(block.startsWith("## Skills")).toBe(true);
    expect(block).toContain("call skills.view with its name");
    expect(block).toContain("- arxiv: Search arXiv papers by keyword, author, category, or ID.");
    expect(block).toContain("- deploy: Ship releases.");
  });

  test("descriptions are collapsed and truncated to 60 chars", () => {
    const block = buildSkillsBlock([
      {
        name: "long",
        description: "A  very   long description that rambles on and on well past the sixty character index limit for sure.",
        body: "b",
        source: "file",
        path: "/x",
        linkedFiles: [],
      },
    ]);
    const line = block.split("\n").find((l) => l.startsWith("- long:")) ?? "";
    const desc = line.slice("- long:".length + 1);
    expect(desc.length).toBeLessThanOrEqual(60);
    expect(desc.endsWith("…")).toBe(true);
    expect(desc).not.toContain("  ");
  });

  test("empty skill list renders no block", () => {
    expect(buildSkillsBlock([])).toBe("");
  });
});

describe("skills index in the drain (system prompt + tool + analytics)", () => {
  let t: TestCore | undefined;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bai-run-skills-"));
  });

  afterEach(() => {
    t?.store.close();
    t = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  test("an agent with skills.view gets the index; an agent without doesn't", async () => {
    t = makeCore();
    t.config.models.default = "scripted/main";
    t.skills.put("arxiv", { description: "Search arXiv papers.", body: "# arXiv" });
    const provider = new ScriptedToolProvider([finalText("hello"), finalText("hello again")]);
    t.providers.register(provider);

    // The chat orchestrator (tools: ["*"]) — index present.
    const chat = t.core.createSession({ workbench: "chat" });
    await t.core.setSessionAgent(chat.id, { agent: "chat" });
    t.core.submitPrompt(chat.id, { text: "hi" });
    await waitForEvent(t.bus, "run.finished");

    // The build agent (explicit allow-list, no skills.view) — index absent.
    const build = t.core.createSession({ workbench: "code", cwd: dir });
    await t.core.setSessionAgent(build.id, { agent: "build" });
    t.core.submitPrompt(build.id, { text: "hi" });
    await waitForEvent(t.bus, "run.finished");

    const chatSystem = (provider.requests[0] as LlmRequest).messages.find((m) => m.role === "system");
    const chatContent = (chatSystem?.content as string) ?? "";
    expect(chatContent).toContain("## Skills");
    expect(chatContent).toContain("- arxiv: Search arXiv papers.");
    // The persona still leads the system message.
    expect(chatContent.indexOf("bai's chat agent")).toBeLessThan(chatContent.indexOf("## Skills"));

    const buildSystem = (provider.requests[1] as LlmRequest).messages.find((m) => m.role === "system");
    expect(((buildSystem?.content as string) ?? "")).not.toContain("## Skills");
  });

  test("agents that can save skills get the authoring guidance; readers don't", async () => {
    t = makeCore();
    t.config.models.default = "scripted/main";
    // At least one skill must exist for the index to render at all (an
    // empty index renders no block — the guidance rides the block).
    t.skills.put("arxiv", { description: "Search arXiv papers.", body: "# arXiv" });
    const provider = new ScriptedToolProvider([finalText("hello"), finalText("hello again")]);
    t.providers.register(provider);

    // The chat orchestrator has skills.save (via "*") — guidance present.
    const chat = t.core.createSession({ workbench: "chat" });
    await t.core.setSessionAgent(chat.id, { agent: "chat" });
    t.core.submitPrompt(chat.id, { text: "hi" });
    await waitForEvent(t.bus, "run.finished");

    // The cleanest contrast is a file agent with ONLY skills.view (reader,
    // no authoring guidance). The harness's agent dir is t.dir/agents.
    const agentsDir = join(t.dir, "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, "reader.md"), "---\ntools:\n  - skills.view\n---\nYou read skills.");
    // The agent registry hot-reloads; wait for the agent to appear.
    const deadline = Date.now() + 5000;
    while (t.core.getAgent("reader") === undefined && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }

    const reader = t.core.createSession({ workbench: "chat" });
    await t.core.setSessionAgent(reader.id, { agent: "reader" });
    t.core.submitPrompt(reader.id, { text: "hi" });
    await waitForEvent(t.bus, "run.finished");

    const chatContent = (((provider.requests[0] as LlmRequest).messages.find((m) => m.role === "system"))?.content as string) ?? "";
    expect(chatContent).toContain("Authoring skills:");
    expect(chatContent).toContain("skills.save");

    const readerContent = (((provider.requests[1] as LlmRequest).messages.find((m) => m.role === "system"))?.content as string) ?? "";
    expect(readerContent).toContain("## Skills");
    expect(readerContent).not.toContain("Authoring skills:");
  });

  test("a skills.view call in a run records an attributed skill_events row", async () => {
    t = makeCore();
    t.config.models.default = "scripted/main";
    t.skills.put("arxiv", { description: "Search arXiv papers.", body: "# arXiv\n\nSearch." });
    const provider = new ScriptedToolProvider([
      [
        { type: "tool_call_delta", id: "call_1", name: "skills.view", argsDelta: '{"name":"arxiv"}' },
        { type: "done", stopReason: "tool_use" },
      ],
      finalText("loaded the skill"),
    ]);
    t.providers.register(provider);

    const session = t.core.createSession({ workbench: "chat" });
    await t.core.setSessionAgent(session.id, { agent: "chat" });
    t.core.submitPrompt(session.id, { text: "use the arxiv skill" });
    await waitForEvent(t.bus, "run.finished");

    const rows = t.store.skillUsage.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.skill).toBe("arxiv");
    expect(rows[0]?.agent).toBe("chat");
    expect(rows[0]?.ok).toBe(true);
    expect(rows[0]?.bytes).toBeGreaterThan(0);
    expect(rows[0]?.sessionId).toBe(session.id);
  });
});
