import { describe, expect, test } from "bun:test";
import { buildLearnRequest, LEARN_AGENT_NAME } from "../src/learn";

/**
 * Learn prompt contracts — ported from hermes-agent's
 * tests/agent/test_learn_prompt.py (the load-bearing behavior contracts;
 * /learn has no engine and no model tool: the prompt IS the feature).
 */
describe("buildLearnRequest", () => {
  test("embeds the user request verbatim", () => {
    const req = "the REST client in ~/projects/acme-sdk, focus on auth";
    const prompt = buildLearnRequest(req);
    expect(prompt).toContain(req);
  });

  test("separates sources from requirements (the trailing-prose bug)", () => {
    // When a request leads with a path/URL, the agent must not fetch it and
    // ignore the trailing prose — that prose is authoring guidance to honor.
    const prompt = buildLearnRequest(
      "https://api.example.com/docs focus on the auth flow, skip deprecated bits",
    );
    const low = prompt.toLowerCase();
    // Carries the whole request verbatim (no truncation at the URL).
    expect(prompt).toContain("focus on the auth flow, skip deprecated bits");
    // Explicitly distinguishes sources from requirements.
    expect(low).toContain("requirement");
    // Names the failure mode it's guarding against.
    expect(low).toContain("never fetch the first source");
  });

  test("teaches the full authoring standards", () => {
    const prompt = buildLearnRequest("~/books/ddia.pdf");
    const low = prompt.toLowerCase();
    // #1 description: the count-and-trim self-check (the reported bug).
    expect(low).toContain("count");
    expect(low).toContain("60");
    // #3 platforms gating against OS-bound primitives (bai platform values).
    expect(low).toContain("platforms");
    expect(low).toContain("darwin");
    // author is always the literal bai, never the host/OS identity.
    expect(low).toContain("literal value `bai`");
    expect(low).toContain("never fill it from the host");
    // #2 bai-tool framing names the wrapped tools, not shell utilities.
    for (const tool of ["fs.read", "fs.grep", "fs.edit", "fs.write", "web.fetch", "bash"]) {
      expect(low).toContain(tool);
    }
    // #6 scripts/references/templates layout.
    expect(prompt).toContain("scripts/");
    expect(prompt).toContain("references/");
  });

  test("teaches the knowledge-base layout", () => {
    const prompt = buildLearnRequest("a large docs corpus");
    const low = prompt.toLowerCase();
    // On-demand loading goes through skills.view with a path.
    expect(prompt).toContain("skills.view");
    expect(prompt).toContain('path="references/');
    // Structure, not summary — the load-bearing distillation rule.
    expect(low).toContain("structure");
    expect(low).toContain("summary");
    // Copyright/quality line: synthesized notes, no verbatim reproduction.
    expect(low).toContain("never reproduce");
    // Extend an existing skill rather than minting a near-duplicate.
    expect(low).toContain("fold-in");
    // Large inputs must be persisted incrementally.
    expect(low).toContain("one chapter or topic at a time");
    expect(low).toContain("never load an entire large corpus");
    expect(low).toContain("reconcile the skill.md index");
  });

  test("embeds the shape decision and the save tooling", () => {
    const prompt = buildLearnRequest("~/books/ddia.pdf");
    // The shape decision is explicit: small source -> one file, large prose
    // source -> knowledge-base layout.
    expect(prompt).toContain("Pick the shape by the source");
    expect(prompt).toContain("process it incrementally in step 2b");
    // Saving goes through the authoring tools.
    expect(prompt).toContain("skills.save");
    expect(prompt).toContain("skills.writeFile");
  });

  test("source hygiene covers invisible unicode (Trojan Source class)", () => {
    const prompt = buildLearnRequest("some.pdf");
    const low = prompt.toLowerCase();
    expect(low).toContain("data, not instructions");
    expect(low).toContain("zero-width");
    expect(low).toContain("bidi");
  });

  test("existing skill is extended instead of created again", () => {
    const prompt = buildLearnRequest("add these notes to my distributed-systems skill");
    expect(prompt).toContain("First check the available skills");
    expect(prompt).toContain("load it with `skills.view`");
    expect(prompt).toContain("Only when no matching skill exists");
    expect(prompt).toContain("`skills.save`");
  });

  test("empty request defaults to distilling this conversation", () => {
    const prompt = buildLearnRequest("");
    expect(prompt).toContain("the workflow we just went through in this conversation");
    expect(buildLearnRequest("   ")).toBe(prompt);
  });

  test("the learn agent name is stable", () => {
    expect(LEARN_AGENT_NAME).toBe("learn");
  });
});
