# bai-ts — Architecture

> **One runtime. Every surface. Every modality.**

`bai` is a single-executable AI workspace: chat, a coding agent, and
image/video workbenches, reachable from a terminal TUI, any browser (desktop
or mobile), and later a native desktop shell. Start a session in the terminal,
continue it from your phone, configure it from either channel.

This is the **TypeScript implementation** of the bai design (sibling of the Go
`bai/` repository; same architecture, same roadmap). It runs on **Bun**, uses
**Hono** for the API, **React Ink** for the TUI, and **React + Vite** for web.

- **Status:** scaffold phase (docs + config). Implementation follows the
  phased roadmap in §16.
- **Packages:** npm scope `@bai/*` under `src/packages/`.
- **Companion docs:** [README.md](README.md) and one README per package under
  `src/packages/`.

---

## 1. Product shape

| Invocation                    | Mode                     | What happens                                                                                     |
| ----------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------ |
| `bai`                         | TUI (default)            | Boots the core server in-process, attaches the Ink UI                                            |
| `bai --code`                  | TUI (explicit alias)     | Same as bare invocation                                                                          |
| `bai --web`                   | Server + browser         | Serves API + built web UI on loopback, prints URL + pairing QR; `--open` launches the browser    |
| `bai --host[=addr]`           | Server for other devices | Same server bound beyond loopback (LAN / tailnet) for phone/tablet access                        |
| `bai --one-shot "prompt"`     | Headless                 | Admits prompt to a session, streams NDJSON events to stdout, exits when the run goes idle        |
| `bai --attach URL` _(future)_ | Remote client            | Any surface pointed at an already-running bai server                                             |

Shared flags: `--port`, `--token`, `--config`, `--continue`, `--session ID`,
`--auto`, `--format json|text`, `--dev`, `--version`.
Mode flags are mutually exclusive; bare = TUI.

**The core idea:** there is exactly _one_ stateful component — the **core
server**. TUI, web app, mobile browser, one-shot CLI, and the future desktop
shell are all thin clients of the same HTTP + SSE API. This is what makes
"start in terminal, continue on web" a property of the architecture rather
than a feature bolted on later.

## 2. Design principles

1. **Server-first, thin surfaces.** All state lives behind the API. No surface
   owns truth. (Proven in production by opencode — itself TypeScript: even its
   local TUI talks to an in-process server.)
2. **One executable, zero native deps (core).** `bun:sqlite` is built into the
   runtime; Bun's native PTY (`Bun.spawn({ terminal })`) covers shell tools;
   `bun build --compile` cross-compiles to all major targets. No node-gyp
   anywhere on the critical path.
3. **Event-sourced sessions.** Every session state change is a durable event
   row with a monotonic sequence number. Continuity across devices falls out
   of replay-from-cursor.
4. **Fail-closed permissions.** Default action is _ask_. Headless runs
   auto-reject unless explicitly overridden (`--auto`). Interactive permission
   requests broadcast to every connected client; first reply wins.
5. **MCP-first extensibility.** bai consumes external MCP servers (plugins)
   and exposes its own tools as an MCP server. One protocol, any language.
6. **Four modalities structured day one.** Chat and code are real in v1;
   image/video ship as structured stubs — job queue, asset store, gallery
   routes, workbench interfaces all exist from the first release.
7. **Boring, current tech.** Bun + Hono + Ink + Vite + SQLite. Thin interfaces
   over official vendor SDKs; no agent frameworks.
8. **Local-first, single-user.** Your machine, your keys, your data. Remote
   access is a pairing token away, not an account system.

## 3. System overview

