import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  McpServer,
  ResourceTemplate,
  fromJsonSchema,
  type CallToolResult,
  type GetPromptResult,
  type ReadResourceResult,
} from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

/**
 * `bai mcp` — a stdio MCP server that PROXIES to a running bai server's
 * `/mcp` endpoint. Desktop clients (Claude Desktop, Cursor) only speak stdio;
 * this bridge lets them reach bai without booting a second core (which would
 * double-run media jobs and automations, D29).
 *
 * stdout is the JSON-RPC channel: this module must never `console.log`.
 */

interface RemoteTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: { title?: string; readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
}

interface RemoteResource {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

interface RemoteResourceTemplate {
  uriTemplate: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

interface RemotePrompt {
  name: string;
  title?: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}

export interface StdioBridgeOptions {
  /** The running bai `/mcp` URL (e.g. `http://127.0.0.1:9640/mcp`). */
  url: string;
  /** Bearer token for non-loopback servers. */
  token?: string;
  version: string;
}

/** Build the local proxy server from the remote's advertised surface. */
export async function createProxyServer(remote: Client, version: string): Promise<McpServer> {
  const server = new McpServer({ name: "bai", version: version.length > 0 ? version : "0.0.0" });

  const tools = ((await remote.listTools()).tools ?? []) as unknown as RemoteTool[];
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        ...(tool.title !== undefined ? { title: tool.title } : {}),
        ...(tool.description !== undefined ? { description: tool.description } : {}),
        inputSchema: fromJsonSchema((tool.inputSchema ?? { type: "object", properties: {} }) as Parameters<typeof fromJsonSchema>[0]),
        ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
      },
      async (args) =>
        (await remote.callTool({
          name: tool.name,
          arguments: stripInjected(args),
        })) as unknown as CallToolResult,
    );
  }

  const resources = ((await remote.listResources()).resources ?? []) as unknown as RemoteResource[];
  for (const resource of resources) {
    server.registerResource(
      resource.name,
      resource.uri,
      {
        ...(resource.title !== undefined ? { title: resource.title } : {}),
        ...(resource.description !== undefined ? { description: resource.description } : {}),
        ...(resource.mimeType !== undefined ? { mimeType: resource.mimeType } : {}),
      },
      async () => (await remote.readResource({ uri: resource.uri })) as unknown as ReadResourceResult,
    );
  }

  const templates = ((await remote.listResourceTemplates()).resourceTemplates ?? []) as unknown as RemoteResourceTemplate[];
  for (const template of templates) {
    server.registerResource(
      template.name,
      new ResourceTemplate(template.uriTemplate, { list: undefined }),
      {
        ...(template.title !== undefined ? { title: template.title } : {}),
        ...(template.description !== undefined ? { description: template.description } : {}),
        ...(template.mimeType !== undefined ? { mimeType: template.mimeType } : {}),
      },
      async (uri) => (await remote.readResource({ uri: uri.href })) as unknown as ReadResourceResult,
    );
  }

  const prompts = ((await remote.listPrompts()).prompts ?? []) as unknown as RemotePrompt[];
  for (const prompt of prompts) {
    server.registerPrompt(
      prompt.name,
      {
        ...(prompt.title !== undefined ? { title: prompt.title } : {}),
        ...(prompt.description !== undefined ? { description: prompt.description } : {}),
        ...(prompt.arguments !== undefined && prompt.arguments.length > 0
          ? {
              argsSchema: fromJsonSchema(
                promptArgsSchema(prompt.arguments) as Parameters<typeof fromJsonSchema>[0],
              ),
            }
          : {}),
      },
      async (args) => {
        // The server SDK injects request context (`mcpReq`) into prompt
        // handler args; only the prompt's own string arguments may be
        // forwarded to the remote (which validates `arguments`).
        const forwarded = stripInjected(args);
        return (await remote.getPrompt({
          name: prompt.name,
          ...(Object.keys(forwarded).length > 0 ? { arguments: forwarded as Record<string, string> } : {}),
        })) as unknown as GetPromptResult;
      },
    );
  }

  return server;
}

/**
 * Drop the server SDK's injected request context from handler arguments before
 * forwarding. The prompt handler receives `mcpReq` (request id/method/signal)
 * merged into its args; the remote server validates `arguments` against the
 * prompt's declared arguments and rejects it.
 */
function stripInjected(args: unknown): Record<string, unknown> {
  if (args === null || typeof args !== "object") return {};
  const { mcpReq: _context, ...rest } = args as Record<string, unknown>;
  return rest;
}

/** Build a JSON Schema object from MCP prompt argument descriptors. */
function promptArgsSchema(args: Array<{ name: string; description?: string; required?: boolean }>): {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
} {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const arg of args) {
    properties[arg.name] = {
      type: "string",
      ...(arg.description !== undefined ? { description: arg.description } : {}),
    };
    if (arg.required === true) required.push(arg.name);
  }
  return { type: "object", properties, ...(required.length > 0 ? { required } : {}) };
}

/** Connect a stdio MCP server to a remote bai `/mcp`, and stay until closed. */
export async function runStdioBridge(opts: StdioBridgeOptions): Promise<void> {
  const remote = new Client({ name: "bai-mcp-bridge", version: opts.version.length > 0 ? opts.version : "0.0.0" });
  const requestInit =
    opts.token !== undefined && opts.token.length > 0 ? { headers: { Authorization: `Bearer ${opts.token}` } } : undefined;
  await remote.connect(new StreamableHTTPClientTransport(new URL(opts.url), requestInit !== undefined ? { requestInit } : {}));

  const handle = serveStdio(() => createProxyServer(remote, opts.version), {
    onerror: (error) => console.error(`[bai mcp] ${error.message}`),
  });

  await new Promise<void>((resolve) => {
    const done = () => resolve();
    process.stdin.once("end", done);
    process.stdin.once("close", done);
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
  });

  await handle.close().catch(() => undefined);
  await remote.close().catch(() => undefined);
}
