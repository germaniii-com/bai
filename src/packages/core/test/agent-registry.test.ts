import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry, parseAgentMarkdown, serializeAgentMarkdown } from "../src/agent/registry";
import { BUILTIN_BUILD_AGENT } from "@bai/shared";

describe("agent markdown parsing", () => {
  test("frontmatter + body round-trip", () => {
    const md = serializeAgentMarkdown({
      description: "Reviews code.",
      model: "anthropic/claude-sonnet-4-5",
      tools: ["fs.read", "fs.glob"],
      prompt: "You are a reviewer.",
    });
    const agent = parseAgentMarkdown(md, "reviewer", "/tmp/reviewer.md");
    expect(agent).toBeDefined();
    expect(agent?.name).toBe("reviewer");
    expect(agent?.description).toBe("Reviews code.");
    expect(agent?.model).toBe("anthropic/claude-sonnet-4-5");
    expect(agent?.tools).toEqual(["fs.read", "fs.glob"]);
    expect(agent?.prompt).toBe("You are a reviewer.");
    expect(agent?.source).toBe("file");
    expect(agent?.path).toBe("/tmp/reviewer.md");
  });

  test("bare body (no frontmatter) = pure persona with no tools", () => {
    const agent = parseAgentMarkdown("Just a persona.", "bare");
    expect(agent).toBeDefined();
    expect(agent?.tools).toEqual([]);
    expect(agent?.description).toBeUndefined();
    expect(agent?.prompt).toBe("Just a persona.");
  });

  test("invalid frontmatter is rejected (undefined)", () => {
    expect(parseAgentMarkdown("---\ntools: not-an-array\n---\nBody", "x")).toBeUndefined();
    // empty body rejected
    expect(parseAgentMarkdown("---\ndescription: x\n---\n   ", "x")).toBeUndefined();
  });
});

describe("agent registry", () => {
  let dir: string;
  let registry: AgentRegistry;
  let changes: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bai-agents-"));
    changes = 0;
    registry = new AgentRegistry({
      dir,
      debounceMs: 40,
      onChange: () => {
        changes++;
      },
    });
  });

  afterEach(() => {
    registry.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test("build is always present as the default", () => {
    expect(registry.default().name).toBe("build");
    expect(registry.get("build")?.source).toBe("builtin");
    expect(registry.list().map((a) => a.name)).toContain("build");
  });

  test("scan picks up dropped agent files", () => {
    writeFileSync(join(dir, "reviewer.md"), "---\ndescription: d\n---\nYou review.");
    expect(registry.scan()).toBe(true);
    const agent = registry.get("reviewer");
    expect(agent?.description).toBe("d");
    expect(agent?.prompt).toBe("You review.");
  });

  test("a file named build.md is ignored (built-in not shadowable)", () => {
    writeFileSync(join(dir, "build.md"), "evil prompt");
    registry.scan();
    expect(registry.get("build")?.source).toBe("builtin");
    expect(registry.get("build")?.prompt).toBe(BUILTIN_BUILD_AGENT.prompt);
  });

  test("invalid names and unreadable files are skipped", () => {
    writeFileSync(join(dir, "1bad.md"), "body");
    writeFileSync(join(dir, "ok_name.md"), "body");
    registry.scan();
    expect(registry.get("1bad")).toBeUndefined();
    expect(registry.get("ok_name")).toBeDefined();
  });

  test("deleted files disappear from the registry", () => {
    writeFileSync(join(dir, "gone.md"), "body");
    registry.scan();
    expect(registry.get("gone")).toBeDefined();
    rmSync(join(dir, "gone.md"));
    registry.scan();
    expect(registry.get("gone")).toBeUndefined();
  });

  test("watcher hot-reloads new agents without restart", async () => {
    writeFileSync(join(dir, "hot.md"), "---\ntools:\n  - fs.read\n---\nHot body.");
    // fs.watch latency can spike under parallel test load — give it room.
    const deadline = Date.now() + 5000;
    while (registry.get("hot") === undefined && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    const agent = registry.get("hot");
    expect(agent).toBeDefined();
    expect(agent?.tools).toEqual(["fs.read"]);
    expect(changes).toBeGreaterThan(0);
  });

  test("watcher coalesces rapid writes into one change", async () => {
    const before = changes;
    for (let i = 0; i < 3; i++) {
      writeFileSync(join(dir, `rapid-${i}.md`), `body ${i}`);
    }
    await new Promise((r) => setTimeout(r, 300));
    expect(changes).toBe(before + 1);
    expect(registry.get("rapid-2")).toBeDefined();
  });

  test("put writes a file and remove deletes it (CRUD path)", () => {
    const agent = registry.put("writer", { description: "w", prompt: "You write.", tools: ["fs.write"] });
    expect(agent.name).toBe("writer");
    expect(existsSync(registry.fileFor("writer"))).toBe(true);
    const onDisk = readFileSync(registry.fileFor("writer"), "utf8");
    expect(onDisk).toContain("fs.write");

    expect(registry.remove("writer")).toBe(true);
    expect(existsSync(registry.fileFor("writer"))).toBe(false);
    expect(registry.get("writer")).toBeUndefined();
  });

  test("put refuses the built-in name and invalid names", () => {
    expect(() => registry.put("build", { prompt: "x" })).toThrow();
    expect(() => registry.put("9bad", { prompt: "x" })).toThrow();
  });
});