```
                       ┌────────────────────────── one process ──────────────────────────┐
                       │                                                                 │
 terminal ─────────► TUI ──── client ───┐                                               │
                       │                ▼                                               │
 browser ────────► Web SPA ◄── serves ─┤  ┌─────────────── api (Hono) ───────────┐      │
                       │  (Vite build) └──┤  REST /api/*      SSE /api/event     │      │
                       │                    │  durable stream          (live)      │      │
 one-shot ───────► client ────────────────►│  /api/session/:id/event?after=N     │      │
                       │                    │            │                        │      │
 MCP clients ─────────────────────────────►│  /mcp  (streamable HTTP, stateless) │      │
                       │                    └──────┬───────────────┬──────────────┘      │
                       │                           ▼               ▼                     │
                       │                    ┌── core ──┐    ┌── mcp manager ──┐         │
                       │                    │ sessions │    │ external plugin │◄─ config│
                       │                    │ runs     │    │ servers (stdio/ │         │
                       │                    │ tools    │◄───┤ http) as tools  │         │
                       │                    │ perms    │    └─────────────────┘         │
                       │                    └──┬───────┘                                │
                       │          ┌────────────┼───────────────┐                        │
                       │          ▼            ▼               ▼                        │
                       │     provider      workbenches       event bus                   │
                       │  (openai/anthropic/ chat · code ·    + durable log               │
                       │   gemini/compat)   image · video        │                       │
                       │                                         ▼                       │
                       │                                    store (bun:sqlite)           │
                       └─────────────────────────────────────────────────────────────────┘
```

## 4. Boot sequence (every mode)

1. Parse flags → resolve mode (`@bai/cli`).
2. Load config layers (§12).
3. Open store (`bun:sqlite`), run migrations.
4. Construct core: tool registry, permission engine, run coordinator,
   workbench registration (chat, code, image, video), MCP manager.
5. Build the Hono app (`@bai/api`) with the built web assets mounted.
6. Choose transport for the surface:
   - **TUI / one-shot:** start an ephemeral loopback listener
     (`127.0.0.1:0`) inside the same process and point the api client at it.
     Uniform code path, no special in-process casing.
   - **web/host:** listen on the configured address, print URL + QR, serve.
7. Run the surface until done; graceful shutdown drains runs and closes the
   DB (`server.stop()` drains in-flight requests; a timeout fallback forces
   exit — see caveats in §15).

## 5. Repository layout & dependency rules

Bun workspaces monorepo; composition root in `@bai/cli`; everything else under
`src/packages/`. The Go sketch (`packages/{cli,web,core,api,shared,tui,desktop}`)
is realized literally:

| Package       | Path                 | Notes                                                            |
| ------------- | -------------------- | ---------------------------------------------------------------- |
| `shared`      | `src/packages/shared`  | Domain types, IDs, contracts. Imports nothing.                 |
| `core`        | `src/packages/core`    | Sessions, runs, tools, permissions + supporting submodules     |
| `api`         | `src/packages/api`     | Typed HTTP boundary, both sides (Hono app + typed client)      |
| `cli`         | `src/packages/cli`     | Flags, wiring, mode dispatch (composition root)                |
| `tui`         | `src/packages/tui`     | Ink surface                                                    |
| `web`         | `src/packages/web`     | React SPA source; built `dist/` served by api                  |
| `desktop`     | `src/packages/desktop` | Stub until Phase 6                                             |

Supporting modules live as submodules inside `core/src/`:

```
core/src/
├── store/        bun:sqlite persistence + migrations
├── event/        live bus + durable seq-cursor log
├── config/       layered configuration
├── provider/     LLM providers behind one interface
├── mcp/          MCP client manager (+ server exposure wiring used by api)
└── workbench/    modality registry
    ├── chat/
    ├── code/
    ├── image/
    └── video/
```

```
cli ─► {config, store, event, provider, mcp, core, api, tui}
                          │
        core ◄────────────┼────────────── workbench/{chat,code,image,video}
        │  │              │                     (implement core contracts)
        │  └─► provider, mcp, event, store, shared
        └───► shared
api(server) ─► {core, event}            (never tui/web)
api(client) ─► shared                   (typed API consumer)
tui         ─► {api(client), shared}    (never core directly)
web         ─► {api(client), shared}    (never core directly)
shared      ─► (nothing)
```

**Rules:**

- Dependencies point downward only; no cycles. `shared` is the leaf.
- Only `cli` knows concrete constructors; packages receive interfaces.
- `tui` and the web SPA consume the API exclusively — they must keep working
  against a remote `--host` server unchanged.
