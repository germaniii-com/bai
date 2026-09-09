import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeCore, type TestCore } from "./harness";
import type { SessionId } from "@bai/shared";

/**
 * skills.view — progressive disclosure + analytics. Every execution path
 * (full view, linked file, unknown skill, traversal attempt) must return
 * the right content AND record exactly one skill_events row.
 */
describe("skills.view tool", () => {
  let t: TestCore;
  let sessionId: SessionId;

  beforeEach(() => {
    t = makeCore();
    sessionId = t.core.createSession({ workbench: "chat" }).id;
    t.skills.put("arxiv", {
      description: "Search arXiv papers by keyword or ID.",
      body: "# arXiv Research\n\nSearch papers via the REST API.",
      tags: ["research"],
    });
    const refs = join(t.skills.dirFor("arxiv"), "references");
    mkdirSync(refs, { recursive: true });
    writeFileSync(join(refs, "api.md"), "GET https://export.arxiv.org/api/query");
    // The linked file landed after put()'s scan — refresh the cached set.
    t.skills.scan();
  });

  afterEach(() => {
    t.store.close();
  });

  const ctx = (agent = "chat") => ({
    sessionId,
    agent,
    signal: new AbortController().signal,
    emitLive: () => {},
  });

  test("full view returns the body plus a linked-files hint and records the view", async () => {
    const result = await t.tools.execute("skills.view", { name: "arxiv" }, ctx("chat"));
    expect(result.content).toContain("# arXiv Research");
    expect(result.content).toContain("Search papers via the REST API.");
    expect(result.content).toContain("references/api.md");
    expect(result.meta?.skill).toBe("arxiv");

    const rows = t.store.skillUsage.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.skill).toBe("arxiv");
    expect(rows[0]?.agent).toBe("chat");
    expect(rows[0]?.ok).toBe(true);
    expect(rows[0]?.filePath).toBeUndefined();
    expect(rows[0]?.bytes).toBeGreaterThan(0);
    expect(rows[0]?.sessionId).toBe(sessionId);
  });

  test("linked-file read returns the file and records file_path", async () => {
    const result = await t.tools.execute("skills.view", { name: "arxiv", path: "references/api.md" }, ctx("build"));
    expect(result.content).toBe("GET https://export.arxiv.org/api/query");
    expect(result.meta?.filePath).toBe("references/api.md");

    const rows = t.store.skillUsage.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.filePath).toBe("references/api.md");
    expect(rows[0]?.agent).toBe("build");
    expect(rows[0]?.ok).toBe(true);
  });

  test("unknown skill errors and records a failure row", async () => {
    expect(t.tools.execute("skills.view", { name: "ghost" }, ctx())).rejects.toThrow("Unknown skill: ghost");
    const rows = t.store.skillUsage.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.skill).toBe("ghost");
    expect(rows[0]?.ok).toBe(false);
    expect(rows[0]?.error).toContain("Unknown skill");
  });

  test("traversal paths are rejected (and recorded)", async () => {
    for (const bad of ["../outside.md", "/etc/passwd", "references/../../escape.md"]) {
      expect(t.tools.execute("skills.view", { name: "arxiv", path: bad }, ctx())).rejects.toThrow(
        /not a linked file|escapes the skill directory/,
      );
    }
    const rows = t.store.skillUsage.list();
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.ok).toBe(false);
      expect(row.error).toContain("linked");
    }
  });

  test("a path not in the skill's linkedFiles list is rejected", async () => {
    expect(t.tools.execute("skills.view", { name: "arxiv", path: "references/nope.md" }, ctx())).rejects.toThrow(
      /not a linked file/,
    );
    expect(t.store.skillUsage.list()).toHaveLength(1);
  });

  test("missing name errors without recording (nothing meaningful to attribute)", async () => {
    expect(t.tools.execute("skills.view", {}, ctx())).rejects.toThrow("name must be");
    expect(t.store.skillUsage.list()).toHaveLength(0);
  });

  test("the agent skills whitelist hard-gates non-whitelisted names", async () => {
    t.skills.put("deploy", { description: "Ship releases.", body: "# deploy" });
    // A file agent whitelisting ONLY arxiv (the service wires agentSkills
    // from the agents registry — the same list run.ts filters the index by).
    t.core.putAgent("scoped", { prompt: "You read one skill.", tools: ["skills.view"], skills: ["arxiv"] });

    // Whitelisted skill loads fine.
    const ok = await t.tools.execute("skills.view", { name: "arxiv" }, ctx("scoped"));
    expect(ok.content).toContain("# arXiv Research");

    // Non-whitelisted skill is rejected BEFORE the existence lookup (the
    // error must not leak that "deploy" exists) and recorded as a failure.
    expect(t.tools.execute("skills.view", { name: "deploy" }, ctx("scoped"))).rejects.toThrow(
      /Skill "deploy" is not available to this agent\. Allowed skills: arxiv\./,
    );
    // A guessed unknown name reads the same way (no existence leak).
    expect(t.tools.execute("skills.view", { name: "ghost" }, ctx("scoped"))).rejects.toThrow(
      /Skill "ghost" is not available to this agent/,
    );

    const rows = t.store.skillUsage.list().filter((r) => r.agent === "scoped");
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.ok === true)).toHaveLength(1);
    expect(rows.filter((r) => r.ok === false)).toHaveLength(2);
    expect(rows.find((r) => r.ok === false)?.error).toContain("not whitelisted");
  });

  test("agents without a whitelist (or a '*' wildcard) keep loading every skill", async () => {
    t.skills.put("deploy", { description: "Ship releases.", body: "# deploy" });
    // The chat built-in has no skills field → gate open.
    const a = await t.tools.execute("skills.view", { name: "deploy" }, ctx("chat"));
    expect(a.content).toContain("# deploy");
    // An explicit ["*"] whitelist is also allow-all.
    t.core.putAgent("wildcard", { prompt: "x", tools: ["skills.view"], skills: ["*"] });
    const b = await t.tools.execute("skills.view", { name: "deploy" }, ctx("wildcard"));
    expect(b.content).toContain("# deploy");
  });

  test("forSkill totals count successful views only", async () => {
    await t.tools.execute("skills.view", { name: "arxiv" }, ctx("chat"));
    await t.tools.execute("skills.view", { name: "arxiv", path: "references/api.md" }, ctx("chat"));
    expect(t.tools.execute("skills.view", { name: "arxiv", path: "nope.md" }, ctx())).rejects.toThrow();

    const totals = t.store.skillUsage.forSkill("arxiv");
    expect(totals.views).toBe(2);
    expect(totals.sessions).toBe(1);
    expect(totals.lastUsedAt).toBeDefined();
  });
});
