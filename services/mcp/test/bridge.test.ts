import { afterEach, describe, expect, test } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { createMcpServerApp, createProxyServer } from "../src";
import { makeStack, type TestStack } from "./harness";

/**
 * The stdio bridge is a proxy: it mirrors a running bai `/mcp` onto a local
 * MCP server. These tests exercise the proxy over an in-memory transport pair
 * (the real stdio wiring is a thin `serveStdio` shell around the same code).
 */
describe("MCP server role — stdio bridge proxy", () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (cleanup !== undefined) await cleanup();
    cleanup = undefined;
  });

  test("mirrors tools, resources, prompts, and forwards calls", async () => {
    const t: TestStack = makeStack();
    t.tools.register({
      name: "test.probe",
      description: "probe",
      schema: { type: "object", properties: { x: { type: "string" } } },
      execute: async (args) => ({ content: `pong:${(args as { x?: string }).x ?? ""}` }),
    });
    t.core.putSkill("demo", { description: "A demo skill.", body: "# Demo\nProxy me." });

    const app = createMcpServerApp(t.deps);
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => app.fetch(req) });
    const remote = new Client({ name: "remote", version: "0.0.0" });
    await remote.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));

    const proxy = await createProxyServer(remote, "test");
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    const local = new Client({ name: "local", version: "0.0.0" });
    await Promise.all([proxy.connect(serverSide), local.connect(clientSide)]);
    cleanup = async () => {
      await local.close().catch(() => undefined);
      await proxy.close().catch(() => undefined);
      await remote.close().catch(() => undefined);
      server.stop(true);
      await t.cleanup();
    };

    const tools = await local.listTools();
    const probe = tools.tools.find((tool) => tool.name === "test_probe");
    expect(probe).toBeDefined();
    expect(JSON.stringify(probe?.inputSchema)).toBe(
      JSON.stringify({ type: "object", properties: { x: { type: "string" } } }),
    );

    const call = await local.callTool({ name: "test_probe", arguments: { x: "y" } });
    expect((call.content as Array<{ text?: string }>)[0]?.text).toBe("pong:y");

    const prompts = await local.listPrompts();
    expect(prompts.prompts.some((prompt) => prompt.name === "demo")).toBe(true);
    const prompt = await local.getPrompt({ name: "demo" });
    expect((prompt.messages[0]?.content as { text?: string }).text).toContain("Proxy me.");

    const resources = await local.listResources();
    expect(resources.resources.some((resource) => resource.uri === "skill://demo")).toBe(true);
    const read = await local.readResource({ uri: "skill://demo" });
    expect((read.contents[0] as { text?: string }).text).toContain("Proxy me.");
  });
});