- Internal packages publish their **TypeScript sources** via `"exports"`:
  Bun executes TS directly, tsc typechecks across packages through the import
  graph, and Vite resolves linked workspace TS entries natively. No build
  step between internal packages.
- tsconfigs are per-package (extending the root base) because Bun does not
  support TypeScript project references.

## 6. Domain model

| Concept               | Meaning                                                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Session**           | A named conversation scoped to a workbench (`chat`, `code`, …). Durable. Has an inbox, message history, and an event log.                              |
| **Message**           | One turn participant entry (`user`, `assistant`, `system`). Composed of ordered **Parts** (text, file ref, image ref, tool call, tool result).         |
| **Input / admission** | A submitted prompt is first persisted as an inbox row (durable), then _promoted_ into history when the runner picks it up. Crash-safe by construction. |
| **Run (drain)**       | One process-local execution span: promote eligible inputs → loop provider turns + tool calls until idle. Never two concurrent runs per session.        |
| **Steer vs queue**    | A prompt arriving mid-run _steers_ (promotes at the next safe boundary); one marked `queue` waits until idle.                                          |
| **Tool**              | A callable unit (builtin, workbench-provided, or MCP-provided). Registry merges all; namespaced (`fs.read`, `mcp/myserver/search`).                    |
| **Permission**        | Gate evaluated per tool call: rule match → `allow` / `ask` / `deny`. Unmatched defaults to `ask`.                                                      |
| **Event**             | Typed fact. Two flavors: **live** (firehose SSE, best-effort) and **durable** (per-session log rows, replayable by seq cursor).                        |
| **Job**               | Long-running async unit of work (image generation, video generation). Queued, progress-reported, produces **Assets**.                                  |
| **Asset**             | Generated media artifact (image/video/audio/file) stored on disk, indexed in SQLite, surfaced in galleries.                                            |
| **Workbench**         | A modality module registering tools, job types, asset kinds, and HTTP routes. The extension seam for new modalities.                                   |
| **Pairing**           | Trust-on-first-use token flow granting a device access to a running server.                                                                            |

All of these are plain TypeScript types/interfaces in `@bai/shared` — imported
directly by every surface. There are no generated or hand-maintained mirrors.

## 7. Persistence

SQLite (WAL mode) at `~/.local/share/bai/bai.db` via **`bun:sqlite`** —
synchronous, better-sqlite3-style API bundled with the runtime. Single-writer
discipline: one connection, explicit transactions, `busy_timeout`.

```ts
import { Database } from "bun:sqlite";

const db = new Database(path, { create: true });
db.run("PRAGMA journal_mode = WAL;");
db.run("PRAGMA busy_timeout = 5000;");
db.run("PRAGMA foreign_keys = ON;");
```

macOS note: Apple's system libsqlite3 keeps `-wal`/`-shm` sidecars after
close; cleanup with `SQLITE_FCNTL_PERSIST_WAL = 0` +
`PRAGMA wal_checkpoint(TRUNCATE)` before exit.

Schema (identical to the Go design):

```
sessions(id PK, title, workbench, cwd, created_at, updated_at, meta JSON)
messages(id PK, session_id FK, role, created_at)
parts(id PK, message_id FK, ord, kind, payload JSON)         -- text|file|image|tool_call|tool_result
inputs(id PK, session_id FK, payload JSON, state, created_at) -- admitted|promoted|cancelled
events(aggregate_id, seq, type, payload JSON, created_at,
       PRIMARY KEY(aggregate_id, seq))                        -- durable per-session log
permissions(id PK, session_id FK, tool, args_digest, status, rule, created_at)
jobs(id PK, kind, session_id NULL, status, input JSON, output JSON, error, created_at, updated_at)
assets(id PK, kind, mime, path, bytes, meta JSON, job_id NULL, created_at)
kv(key PK, value JSON)                                        -- misc runtime state
```

Media files live under `~/.local/share/bai/assets/<kind>/<id>.<ext>`; the DB
holds metadata only. Numbered forward-only SQL migrations recorded in a meta
table. All timestamps UTC RFC3339. Queries stay explicit — no ORM.

## 8. Events & sync — the continuity mechanism

