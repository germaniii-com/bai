import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeCore, type TestCore } from "./harness";

/**
 * stub/fs-demo — the scripted stub model (provider/stub.ts): a prompt JSON
 * `{path, content}` drives ONE real fs.write through the genuine pipeline
 * (tool gating → execution → patch part → firehose). This is the e2e
 * vehicle for tool-driven UI (the web file viewer's live updates) and the
 * regression net for the stub itself.
 */

describe("stub/fs-demo scripted model", () => {
  let t: TestCore;
  let dir: string;

  beforeEach(() => {
    t = makeCore();
    t.config.models.default = "stub/fs-demo";
    dir = mkdtempSync(join(tmpdir(), "bai-fsdemo-"));
  });

  afterEach(() => {
    t.store.close();
    rmSync(t.dir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  test("writes the file through the real pipeline (non-git: no patch part)", async () => {
    const session = t.core.createSession({ workbench: "code", cwd: dir });
    t.core.submitPrompt(session.id, { text: JSON.stringify({ path: "notes.md", content: "agent was here\n" }) });
    await t.core.drainNow(session.id);

    expect(readFileSync(join(dir, "notes.md"), "utf8")).toBe("agent was here\n");

    // The transcript carries the fs.read + fs.write calls + results; the run
    // ended with the stub's second-turn text (no further tool calls).
    const history = t.core.history(session.id);
    const assistant = history.filter((m) => m.role === "assistant");
    const kinds = assistant.flatMap((m) => m.parts.map((p) => p.kind));
    expect(kinds).toContain("tool_call");
    expect(kinds).toContain("tool_result");
    const callNames = assistant
      .flatMap((m) => m.parts)
      .filter((p) => p.kind === "tool_call")
      .map((p) => (p.payload as { name: string }).name);
    expect(callNames).toEqual(["fs.read", "fs.write"]);
    const lastText = assistant[assistant.length - 1]?.parts.find((p) => p.kind === "text");
    expect((lastText?.payload as { text?: string }).text).toBe("Wrote the file.");

    // Non-git workspace → snapshots disabled → no patch part.
    expect(kinds).not.toContain("patch");
  });

  test("git workspace: the batch records a patch part listing the written file", async () => {
    const proc = Bun.spawn({ cmd: ["git", "-C", dir, "init"], stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    await proc.exited;
    writeFileSync(join(dir, "existing.txt"), "seed\n");

    const session = t.core.createSession({ workbench: "code", cwd: dir });
    t.core.submitPrompt(session.id, { text: JSON.stringify({ path: "created/new.txt", content: "fresh\n" }) });
    await t.core.drainNow(session.id);

    expect(readFileSync(join(dir, "created", "new.txt"), "utf8")).toBe("fresh\n");
    const history = t.core.history(session.id);
    const patchPart = history.flatMap((m) => m.parts).find((p) => p.kind === "patch");
    expect(patchPart).toBeDefined();
    expect((patchPart?.payload as { files: string[] }).files).toContain(join("created", "new.txt"));
  });

  test("overwriting an EXISTING file: the scripted fs.read satisfies the write guard", async () => {
    writeFileSync(join(dir, "notes.md"), "original\n");
    const session = t.core.createSession({ workbench: "code", cwd: dir });
    t.core.submitPrompt(session.id, { text: JSON.stringify({ path: "notes.md", content: "overwritten\n" }) });
    await t.core.drainNow(session.id);

    expect(readFileSync(join(dir, "notes.md"), "utf8")).toBe("overwritten\n");
    const calls = t.core.history(session.id).flatMap((m) => m.parts).filter((p) => p.kind === "tool_call");
    expect(calls.map((p) => (p.payload as { name: string }).name)).toEqual(["fs.read", "fs.write"]);
  });

  test("unparseable prompts fall back to the echo (no tool call)", async () => {
    const session = t.core.createSession({ workbench: "code", cwd: dir });
    t.core.submitPrompt(session.id, { text: "just talk to me" });
    await t.core.drainNow(session.id);

    expect(existsSync(join(dir, "notes.md"))).toBe(false);
    const history = t.core.history(session.id);
    const kinds = history.flatMap((m) => m.parts.map((p) => p.kind));
    expect(kinds).not.toContain("tool_call");
    const text = history.filter((m) => m.role === "assistant").flatMap((m) => m.parts).find((p) => p.kind === "text");
    expect((text?.payload as { text?: string }).text).toContain("Echo: just talk to me");
  });
});
