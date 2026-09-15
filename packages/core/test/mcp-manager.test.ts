import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, type Config } from "@bai/shared";
import { ToolRegistry } from "../src/tools/registry";
import { McpRegistry } from "../src/mcp/registry";
import { McpManager } from "../src/mcp/manager";

const FIXTURE = join(import.meta.dir, "fixtures", "mcp-echo-server.ts");

function makeConfig(mcp: Config["mcp"] = {}): Config {
  return { ...DEFAULT_CONFIG, mcp };
}

interface Stack {
  dir: string;
  tokensDir: string;
  registry: McpRegistry;
  tools: ToolRegistry;
  manager: McpManager;
}

const stacks: Stack[] = [];
afterEach(async () => {
  for (const stack of stacks.splice(0)) {
    await stack.manager.stop();
    stack.registry.stop();
    rmSync(stack.dir, { recursive: true, force: true });
    rmSync(stack.tokensDir, { recursive: true, force: true });
  }
});

function makeStack(config: Config = makeConfig()): Stack {
  const dir = mkdtempSync(join(tmpdir(), "bai-mcp-"));
  const tokensDir = mkdtempSync(join(tmpdir(), "bai-mcp-tokens-"));
  const registry = new McpRegistry({ dir, config: () => config, pollMs: 0 });
  const tools = new ToolRegistry();
  const manager = new McpManager({ registry, tools, version: "test", tokensDir, connectTimeoutMs: 15_000 });
  const stack = { dir, tokensDir, registry, tools, manager };
  stacks.push(stack);
  return stack;
}

describe("McpManager", () => {
  test("connects a stdio server, registers mcp/<server>/<tool>, and calls it", async () => {
    const stack = makeStack();
    stack.registry.put("echo", { command: process.execPath, args: [FIXTURE] });
    await stack.manager.start();

    const status = stack.manager.status();
    expect(status).toHaveLength(1);
    expect(status[0]?.state).toBe("connected");
    expect(status[0]?.tools).toBe(1);

    expect(stack.tools.names()).toContain("mcp/echo/echo");
    const tool = stack.tools.get("mcp/echo/echo");
    expect(tool?.origin).toBe("mcp/echo");
    const result = await tool?.execute({ text: "hi" }, {} as never);
    expect(result?.content).toBe("echo:hi");
    expect((result?.meta as { title: string }).title).toContain("echo/echo");
  }, 20_000);

  test("a failed server is isolated (state=failed) and does not block others", async () => {
    const stack = makeStack();
    stack.registry.put("broken", { command: "definitely-not-a-real-binary-xyz" });
    stack.registry.put("echo", { command: process.execPath, args: [FIXTURE] });
    await stack.manager.start();

    const byName = new Map(stack.manager.status().map((s) => [s.name, s]));
    expect(byName.get("broken")?.state).toBe("failed");
    expect(byName.get("echo")?.state).toBe("connected");
    expect(stack.tools.names()).toContain("mcp/echo/echo");
  }, 20_000);

  test("removing a server file disconnects it and unregisters its tools", async () => {
    const stack = makeStack();
    stack.registry.put("echo", { command: process.execPath, args: [FIXTURE] });
    await stack.manager.start();
    expect(stack.tools.names()).toContain("mcp/echo/echo");

    await stack.manager.remove("echo");
    expect(stack.tools.names()).not.toContain("mcp/echo/echo");
    expect(stack.manager.status()).toHaveLength(0);
  }, 20_000);

  test("disabled servers are listed but never connected", async () => {
    const stack = makeStack();
    stack.registry.put("echo", { command: process.execPath, args: [FIXTURE], enabled: false });
    await stack.manager.start();
    expect(stack.manager.status()[0]?.state).toBe("disabled");
    expect(stack.tools.names()).not.toContain("mcp/echo/echo");
  }, 20_000);

  test("config.json-sourced servers are connected too", async () => {
    const config = makeConfig({ echo: { command: process.execPath, args: [FIXTURE] } });
    const stack = makeStack(config);
    await stack.manager.start();
    expect(stack.manager.status()[0]?.source).toBe("config");
    expect(stack.manager.status()[0]?.state).toBe("connected");
    expect(stack.tools.names()).toContain("mcp/echo/echo");
  }, 20_000);

  test("registerHelperTools exposes resource/prompt helpers once connected", async () => {
    const stack = makeStack();
    stack.registry.put("echo", { command: process.execPath, args: [FIXTURE] });
    await stack.manager.start();
    for (const name of ["mcp/list_resources", "mcp/read_resource", "mcp/list_prompts", "mcp/get_prompt"]) {
      expect(stack.tools.names()).toContain(name);
    }
  }, 20_000);

  test("a newly dropped file is picked up on the next reconcile", async () => {
    const stack = makeStack();
    await stack.manager.start();
    writeFileSync(join(stack.dir, "late.json"), JSON.stringify({ command: process.execPath, args: [FIXTURE] }));
    stack.registry.scan();
    await stack.manager.reconcile();
    expect(stack.tools.names()).toContain("mcp/late/echo");
  }, 20_000);

  test("put exposes the definition via server() and connects it", async () => {
    const stack = makeStack();
    await stack.manager.put("custom", { transport: "stdio", command: process.execPath, args: [FIXTURE] });
    const def = stack.manager.server("custom");
    expect(def?.source).toBe("file");
    expect(def?.config.command).toBe(process.execPath);
    expect(stack.manager.status().find((s) => s.name === "custom")?.state).toBe("connected");
    expect(stack.tools.names()).toContain("mcp/custom/echo");
  }, 20_000);

  test("startAuth rejects clearly when oauth is not enabled", async () => {
    const stack = makeStack();
    stack.registry.put("echo", { command: process.execPath, args: [FIXTURE] });
    await stack.manager.start();
    await expect(stack.manager.startAuth("echo")).rejects.toThrow(/OAuth is not enabled/);
  }, 20_000);

  test("startAuth surfaces the real failure instead of a generic message", async () => {
    const stack = makeStack();
    // Nothing listening → connect fails; authProvider is set, so no SSE retry
    // masks it and the error must reach the caller.
    stack.registry.put("dead", { transport: "http", url: "http://127.0.0.1:1/mcp", oauth: true, timeout: 1500 });
    await stack.manager.start();
    await expect(stack.manager.startAuth("dead")).rejects.toThrow(/dead/);
  }, 20_000);
});