**Envelope** (both live and durable):

```json
{ "seq": 42, "type": "message.part.delta", "ts": "2026-08-27T09:00:00Z",
  "session_id": "ses_01J...", "payload": { ... } }
```

Event types (initial set): `session.created|updated`, `input.admitted`,
`message.created`, `message.part.updated`, `message.part.delta`,
`run.started|finished`, `permission.asked|replied`, `job.updated`,
`asset.created`, `config.updated`, `server.hello`.

**Client sync algorithm** (identical shape in TUI and web):

1. On connect: REST bootstrap snapshot (sessions list, config, providers, open
   permissions/jobs for active views).
2. Subscribe to global firehose `/api/event`; apply events through a pure
   reducer per entity kind.
3. For an opened session: subscribe `/api/session/:id/event?after=<lastSeq>`;
   server replays durable rows after the cursor, then streams live. Gaps are
   impossible — the DB is the buffer.
4. On firehose disconnect: reconnect with backoff; the server's first frame is
   `server.hello`, which triggers a snapshot refresh (universal healing).
5. Streaming text arrives as `message.part.delta` appends; coalesce adjacent
   deltas before render.

**Multi-device, same session:** both devices hold cursors; both receive
`permission.asked`; **first reply wins**, the reply broadcasts
`permission.replied`, and every surface clears the prompt. Runs are serialized
per session by the coordinator, so two devices prompting the same session just
enqueue durable inputs — no merge conflicts exist anywhere in the design.

Transport notes: Hono's `streamSSE` powers both endpoints (flush per event,
heartbeat ~15 s, clean abort handling). Clients consume streams with
`fetch()` + `eventsource-parser` — identical code in browser and Bun, which
also sidesteps the fact that Hono's typed RPC client has no native SSE support
(bearer-token auth rules out native `EventSource` anyway).

## 9. Agent execution

```
submit(prompt) ──► inputs row (durable) ──► wake coordinator
coordinator(session): if idle → start drain:
   promote input(s) → append user message
   loop:
     render request (history + system context + tool defs)
     stream provider turn → emit deltas as events
     for each tool call: check permission → execute → append result part
   until: no continuation, or interrupted
interrupt: AbortController cancels the drain; admitted-but-unpromoted inputs stay queued
```

- **One drain per session** (process-global `Map` keyed by session ID);
  different sessions run concurrently. Joins/coalesces wakes.
- **Tool registry** merges builtin + workbench + MCP tools; enforces output
  size limits (truncate head+tail, spill full output to a managed temp file).
- **Permissions:** rules `{ "<tool-pattern>": "allow|ask|deny" }`,
  last-match-wins, sources merged: defaults < global config < project config <
  session-scoped approvals ("always"). Headless (`--one-shot`) auto-rejects
  unless `--auto` (replies approve-once). Interactive asks broadcast to all
  surfaces; first reply wins; `always` persists for the session.

## 10. Providers & models

Thin layer over official SDKs — no framework:

```ts
interface Provider {
  name(): string;
  models(): Promise<ModelInfo[]>;
  stream(req: Request): Promise<Stream>; // Request: messages, tools, params
}

interface Stream extends AsyncIterable<StreamEvent> {
  close(): Promise<void>; // StreamEvent: text_delta | tool_call_delta | usage | done
}
```

Adapters: `openai` (v7), `@anthropic-ai/sdk`, `@google/genai`, plus one
**OpenAI-compatible catch-all adapter** (custom base URL) covering OpenRouter,
Groq, Ollama, llama.cpp, LM Studio, etc. Vendor types stay isolated inside
adapter files so SDK majors never leak into `core`.

Model catalog = models.dev (via `@opencode-ai/models`: live fetch ⊕ bundled
offline snapshot ≤24 h behind) ⊕ user config overrides. Auth via env vars and
config; OAuth flows deferred.

## 11. Extensibility (MCP-first)

**bai as MCP client** (`core/src/mcp` manager): config declares external
servers; stdio (spawned subprocess) or streamable HTTP. Their tools merge into
the registry namespaced as `mcp/<server>/<tool>`. Official SDK:
`@modelcontextprotocol/client` **v2** (protocol rev **2026-07-28**).

