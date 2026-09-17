import { McpServer, type McpServerFactory } from "@modelcontextprotocol/server";
import type { SessionId } from "@bai/shared";
import { registerToolCatalog } from "./catalog";
import type { McpServerDeps } from "./deps";
import { SharedSession, registerSessionTools } from "./sessions";
import { registerSkills } from "./skills";

/**
 * The bai MCP server factory. One instance owns the process-level shared
 * session; `factory()` is handed to `createMcpHandler` (stateless HTTP — a
 * fresh `McpServer` per request) and to the stdio bridge.
 */
export class McpServerService {
  private readonly shared: SharedSession;

  constructor(private readonly deps: McpServerDeps) {
    this.shared = new SharedSession(deps);
  }

  /** A factory that builds a fully-registered MCP server for one serving unit. */
  factory(): McpServerFactory {
    return () => this.createServer();
  }

  createServer(): McpServer {
    const server = new McpServer({
      name: "bai",
      version: this.deps.version.length > 0 ? this.deps.version : "0.0.0",
    });
    registerToolCatalog(server, this.deps, () => this.shared.get());
    registerSkills(server, this.deps);
    registerSessionTools(server, this.deps, this.shared);
    return server;
  }

  /** The shared session external tool calls run under (created on demand). */
  sharedSession(): Promise<SessionId> {
    return this.shared.get();
  }
}
