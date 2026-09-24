import { describe, expect, test } from "bun:test";
import {
  BUILD_AGENT_PROMPT,
  BUILTIN_CHAT_AGENT,
  BUILTIN_PLAN_AGENT,
  CHAT_AGENT_PROMPT,
  LEARN_AGENT_PROMPT,
  PLAN_AGENT_PROMPT,
} from "../src/agents";

/**
 * Built-in agent prompt contracts — every code-capable persona must teach the
 * phased scan-first workflow (glob/list/grep before reading files one by one)
 * and the token-efficiency rules (batch independent calls, no redundant
 * reads/searches, fs tools over bash, narrow reads). These are marker checks,
 * not full-string snapshots: the bodies are prose and stay editable.
 */
describe("built-in agent prompts teach phased codebase scanning", () => {
  test("build agent leads with its identity and the scan-before-read protocol", () => {
    expect(BUILD_AGENT_PROMPT.startsWith("You are bai's build agent")).toBe(true);
    expect(BUILD_AGENT_PROMPT).toContain("Scan before you read");
    expect(BUILD_AGENT_PROMPT).toContain("ORIENT");
    expect(BUILD_AGENT_PROMPT).toContain("LOCATE");
    expect(BUILD_AGENT_PROMPT).toContain("READ NARROW");
    expect(BUILD_AGENT_PROMPT).toContain("fs.grep");
    expect(BUILD_AGENT_PROMPT).toContain("offset/limit");
    expect(BUILD_AGENT_PROMPT).toContain("Batch independent lookups");
    expect(BUILD_AGENT_PROMPT).toContain("Never repeat yourself");
    expect(BUILD_AGENT_PROMPT).toContain("not bash cat/rg/find/ls");
    expect(BUILD_AGENT_PROMPT).toContain("subagent");
    // Editing safety survives the rewrite.
    expect(BUILD_AGENT_PROMPT).toContain("Read a file before editing it");
    expect(BUILD_AGENT_PROMPT).toContain("old_string");
  });

  test("chat agent leads with its identity and has a codebase section", () => {
    expect(CHAT_AGENT_PROMPT.startsWith("You are bai's chat agent")).toBe(true);
    expect(CHAT_AGENT_PROMPT).toContain("When working in a codebase");
    expect(CHAT_AGENT_PROMPT).toContain("Scan before reading");
    expect(CHAT_AGENT_PROMPT).toContain("Batch independent searches and reads");
    expect(CHAT_AGENT_PROMPT).toContain("bash cat/rg/find/ls");
    expect(CHAT_AGENT_PROMPT).toContain("subagent");
  });

  test("plan agent leads with its identity and explores in phases", () => {
    expect(PLAN_AGENT_PROMPT.startsWith("You are bai's plan agent")).toBe(true);
    expect(PLAN_AGENT_PROMPT).toContain("EXPLORE in phases");
    expect(PLAN_AGENT_PROMPT).toContain("fs.grep");
    expect(PLAN_AGENT_PROMPT).toContain("offset/limit");
    expect(PLAN_AGENT_PROMPT).toContain("Batch independent searches and reads");
    expect(PLAN_AGENT_PROMPT).toContain("never repeat a search");
    expect(PLAN_AGENT_PROMPT).toContain("web.search");
  });

  test("learn agent leads with its identity and gathers sources in phases", () => {
    expect(LEARN_AGENT_PROMPT.startsWith("You are bai's learn agent")).toBe(true);
    expect(LEARN_AGENT_PROMPT).toContain("GATHER the described sources");
    expect(LEARN_AGENT_PROMPT).toContain("fs.grep");
    expect(LEARN_AGENT_PROMPT).toContain("offset/limit");
    expect(LEARN_AGENT_PROMPT).toContain("never walk a directory file by file");
  });
});

describe("built-in agent prompts teach context compaction", () => {
  test("every built-in agent names the ~75% auto-compaction threshold", () => {
    for (const prompt of [BUILD_AGENT_PROMPT, CHAT_AGENT_PROMPT, PLAN_AGENT_PROMPT, LEARN_AGENT_PROMPT]) {
      expect(prompt).toContain("~75%");
      expect(prompt).toContain("context window");
      expect(prompt).toContain("compact");
    }
  });

  test("agents keep durable state where compaction cannot reach it", () => {
    // build: artifacts; chat: notes/plans/todos + the compaction skill.
    expect(BUILD_AGENT_PROMPT).toContain("session notes");
    expect(CHAT_AGENT_PROMPT).toContain("compaction skill");
    // plan: the plan file is the durable artifact.
    expect(PLAN_AGENT_PROMPT).toContain("plan file");
    // learn: the notes log is the running source of truth.
    expect(LEARN_AGENT_PROMPT).toContain("session notes");
  });
});

describe("built-in agent tool grants", () => {
  test("plan and chat have web-search access by default", () => {
    expect(BUILTIN_PLAN_AGENT.tools).toContain("web.search");
    expect(BUILTIN_PLAN_AGENT.tools).toContain("web.fetch");
    // chat is the all-tools orchestrator — ["*"] already includes web tools.
    expect(BUILTIN_CHAT_AGENT.tools).toEqual(["*"]);
  });
});
