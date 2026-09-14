import { UnauthorizedError, type CallToolResult, type Prompt, type Resource, type Tool as McpTool, type Transport } from "@modelcontextprotocol/client";
import type { MCPServerConfig, McpServerInfo, McpServerState } from "@bai/shared";
import type { ToolContext, ToolRegistry, ToolResult } from "../tools/registry";
import { callResultToText, normalizeInputSchema, promptResultToText, qualifiedToolName, readResourceToText } from "./catalog";
import { buildHttpTransport, buildSseTransport, buildStdioTransport, createClient, transportKind } from "./transport";
import { McpAuthStore, createOAuthProvider } from "./auth";
import type { McpRegistry, ResolvedMcpServer } from "./registry";

const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

export interface McpManagerOptions {
  registry: McpRegistry;
  tools: ToolRegistry;
  version: string;
  /** Directory for OAuth token files (`~/.local/share/bai/mcp-tokens`). */
  tokensDir: string;
  /** Broadcast hook (the bus + firehose `mcp.updated`). */
  onChange?: () => void;
  connectTimeoutMs?: number;
}

interface ClientHandle {
  server: string;
  client: ReturnType<typeof createClient>;
  transport: Transport;
  config: MCPServerConfig;
  signature: string;
  tools: McpTool[];
}

interface ServerState {
  state: McpServerState;
  error?: string;
  toolCount: number;
}

/**
 * MCP client manager: reconciles the `McpRegistry` (files + config) against
 * live connections, registers each server's tools as `mcp/<server>/<tool>`,
 * and surfaces resources/prompts through helper tools. Connect failures are
 * isolated per server — one broken server never blocks the rest.
 */
export class McpManager {
  private readonly auth: McpAuthStore;
  private readonly handles = new Map<string, ClientHandle>();
  /** Transports left mid-OAuth (needed to finish the code exchange). */
  private readonly pendingAuth = new Map<string, Transport>();
  private readonly states = new Map<string, ServerState>();
  private reconciling: Promise<void> | undefined;

  constructor(private opts: McpManagerOptions) {
    this.auth = new McpAuthStore(opts.tokensDir);
  }

  async start(): Promise<void> {
    this.registerHelperTools();
    await this.reconcile();
  }

  /** Effective server list with live connection state (settings UI). */
  status(): McpServerInfo[] {
    return this.opts.registry.list().map((server) => {
      const s = this.states.get(server.name) ?? { state: "connecting" as const, toolCount: 0 };
      return {
        name: server.name,
        source: server.source,
        state: s.state,
        transport: transportKind(server.config),
        tools: s.toolCount,
        ...(s.error !== undefined ? { error: s.error } : {}),
        ...(server.path !== undefined ? { path: server.path } : {}),
      };
    });
  }

  /** Create or replace a drop-in server file, then reconnect. */
  async put(name: string, config: MCPServerConfig): Promise<void> {
    this.opts.registry.put(name, config);
    await this.reconcile();
  }

  /** Delete a drop-in server file (config.json-sourced servers cannot be removed here). */
  async remove(name: string): Promise<boolean> {
    const removed = this.opts.registry.remove(name);
    await this.reconcile();
    return removed;
  }

  /** Enable/disable a file-defined server by merging into its file. */
  async setEnabled(name: string, enabled: boolean): Promise<void> {
    const server = this.opts.registry.get(name);
    if (server === undefined) throw new Error(`Unknown MCP server: ${name}`);
    if (server.source !== "file") throw new Error(`"${name}" is config.json-defined; edit config directly`);
    await this.put(name, { ...server.config, enabled });
  }

  /** Re-run reconciliation (retries failed servers). */
  async reconnect(): Promise<void> {
    await this.reconcile();
  }

  /** Connect newly-added/changed servers, drop removed ones, re-register tools. */
  async reconcile(): Promise<void> {
    if (this.reconciling !== undefined) return this.reconciling;
    this.reconciling = this.doReconcile().finally(() => {
      this.reconciling = undefined;
    });
    return this.reconciling;
  }

  private async doReconcile(): Promise<void> {
    const desired = new Map(this.opts.registry.list().map((s) => [s.name, s]));

    for (const [name, handle] of [...this.handles]) {
      const want = desired.get(name);
      if (want === undefined || want.config.enabled === false || signature(want.config) !== handle.signature) {
        await this.disconnect(name);
      }
    }

    for (const server of desired.values()) {
      if (server.config.enabled === false) {
        this.states.set(server.name, { state: "disabled", toolCount: 0 });
        continue;
      }
      if (this.handles.has(server.name)) continue;
      await this.connect(server);
    }

    this.pruneToolStates();
    this.emit();
  }

  async stop(): Promise<void> {
    for (const name of [...this.handles.keys()]) await this.disconnect(name);
  }

