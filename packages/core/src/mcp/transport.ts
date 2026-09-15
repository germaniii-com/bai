import {
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  type OAuthClientProvider,
  type Transport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import type { MCPServerConfig, McpTransport } from "@bai/shared";

/** Resolve a server's transport kind (explicit, or inferred from its fields). */
export function transportKind(config: MCPServerConfig): McpTransport {
  if (config.transport === "stdio" || config.transport === "http" || config.transport === "sse") {
    return config.transport;
  }
  return config.url !== undefined ? "http" : "stdio";
}

export function createClient(version: string, name = "bai"): Client {
  return new Client({ name, version: version.length > 0 ? version : "0.0.0" });
}

/**
 * stdio transport: spawn the command with a SAFE baseline environment (the
 * SDK's default-inherited allowlist) merged with the server's configured env —
 * never the full `process.env`, so a third-party server cannot read unrelated
 * secrets.
 */
export function buildStdioTransport(config: MCPServerConfig): StdioClientTransport {
  if (config.command === undefined || config.command.length === 0) {
    throw new Error("stdio MCP server requires a command");
  }
  return new StdioClientTransport({
    command: config.command,
    args: config.args ?? [],
    env: { ...getDefaultEnvironment(), ...(config.env ?? {}) },
    ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
    stderr: "pipe",
  });
}

/** Streamable HTTP transport (primary), with an optional OAuth provider. */
export function buildHttpTransport(config: MCPServerConfig, authProvider?: OAuthClientProvider): StreamableHTTPClientTransport {
  if (config.url === undefined) throw new Error("http MCP server requires a url");
  return new StreamableHTTPClientTransport(new URL(config.url), {
    ...(Object.keys(config.headers ?? {}).length > 0 ? { requestInit: { headers: config.headers } } : {}),
    ...(authProvider !== undefined ? { authProvider } : {}),
  });
}

/** Legacy SSE transport (fallback for SSE-only servers). */
export function buildSseTransport(config: MCPServerConfig, authProvider?: OAuthClientProvider): SSEClientTransport {
  if (config.url === undefined) throw new Error("http MCP server requires a url");
  return new SSEClientTransport(new URL(config.url), {
    ...(Object.keys(config.headers ?? {}).length > 0 ? { requestInit: { headers: config.headers } } : {}),
    ...(authProvider !== undefined ? { authProvider } : {}),
  });
}

export type BuiltTransport = { transport: Transport; kind: "stdio" | "http" | "sse" };
