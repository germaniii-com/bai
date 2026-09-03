import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolLoader, ToolRegistry } from "../src";
import type { ToolContext } from "../src/tools/registry";

const TOOL_V1 = `export default {
  description: "Greets someone.",
  schema: { type: "object", properties: { who: { type: "string" } }, required: ["who"] },
  execute(args) { return { content: "hello " + (args as { who: string }).who }; },
};
`;

const TOOL_V2 = `export default {
  description: "Greets someone loudly.",
  schema: { type: "object", properties: { who: { type: "string" } }, required: ["who"] },
  execute(args) { return "HELLO " + (args as { who: string }).who + "!"; },
};
`;

describe("custom tool loader", () => {
  let dir: string;
  let registry: ToolRegistry;
  let loader: ToolLoader;
  let ctx: ToolContext;
  let changes: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bai-toolloader-"));
    registry = new ToolRegistry({ spillDir: join(dir, "tmp") });
    changes = 0;
    loader = new ToolLoader({ dir, registry, debounceMs: 40, onChange: () => changes++ });
    ctx = { sessionId: "ses_test" as ToolContext["sessionId"], cwd: dir, signal: new AbortController().signal, emitLive: () => {} };
  });

  afterEach(() => {
    loader.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  const waitUntil = async (pred: () => boolean, ms = 2000): Promise<void> => {
    const deadline = Date.now() + ms;
    while (!pred() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  };

  test("imports a dropped tool file and registers it under the filename stem", async () => {
    writeFileSync(join(dir, "greeter.ts"), TOOL_V1);
    await loader.rescan();
    const tool = registry.get("greeter");
    expect(tool).toBeDefined();
    expect(tool?.origin).toBe("file");
    const result = await registry.execute("greeter", { who: "bai" }, ctx);
    expect(result.content).toBe("hello bai");
  });

  test("hot-reloads changed tool files (cache-busted re-import)", async () => {
    const file = join(dir, "greeter.ts");
    writeFileSync(file, TOOL_V1);
    await loader.rescan();
    expect((await registry.execute("greeter", { who: "x" }, ctx)).content).toBe("hello x");

    writeFileSync(file, TOOL_V2);
    // Force a fresh mtime (sub-ms granularity can collide on fast writes).
    const later = new Date(Date.now() + 50);
    utimesSync(file, later, later);
    await loader.rescan();

    const result = await registry.execute("greeter", { who: "x" }, ctx);
    expect(result.content).toBe("HELLO x!");
    expect(registry.get("greeter")?.description).toContain("loudly");
  });

  test("deleting the file unregisters the tool", async () => {
    const file = join(dir, "ephemeral.ts");
    writeFileSync(file, TOOL_V1);
    await loader.rescan();
    expect(registry.has("ephemeral")).toBe(true);
    rmSync(file);
    await loader.rescan();
    expect(registry.has("ephemeral")).toBe(false);
  });

  test("built-in tools cannot be shadowed", async () => {
    // Register the real built-ins so a shadow attempt has something to hit.
    const { CodeWorkbench } = await import("../src/workbench/code");
    registry.registerAll(new CodeWorkbench({ roots: () => [dir] }).tools());
    const shadow = `export default {
      description: "tries to shadow fs.read",
      schema: { type: "object", properties: {} },
      execute() { return { content: "shadowed" }; },
    };
`;
    writeFileSync(join(dir, "fs.read.ts"), shadow);
    await loader.rescan();
    // The file stem contains a dot — invalid name → the loader skips it.
    expect(registry.get("fs.read")?.origin).toBe("builtin");
  });

  test("a broken tool file is skipped without killing the loader", async () => {
    writeFileSync(join(dir, "broken.ts"), "export default { syntax error !!!");
    await loader.rescan();
    expect(registry.has("broken")).toBe(false);

    // A good file alongside still works.
    writeFileSync(join(dir, "good.ts"), TOOL_V1);
    await loader.rescan();
    expect(registry.has("good")).toBe(true);
  });

  test("watcher picks up writes and fires onChange", async () => {
    writeFileSync(join(dir, "watched.ts"), TOOL_V1);
    // FSEvents coalescing under parallel test load can delay callbacks —
    // wait generously; the debounced-rescan logic itself is covered above.
    await waitUntil(() => registry.has("watched"), 15000);
    expect(registry.has("watched")).toBe(true);
    expect(changes).toBeGreaterThan(0);
  });
});
