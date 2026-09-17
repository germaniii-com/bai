# @bai/mcp

bai **as** an MCP server. A separate workspace under `services/`, composed
**in-process** into the one bai server (like `@bai/router`) — never a second
stateful process. It exposes bai's tools, skills, and sessions to external MCP
clients over stateless **streamable HTTP** at `/mcp`, and ships the `bai mcp`
stdio bridge for desktop clients.

## What it exposes

- **Tools** — the whole registry (config `mcpServer.tools.include/exclude`),
  aliased to the MCP/LLM-safe charset: `fs.read` → `fs_read`,
  `mcp/<server>/<tool>` → `mcp__<server>__<tool>`. JSON Schemas are wrapped with
  `fromJsonSchema` (memoized). `question` is always hidden unless explicitly
  included (it waits on a human).
- **Skills** — one MCP **prompt** per skill (the `SKILL.md` body), plus
  **resources** `skill://<name>` and `skill://<name>/<file>` for its supporting
  files, plus a `skills_list` tool for clients without prompts/resources.
- **Sessions** — `session_create`, `session_prompt` (auditable: real transcript
  + revert), `session_history`, `session_list`.

Every interaction records one `mcp_events` row with `server: "(bai)"`
(best-effort), so the Analytics **MCP activity** card shows bai-as-server usage.

## Execution model

Direct tool calls go through `Service.executeToolCall` — the SAME
`ToolContext` + central permission gate as the run loop — against a lazily
created process-level **shared session** (`MCP (external)`) stamped
`meta.autoApprove`, so external calls run unattended. The shared session is
visible in the UI; use `session_prompt` for work that needs a transcript,
snapshot/revert, and per-session auditing. `task` children inherit
`autoApprove`, so spawned subagents never stall on an unanswerable ask.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/mcp` | JSON-RPC (streamable HTTP, stateless; `legacy: "stateless"` fallback for 2025-era clients) |
| `GET`/`DELETE` | `/mcp` | 405 (stateless v2 has no session ops) |

Also (in the main API): `GET /api/mcp/server-role` reads the Settings status
(enabled, exposed tool/skill/session counts).

**Auth:** loopback requests bypass; non-loopback requires
`Authorization: Bearer <token>` (a `?token=` fallback exists for clients that
cannot set headers). The SDK's Hono app adds DNS-rebinding (Host/Origin)
protection on loopback binds.

## Where it runs

Mounted in **every** mode via `ApiDeps.extraRoutes`, gated live by
`config.mcpServer.enabled`. **Default off** — the endpoint runs bai's tools
with auto-approve, so enabling is explicit: Settings → Integrations → "Run as
MCP server", or `bai --mcp` (which forces it on). Toggling applies without a
restart (a disabled server 404s as if uninstalled).

## `bai mcp` stdio bridge

Desktop clients (Claude Desktop, Cursor) only speak stdio. `bai mcp` runs a
local stdio MCP server that **proxies** a running bai's `/mcp` — it never boots
a core. It resolves the target from `--url`/`$BAI_URL`/`$BAI_TOKEN` or
`~/.local/state/bai/server.json` (written by `bai --web`/`--host`).

```jsonc
// Claude Desktop / Cursor
{ "mcpServers": { "bai": { "command": "bai", "args": ["mcp"] } } }
// or, for HTTP-capable clients
{ "mcpServers": { "bai": { "url": "http://127.0.0.1:9640/mcp" } } }
```

stdout is the JSON-RPC channel — the bridge logs to stderr only.

## Exports

- `createMcpServerApp(deps)` — the `/mcp` Hono app (gate + auth + handler).
- `McpServerService` — the server factory + shared session.
- `runStdioBridge(opts)` / `createProxyServer(remote, version)` — the bridge.
- `McpServerDeps` = `{ core, store, version, config, token?, loopbackBind, enabled?, onNotice? }`.

## Non-goals

- A second core/process (D29); the stdio bridge is a proxy.
- MCP OAuth resource-server flow for `/mcp` (single-user local-first; bearer).
- CORS for browser MCP clients; sampling/elicitation; SSE resumability.
- Transcript parts/snapshots for direct tool calls (use `session_prompt`).
