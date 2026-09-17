import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpServerApp } from "../src";
import { makeStack, type TestStack } from "./harness";

const MCP_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/** A stack plus a live client connected to its in-process /mcp endpoint. */
interface Live {
  t: TestStack;
  server: ReturnType<typeof Bun.serve>;
  client: Client;
  close(): Promise<void>;
}

/** Serve the stack's app and connect a real MCP client to it. */
async function connect(t: TestStack): Promise<Live> {
  const app = createMcpServerApp(t.deps);
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => app.fetch(req) });
  const client = new Client({ name: "bai-test-client", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  return {
    t,
    server,
    client,
    close: async () => {
      await client.close().catch(() => undefined);
      server.stop(true);
      await t.cleanup();
    },
  };
}

async function live(overrides: Partial<TestStack["deps"]> = {}): Promise<Live> {
  return connect(makeStack(overrides));
}

describe("MCP server role — HTTP endpoint", () => {
  let l: Live | undefined;

  afterEach(async () => {
    if (l !== undefined) await l.close();
    l = undefined;
  });

  test("lists aliased tools, hides question, round-trips input schemas", async () => {
    l = await live();
    const probeSchema: Record<string, unknown> = {
      type: "object",
      properties: { x: { type: "string", description: "the x" } },
      required: ["x"],
    };
    l.t.tools.register({
      name: "test.probe",
      description: "probe",
      schema: probeSchema,
      execute: async () => ({ content: "pong" }),
    });

    const { tools } = await l.client.listTools();
    const names = tools.map((tool) => tool.name);
    for (const name of names) expect(MCP_NAME_RE.test(name)).toBe(true);
    expect(names).toContain("test_probe"); // "test.probe" aliased
    expect(names).toContain("fs_read"); // "fs.read" aliased
    expect(names).not.toContain("question");
    expect(names).not.toContain("test.probe");

    const probe = tools.find((tool) => tool.name === "test_probe");
    expect(JSON.stringify(probe?.inputSchema)).toBe(JSON.stringify(probeSchema));
    expect(probe?._meta).toEqual({ "bai/tool": "test.probe", "bai/origin": "builtin" });
  });

  test("calls a tool, runs it under the shared auto-approve session, and records analytics", async () => {
    l = await live();
    let seenSessionId: string | undefined;
    l.t.tools.register({
      name: "test.probe",
      description: "probe",
      schema: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        seenSessionId = ctx.sessionId;
        return { content: "pong" };
      },
    });

    const result = await l.client.callTool({ name: "test_probe", arguments: {} });
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content[0]?.text).toBe("pong");

    expect(seenSessionId).toBeDefined();
    const session = l.t.core.getSession(seenSessionId as never);
    expect(session?.title).toBe("MCP (external)");
    expect(session?.meta.autoApprove).toBe(true);
    expect(session?.meta.mcpServer).toBe(true);

    const events = l.t.store.mcpUsage.list(10);
    const row = events.find((event) => event.tool === "test.probe");
    expect(row?.server).toBe("(bai)");
    expect(row?.kind).toBe("tool");
    expect(row?.ok).toBe(true);
  });

  test("tool failures surface as isError results (never break the request)", async () => {
    l = await live();
    l.t.tools.register({
      name: "test.boom",
      description: "boom",
      schema: { type: "object", properties: {} },
      execute: async () => {
        throw new Error("kaboom");
      },
    });

    const result = await l.client.callTool({ name: "test_boom", arguments: {} });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content[0]?.text).toContain("kaboom");
    const row = l.t.store.mcpUsage.list(10).find((event) => event.tool === "test.boom");
    expect(row?.ok).toBe(false);
    expect(row?.error).toContain("kaboom");
  });

  test("exposes skills as resources, prompts, and a skills_list tool", async () => {
    // The skill must exist BEFORE connect: capabilities are negotiated in the
    // initialize handshake.
    const t = makeStack();
    t.core.putSkill("demo", { description: "A demo skill.", body: "# Demo\nDo the thing." });
    l = await connect(t);

    const resources = await l.client.listResources();
    expect(resources.resources.some((r) => r.uri === "skill://demo")).toBe(true);

    const read = await l.client.readResource({ uri: "skill://demo" });
    const text = (read.contents[0] as { text?: string }).text ?? "";
    expect(text).toContain("Do the thing.");

    const prompts = await l.client.listPrompts();
    expect(prompts.prompts.some((p) => p.name === "demo")).toBe(true);
    const prompt = await l.client.getPrompt({ name: "demo" });
    const message = prompt.messages[0];
    expect((message?.content as { text?: string }).text).toContain("Do the thing.");

    const list = await l.client.callTool({ name: "skills_list", arguments: {} });
    const listText = (list.content as Array<{ text?: string }>)[0]?.text ?? "";
    expect(listText).toContain("demo: A demo skill.");
  });

  test("session operations create, list, read, and drive a session", async () => {
    l = await live();
    const created = await l.client.callTool({ name: "session_create", arguments: { title: "External run", workbench: "chat" } });
    const createdText = (created.content as Array<{ text?: string }>)[0]?.text ?? "";
    const sessionId = (JSON.parse(createdText) as { sessionId: string }).sessionId;
    expect(sessionId.startsWith("ses_")).toBe(true);

    const listed = await l.client.callTool({ name: "session_list", arguments: { limit: 20 } });
    expect((listed.content as Array<{ text?: string }>)[0]?.text).toContain(sessionId);

    const prompted = await l.client.callTool({ name: "session_prompt", arguments: { sessionId, text: "hello there" } });
    expect((prompted.content as Array<{ text?: string }>)[0]?.text).toContain("Echo");

    const history = await l.client.callTool({ name: "session_history", arguments: { sessionId } });
    expect((history.content as Array<{ text?: string }>)[0]?.text).toContain("hello there");
  });
});

describe("MCP server role — gate and auth", () => {
  let t: TestStack | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;

  afterEach(async () => {
    server?.stop(true);
    server = undefined;
    if (t !== undefined) await t.cleanup();
    t = undefined;
  });

  /** Serve the app for real so Host/Origin headers exist (Bun.serve sets Host). */
  function serve(stack: TestStack): string {
    const app = createMcpServerApp(stack.deps);
    server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => app.fetch(req) });
    return `http://127.0.0.1:${server.port}/mcp`;
  }

  const post = (url: string, headers: Record<string, string> = {}) =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });

  test("a disabled server 404s as if uninstalled, and toggles live", async () => {
    t = makeStack();
    const url = serve(t);

    // Default stack config enables it.
    expect((await post(url)).status).not.toBe(404);

    t.setConfig({ mcpServer: { enabled: false } });
    const disabled = await post(url);
    expect(disabled.status).toBe(404);
    expect(((await disabled.json()) as { error?: { type?: string } }).error?.type).toBe("mcp_disabled");

    t.setConfig({ mcpServer: { enabled: true } });
    expect((await post(url)).status).not.toBe(404);
  });

  test("non-loopback requires the bearer token (or ?token=)", async () => {
    t = makeStack({ loopbackBind: false, token: "secret-token" });
    const url = serve(t);

    expect((await post(url)).status).toBe(401);
    expect((await post(url, { authorization: "Bearer secret-token" })).status).not.toBe(401);
    expect((await post(`${url}?token=secret-token`)).status).not.toBe(401);
  });
});