  /** Begin an interactive OAuth flow; returns the authorization URL to open. */
  async startAuth(name: string): Promise<string> {    const server = this.opts.registry.get(name);
    if (server === undefined) throw new Error(`Unknown MCP server: ${name}`);
    await this.disconnect(name);
    await this.connect(server);
    const url = this.auth.read(name).authorizationUrl;
    if (url === undefined) throw new Error(`${name} did not start an OAuth flow (is oauth enabled?)`);
    return url;
  }

  /** Finish an OAuth flow with the pasted authorization code (or full callback URL). */
  async finishAuth(name: string, codeOrUrl: string): Promise<void> {
    const transport = this.pendingAuth.get(name);
    if (transport === undefined) throw new Error(`No pending OAuth flow for ${name}`);
    const finish = (transport as unknown as { finishAuth?: (params: URLSearchParams) => Promise<void> }).finishAuth;
    if (typeof finish !== "function") throw new Error(`${name} transport does not support OAuth`);
    const params =
      codeOrUrl.includes("?") || codeOrUrl.includes("code=")
        ? new URL(codeOrUrl, "http://localhost").searchParams
        : new URLSearchParams({ code: codeOrUrl });
    await finish.call(transport, params);
    this.pendingAuth.delete(name);
    await this.disconnect(name);
    const server = this.opts.registry.get(name);
    if (server !== undefined) await this.connect(server);
    this.emit();
  }

  // --- connections -------------------------------------------------------

