# @bai/cli

The composition root and entrypoint wiring. Deliberately thin: parse flags,
resolve the mode, construct everything, hand off to the chosen surface. This
is the **only** package that knows concrete constructors — everything else
receives interfaces.

## Responsibilities

- Flag parsing and mode dispatch (mutually exclusive mode flags; combining
  them is a usage error, exit 2).
- Boot sequence per mode: config layers → store open + migrations → core
  construction (tool registry, permission engine, run coordinator, workbench
  registration chat/code/image/video, MCP manager) → Hono app → transport.
- Transport choice:
  - **TUI / one-shot:** start an ephemeral loopback listener (`127.0.0.1:0`)
    in-process and point the api client at it — uniform code path, no special
    in-process casing.
  - **web/host:** listen on the configured address, print URL + pairing QR,
    serve.
- Graceful shutdown: drain runs → `server.stop(true, timeout)` → WAL
  checkpoint → close DB → exit (hard timeout guards the known Bun
  WS-close hang).
- Version stamping via `--define` build constants when compiling.

## Mode resolution

| Flags | Mode |
|---|---|
| *(bare)* / `--code` | TUI |
| `--web` | server + print URL/QR (`--open` launches browser) |
| `--host[=addr]` | server bound beyond loopback |
| `--router` | headless OpenAI-compatible gateway + `/api/help` (no web UI) |
| `mcp` | stdio MCP bridge to a **running** bai (`--url`/`--token`) |
| `--one-shot "prompt"` | headless run → NDJSON/text on stdout |

`--router` and `--mcp` are **modifiers**: they may accompany `--web`/`--host`
(`bai --web --router --mcp` = one process/one listener serving everything), or
`--router` stands alone. Neither combines with `--one-shot`. The gateway
(`/v1/*`) + `/api/help` are gated live by config `router.enabled` (Settings →
Model Providers → "Run as router"), **on by default**; the MCP server role
(`/mcp`) is gated by `mcpServer.enabled` (Settings → Integrations → "Run as MCP
server"), **off by default** because it runs bai's tools with auto-approve.
`bai --mcp` forces it on.

`bai mcp` is its own mode: a stdio MCP server that **proxies** a running bai's
`/mcp` for desktop clients (Claude Desktop, Cursor). It never boots the core —
a second core would double-run media jobs and automations. It finds the server
via `--url`/`$BAI_URL` or `~/.local/state/bai/server.json`, and because stdout
is the JSON-RPC channel, all diagnostics go to stderr.

Never run two bai core processes at once — boot reconciles shared
job/automation state.

Shared flags: `--port`, `--token`, `--url`, `--config`, `--continue`,
`--session`, `--auto`, `--format`, `--dev`, `--version`.

One-shot mechanics: subscribe to the session event stream **before**
submitting the prompt; terminate on idle; NDJSON envelope
`{type, timestamp, sessionId, …}`; stdin piping concatenated into the prompt;
exit 1 on errors.

## Non-goals

- Any business logic. If it's more than wiring, it belongs elsewhere.
- UI rendering (→ `@bai/tui`, `@bai/web`).

## Single executable

`bun run compile` (repo root) builds this package into a standalone binary
with the web bundle embedded:

```sh
bun build --compile packages/cli/src/index.ts --outfile dist/bai
# cross targets: --target=bun-linux-x64 | bun-darwin-arm64 | bun-windows-x64 | …
```

Workers (if ever introduced) must be listed as explicit compile entrypoints.

## Dependencies

Imports `@bai/api`, `@bai/core`, `@bai/mcp`, `@bai/provider`, `@bai/router`,
`@bai/shared`, `@bai/tui`. See
[ARCHITECTURE.md §4](../../docs/ARCHITECTURE.md#4-boot-sequence-every-mode) for the
boot sequence this package triggers.