**bai as MCP server**: exposes built-in tools and basic session operations at
`/mcp` (streamable HTTP, stateless mode — the v2 default), mounted through the
SDK's official **Hono adapter** (`createMcpHandler`) and guarded by the same
bearer token — so external agents can drive bai. Tool schemas use Standard
Schema (Zod v4), matching the rest of the validation stack.

**Later hooks** (config-declared commands/webhooks at lifecycle points:
`run.started`, `tool.execute.before/after`, `permission.asked`) — deliberately
deferred until real need appears; MCP covers the important cases first.

## 12. Configuration

Layered document, deep-merged, later layers win:

| Layer       | Location                                | Edited by           |
| ----------- | --------------------------------------- | ------------------- |
| Defaults    | compiled                                | —                   |
| Global      | `~/.config/bai/config.json`             | CLI or web settings |
| Project     | `.bai/config.json` (walked up from cwd) | files / CLI         |
| Environment | `BAI_*` vars                            | shell               |
| Flags       | CLI args                                | invocations         |

Effective config is exposed via `GET /api/config`; mutations go through
`PUT /api/config` and write back to the owning layer file (v1 simplification:
web edits target the global layer; project layers are file-managed). Atomic
writes (temp file + rename); last-known-good fallback on parse errors; jsonc
tolerated on read for hand-edited files. `config.updated` events notify every
connected surface, so changing a setting on the phone updates the TUI
instantly. The zod schema doubles as published JSON Schema for editor
completion.

Example:

```json
{
  "providers": { "openrouter": { "base_url": "https://openrouter.ai/api/v1" } },
  "models": { "default": "anthropic/claude-sonnet-4-5" },
  "permissions": { "bash.*": "ask", "fs.read": "allow" },
  "mcp": { "fetch": { "command": "uvx", "args": ["mcp-server-fetch"] } },
  "workbenches": { "image": { "adapter": "fal", "model": "flux-2" } }
}
```

## 13. Surfaces

### 13.1 TUI (`@bai/tui`, Ink 7)

React rendered to the terminal with **Ink 7.1** (React 19.2 reconciler;
maintained by Sindre Sorhus; powers Claude Code, Gemini CLI, Copilot CLI).
Runs under Bun directly — no build step.

- Root component + view-state enum (`chat`, `sessions`, `gallery`, `jobs`,
  `settings`) + focus-state routing; components are sub-components; overlay
  dialogs intercept keys before global bindings.
- `render(<App/>, { alternateScreen: true })` — full-screen alt-buffer like
  vim/less, restored on exit (supported since Ink v7).
- Key handling via `useInput` (+ `usePaste` for bracketed paste); focus via
  `useFocus`/`useFocusManager`.
- Markdown: parse with `marked`, map blocks to Ink components, highlight
  fenced code with `cli-highlight` (the Claude Code pattern). Diffs: `diff`
  (jsdiff) structured patches → colored `<Text>` lines.
- All data flows through `@bai/api`'s client against the in-process loopback
  server started by the same binary (works unchanged against remote servers).
- Applies event streams with reducers mirroring the web app's semantics.
- Permission asks arrive as events → modal dialog → reply via client; any
  other paired device may win the race (first-reply-wins) — handle gracefully.

Testing: reducer unit tests under `bun:test`; real-terminal integration smoke
tests spawn the TUI via `Bun.spawn` (native PTY). (`ink-testing-library` is
stale at Ink 5 and deliberately not load-bearing.)

### 13.2 Web / PWA (`@bai/web`, served by `@bai/api`)

React 19.2 + Vite 8 (Rolldown bundler) + `@vitejs/plugin-react` (Oxc-based) +
TypeScript. React Compiler enabled from day one. Serves desktop browsers
_and_ phones (PWA via `vite-plugin-pwa`) from the same bundle.

- Views: sessions sidebar, chat, code (file tree + diffs), image gallery,
  video gallery, jobs queue, settings (config editor), pairing screen.