  private async connect(server: ResolvedMcpServer): Promise<void> {
    const { name, config } = server;
    const kind = transportKind(config);
    this.states.set(name, { state: "connecting", toolCount: 0 });
    this.emit();
    const client = createClient(this.opts.version);
    const authProvider = config.oauth ? this.providerFor(name, config) : undefined;
    let activeTransport: Transport | undefined;
    try {
      let transport: Transport;
      if (kind === "stdio") {
        transport = buildStdioTransport(config);
        activeTransport = transport;
        await withTimeout(client.connect(transport), this.timeoutMs(config));
      } else {
        try {
          transport = buildHttpTransport(config, authProvider);
          activeTransport = transport;
          await withTimeout(client.connect(transport), this.timeoutMs(config));
        } catch (err) {
          if (err instanceof UnauthorizedError) throw err;
          transport = buildSseTransport(config, authProvider);
          activeTransport = transport;
          await withTimeout(client.connect(transport), this.timeoutMs(config));
        }
      }
      const tools = await this.listTools(client);
      const handle: ClientHandle = { server: name, client, transport, config, signature: signature(config), tools };
      this.handles.set(name, handle);
      this.states.set(name, { state: "connected", toolCount: tools.length });
      this.registerServerTools(handle);
      this.emit();
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        // Keep the transport so finishAuth can complete the code exchange.
        if (activeTransport !== undefined) this.pendingAuth.set(name, activeTransport);
        this.states.set(name, { state: "needs_auth", toolCount: 0, error: "authorization required" });
      } else {
        this.states.set(name, { state: "failed", toolCount: 0, error: message(err) });
      }
      this.emit();
    }
  }

  private async disconnect(name: string): Promise<void> {
    const handle = this.handles.get(name);
    this.unregisterServerTools(name);
    this.handles.delete(name);
    if (handle !== undefined) {
      try {
        await handle.client.close();
      } catch {
        // best-effort teardown
      }
    }
  }

  private async listTools(client: ReturnType<typeof createClient>): Promise<McpTool[]> {
    try {
      const result = await client.listTools();
      return result.tools ?? [];
    } catch {
      return [];
    }
  }

  private providerFor(name: string, config: MCPServerConfig) {
    const oauth = config.oauth;
    const options = typeof oauth === "object" ? oauth : {};
    return createOAuthProvider({
      server: name,
      store: this.auth,
      redirectUrl: "http://localhost:1455/callback",
      ...(options.clientId !== undefined ? { clientId: options.clientId } : {}),
      ...(options.clientSecret !== undefined ? { clientSecret: options.clientSecret } : {}),
      ...(options.scope !== undefined ? { scope: options.scope } : {}),
    });
  }

  private timeoutMs(config: MCPServerConfig): number {
    return config.timeout ?? this.opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  }

  // --- tool registration -------------------------------------------------

  private registerServerTools(handle: ClientHandle): void {
    const allow = handle.config.tools?.include;
    const deny = handle.config.tools?.exclude;
    for (const tool of handle.tools) {
      if (allow !== undefined && !allow.includes(tool.name)) continue;
      if (deny !== undefined && deny.includes(tool.name)) continue;
      const name = qualifiedToolName(handle.server, tool.name);
      const description = tool.description ?? `${tool.name} (via MCP server "${handle.server}")`;
      const server = handle.server;
      const toolName = tool.name;
      this.opts.tools.register({
        name,
        description,
        schema: normalizeInputSchema(tool.inputSchema),
        origin: `mcp/${server}`,
        execute: async (args: unknown, ctx: ToolContext): Promise<ToolResult> => {
          const current = this.handles.get(server);
          if (current === undefined) throw new Error(`MCP server "${server}" is not connected`);
          void ctx;
          const result = (await current.client.callTool({
            name: toolName,
            arguments: (args ?? {}) as Record<string, unknown>,
          })) as CallToolResult;
          const text = callResultToText(result);
          if (result.isError === true) throw new Error(text.length > 0 ? text : "MCP tool returned an error");
          return { content: text, meta: { title: `MCP ${server}/${toolName}`, server, tool: toolName } };
        },
      });
    }
  }

  private unregisterServerTools(server: string): void {
    const prefix = `mcp/${server}/`;
    for (const name of this.opts.tools.names()) {
      if (name.startsWith(prefix)) this.opts.tools.unregister(name);
    }
  }

  private pruneToolStates(): void {
    for (const name of [...this.states.keys()]) {
      if (this.opts.registry.get(name) === undefined) this.states.delete(name);
    }
  }

  /** Global helper tools for MCP resources and prompts (server argument optional). */
  private registerHelperTools(): void {
    const listFor = (args: unknown): string | undefined => {
      const a = (args ?? {}) as { server?: string };
      return a.server;
    };
    this.opts.tools.replace({
      name: "mcp/list_resources",
      description: "List resources exposed by connected MCP servers (optionally one server).",
      origin: "mcp",
      schema: { type: "object", properties: { server: { type: "string" } } },
      execute: async (args): Promise<ToolResult> => {
        const only = listFor(args);
        const lines: string[] = [];
        for (const [server, handle] of this.handles) {
          if (only !== undefined && only !== server) continue;
          const resources = await this.listResources(handle);
          for (const r of resources) lines.push(`${server}: ${r.uri}${r.name !== undefined ? ` — ${r.name}` : ""}`);
        }
        return { content: lines.length > 0 ? lines.join("\n") : "No MCP resources.", meta: { title: "MCP resources" } };
      },
    });
    this.opts.tools.replace({
      name: "mcp/read_resource",
      description: "Read one MCP resource by server and uri.",
      origin: "mcp",
      schema: { type: "object", properties: { server: { type: "string" }, uri: { type: "string" } }, required: ["server", "uri"] },
      execute: async (args): Promise<ToolResult> => {
        const { server, uri } = (args ?? {}) as { server?: string; uri?: string };
        if (server === undefined || uri === undefined) throw new Error("server and uri are required");
        const handle = this.handles.get(server);
        if (handle === undefined) throw new Error(`MCP server "${server}" is not connected`);
        const result = await handle.client.readResource({ uri });
        return { content: readResourceToText(result), meta: { title: `MCP ${server} resource ${uri}` } };
      },
    });
    this.opts.tools.replace({
      name: "mcp/list_prompts",
      description: "List prompts exposed by connected MCP servers (optionally one server).",
      origin: "mcp",
      schema: { type: "object", properties: { server: { type: "string" } } },
      execute: async (args): Promise<ToolResult> => {
        const only = listFor(args);
        const lines: string[] = [];
        for (const [server, handle] of this.handles) {
          if (only !== undefined && only !== server) continue;
          for (const p of await this.listPrompts(handle)) {
            lines.push(`${server}: ${p.name}${p.description !== undefined ? ` — ${p.description}` : ""}`);
          }
        }
        return { content: lines.length > 0 ? lines.join("\n") : "No MCP prompts.", meta: { title: "MCP prompts" } };
      },
    });
    this.opts.tools.replace({
      name: "mcp/get_prompt",
      description: "Fetch one MCP prompt by server and name, with optional arguments.",
      origin: "mcp",
      schema: {
        type: "object",
        properties: { server: { type: "string" }, name: { type: "string" }, arguments: { type: "object" } },
        required: ["server", "name"],
      },
      execute: async (args): Promise<ToolResult> => {
        const { server, name, arguments: promptArgs } = (args ?? {}) as {
          server?: string;
          name?: string;
          arguments?: Record<string, string>;
        };
        if (server === undefined || name === undefined) throw new Error("server and name are required");
        const handle = this.handles.get(server);
        if (handle === undefined) throw new Error(`MCP server "${server}" is not connected`);
        const result = await handle.client.getPrompt({
          name,
          ...(promptArgs !== undefined ? { arguments: promptArgs } : {}),
        });
        return { content: promptResultToText(result), meta: { title: `MCP ${server} prompt ${name}` } };
      },
    });
  }

  private async listResources(handle: ClientHandle): Promise<Resource[]> {
    try {
      return (await handle.client.listResources()).resources ?? [];
    } catch {
      return [];
    }
  }

  private async listPrompts(handle: ClientHandle): Promise<Prompt[]> {
    try {
      return (await handle.client.listPrompts()).prompts ?? [];
    } catch {
      return [];
    }
  }

  private emit(): void {
    this.opts.onChange?.();
  }
}

function signature(config: MCPServerConfig): string {
  return JSON.stringify(config);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`MCP connect timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
    timer.unref?.();
  });
}