- Sync engine mirroring the TUI's semantics (§8).
- State: small stores + reducers over events (no heavyweight state library
  unless Phase 1 proves the need).
- Styling: utility-first CSS; responsive-first layouts (phone is a primary
  target, not an afterthought).

Serving contract (owned by `@bai/api`):

- Static hosting of `@bai/web/dist` with SPA fallback: real file → serve;
  otherwise rewrite to `/` for the client router; `/api/*` and `/mcp` never
  fall through.
- `hasAssets()` guard: friendly "run the web build" hint page instead of a
  blank 404 when dist is missing.
- Cache headers: immutable for hashed `/assets/*`, `no-cache` for index.html.
- Dev mode: Vite dev server proxies `/api` + `/mcp` to a running bai
  (see `src/packages/web/vite.config.ts`); alternatively the server proxies
  non-API routes to Vite HMR when `BAI_DEV_URL` is set.

### 13.3 Desktop (`@bai/desktop` — stub, Phase 6)

Deliberately unimplemented. Candidates: **Tauri v2** (lightweight Rust shell
wrapping the same web bundle) or **Electron** (opencode precedent: desktop
forks the server as a sidecar). Either way the shell renders the same SPA and
spawns/reuses the same core server (discovery via `~/.local/state/bai/server.json`).
Kept out of v1; the web app covers desktop use meanwhile.

## 14. Security & networking

- Binds `127.0.0.1:<port>` by default (preferred port **9640**, else ephemeral).
- Every non-loopback request requires `Authorization: Bearer <token>`
  (Hono bearer-auth middleware; loopback requests bypass only when the
  listener is loopback-bound).
- First run generates a token (`~/.local/state/bai/server.json` records
  `{url, pid, token}` for local reuse/discovery).
- Pairing: `--host` prints URL + QR encoding `http://<lan-ip>:9640/#pair=<token>`;
  the web app stores it and uses it as bearer. Revocation = regenerate token.
- Off-LAN access recommended via Tailscale/WireGuard; no built-in TLS in v1
  (terminate at a tunnel or reverse proxy if exposing publicly).
- Single-user model: no accounts, no multi-tenancy. This is deliberate scope.

## 15. Build, release, dev workflow

```sh
bun install                      # workspace install (hoisted)
bun run dev -- --filter @bai/cli # bun --hot server dev (fetch handler hot-reload)
bun run dev -- --filter @bai/web # vite dev server on :5173, proxying /api + /mcp
bun test                         # bun:test across workspaces (--parallel ready)
bun run typecheck                # tsc --noEmit per package
bun run compile                  # bun build --compile → dist/bai single executable
```

Release matrix via `bun build --compile` targets:
`bun-linux-x64|arm64[-musl]`, `bun-windows-x64|arm64`, `bun-darwin-x64|arm64`.
The SPA is embedded automatically (full-stack executables). Expected binary
size ~60–85 MB (Bun runtime included) vs the Go design's <40 MB target — an
accepted trade-off documented in the decision log. Workers must be listed as
explicit compile entrypoints if ever introduced.

Graceful shutdown: drain in-flight runs → `server.stop(true, timeout)` →
checkpoint WAL → close DB → exit. A hard timeout guards against the known
Bun issue where `stop()` can hang after server-initiated WebSocket closes.

## 16. Roadmap

| Phase                     | Deliverable                                                                                                                | Success criteria                                                           |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **0 — Skeleton**          | workspaces, mode dispatch, config layers, store+migrations, hello-world API, web shell, TUI shell, compile pipeline        | `bai` opens TUI; `bai --web` serves SPA; `bai --one-shot hi` prints NDJSON |
| **1 — Chat**              | Provider layer (OpenAI-compat + Anthropic first), streaming, sessions/messages end-to-end, web chat + TUI chat             | Same conversation visible & continuable from TUI and phone browser         |
| **2 — Sync hardening**    | Durable event log + cursor resume, pairing QR, config editing from web, `config.updated` propagation                       | Kill/resume mid-stream loses nothing; phone pairs in <30 s                 |
| **3 — Code workbench**    | fs/grep/bash/edit tools (PTY via `Bun.spawn`), permission engine, diff viewer, workspace rooting                           | Guided multi-file edit with approvals from either surface                  |
| **4 — MCP dual role**     | Client manager + server exposure (v2 SDK, Hono adapter), namespaced tool merge                                             | External MCP tools callable in sessions; external agent can drive bai      |
| **5 — Media workbenches** | Real image adapters (fal.ai first), job queue UX, galleries; video adapter after                                           | Prompt→job→asset→gallery round trip on phone                               |
| **6 — Desktop**           | Native shell reusing SPA + core (tech decided then)                                                                        | Feature parity with web                                                    |

## 17. Decision log

Carried over from the Go design where still applicable (D1–D12), plus
TypeScript-specific decisions (D13+):

| #   | Decision                                        | Rationale                                                                     | Alternatives rejected                        |
| --- | ----------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------- |
| D1  | Server-first core, thin surfaces                | Continuity across devices becomes structural                                  | Fat clients syncing P2P                      |
| D2  | Single Bun workspace + `src/packages/*`         | User-mandated layout; simplest builds; hoisted installs                       | Turborepo/Nx (no need yet), nested src dirs  |
| D3  | Ink 7 TUI                                       | React model, alternate-screen support, Claude Code/Gemini CLI pedigree        | OpenTUI/SolidJS (younger ecosystem), Textual |
| D4  | `bun:sqlite`                                    | Built-in, sync API, WAL, zero native deps                                     | better-sqlite3 (node-gyp), drizzle ORM layer |
| D5  | MCP-only extensibility in v1                    | Industry standard; official TS SDK v2 w/ Hono adapter                         | Plugin hook DSL first                        |
| D6  | Durable per-session event log w/ seq cursor     | Guaranteed resume; opencode-proven                                            | Firehose-only + refetch                      |
| D7  | Fail-closed headless permissions                | Safety default; explicit `--auto` escape hatch                                | Auto-allow by default                        |
| D8  | Loopback listener even for local TUI            | One uniform client code path                                                  | In-process handler special-casing            |
| D9  | Image/video as structured stubs day one         | Architecture proven before adapters land                                      | Defer entirely / big-bang media              |
| D10 | Desktop deferred                                | Web covers desktop; tech undecided (Tauri vs Electron)                        | Early Electron/Tauri adoption                |
| D11 | Hono (not Express/Elysia)                       | Web-standard handlers, typed RPC client, SSE helpers, Bun-native serving      | Express (legacy), Elysia (less portable)     |
| D12 | Single-user pairing-token auth                  | Matches "just me, many devices"                                               | Accounts/OAuth/multi-user                    |
| D13 | Bun as runtime AND bundler                      | TS execution without build step; workspaces; compile-to-exe; native PTY/sqlite| Node + esbuild/tsup split toolchain          |
| D14 | Internal packages export TS sources             | Zero inter-package build artifacts; Bun/tsc/Vite all resolve it               | Per-package dist builds + dts                |
| D15 | Shared types imported directly by surfaces      | Kills the mirror-types problem entirely                                       | OpenAPI codegen, hand-maintained mirrors     |
| D16 | `hc<AppType>` typed REST + hand-rolled SSE parse| Typed calls for free; SSE stays simple fetch+parser in both clients           | tRPC (different transport model)             |
| D17 | Thin Provider interface over official SDKs      | Day-one vendor features; tiny surface; avoids AI SDK major churn              | Vercel AI SDK as the abstraction             |
| D18 | models.dev catalog w/ offline snapshot          | Free curated metadata; local-first fallback                                   | Hand-maintained catalog only                 |
| D19 | bun:test as sole runner                         | Jest-compatible, parallel, zero config                                        | vitest/jest double stack                     |
| D20 | Per-package tsconfigs, no project references    | Bun does not support references (#4774)                                       | TS project references                        |

## 18. Glossary

See §6 for domain terms. **Surface** = a UI (TUI/web/desktop/CLI). **Mode** =
an invocation style choosing which surface(s) run. **Cursor** = opaque last-seen
event sequence number used for durable replay. **Pairing** = token exchange
granting a device API access. **Workbench** = registered modality module.
