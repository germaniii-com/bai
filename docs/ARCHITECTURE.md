# bai-ts — Architecture

> **One runtime. Every surface. Every modality.**

`bai` is a single-executable AI workspace: chat, a coding agent, and
image/video workbenches, reachable from a terminal TUI, any browser (desktop
or mobile), and later a native desktop shell. Start a session in the terminal,
continue it from your phone, configure it from either channel.

This is the **TypeScript implementation** of the bai design (sibling of the Go
`bai/` repository; same architecture, same roadmap). It runs on **Bun**, uses
**Hono** for the API, **React Ink** for the TUI, and **React + Vite** for web.

- **Status:** implemented through the code-workbench phase (§16): chat,
  sync, agents (`build`/`plan`/`chat` built-ins + hot-reloaded files), file
  tools + bash/grep, interactive permissions (diff-rendered asks, reject
  feedback, TUI+web dialogs), question/todo/web tools, subagent spawning
  (`task` tool), token discipline + compaction, and per-message
  revert/fork/copy with shadow-repo file rollback ship today. MCP (§11),
  media adapters, and desktop are next.
- **Packages:** npm scope `@bai/*` under `packages/`.
- **Companion docs:** [README.md](README.md),
  [FEATURES.md](FEATURES.md) (what each workbench does today), and one README
  per package under `packages/`.

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
`packages/`. The Go sketch (`packages/{cli,web,core,api,shared,tui,desktop}`)
is realized literally:

| Package       | Path                 | Notes                                                            |
| ------------- | -------------------- | ---------------------------------------------------------------- |
| `shared`      | `packages/shared`  | Domain types, IDs, contracts. Imports nothing.                 |
| `core`        | `packages/core`    | Sessions, runs, tools, permissions + supporting submodules     |
| `api`         | `packages/api`     | Typed HTTP boundary, both sides (Hono app + typed client)      |
| `cli`         | `packages/cli`     | Flags, wiring, mode dispatch (composition root)                |
| `tui`         | `packages/tui`     | Ink surface                                                    |
| `web`         | `packages/web`     | React SPA source; built `dist/` served by api                  |
| `desktop`     | `packages/desktop` | Stub until Phase 6                                             |

Supporting modules live as submodules inside `core/src/`:

```
core/src/
├── store/        bun:sqlite persistence + migrations
├── event/        live bus + durable seq-cursor log
├── config/       layered configuration
├── provider/     LLM providers behind one interface
├── agent/        file-defined agents: scan, watch, hot-reload
├── tools/        tool registry, built-in fs tools, custom-tool loader
├── context/      token discipline (pruning/stubbing) + compaction
├── permissions/  rule engine + interactive gate
├── mcp/          MCP client manager (planned, Phase 4)
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

### 5.1 Code map — where the important things live

The guided tour for anyone reading the implementation. Paths are relative to
`packages/`.

| What | Where | Notes |
| --- | --- | --- |
| **The agentic loop** | `core/src/run.ts` → `RunCoordinator.drainOnce()` | One drain per session (`wake`/`startDrain`); per turn: history → compaction slice → token discipline → `renderOutbound` → `provider.stream` → tool calls → permission gate → execute → loop. `consumeStream` persists text/thinking/tool-call parts; `executeCalls` runs the gate + tools; `MAX_STEPS` (50) caps iterations; `stopReason === "length"` fails truncated tool calls. |
| **History → provider messages** | `core/src/run/history.ts` → `renderOutbound()` | Parts → neutral `ContentBlock[]`; tool results move to a synthetic following user message; dangling calls closed with error results. |
| **The LLM calls (HTTP)** | `core/src/provider/types.ts` (`Provider.stream`) + `core/src/provider/adapters/anthropic.ts`, `adapters/openai.ts` | The ONLY files that touch vendor SDKs / provider HTTP. Anthropic: `tool_use`/`tool_result` blocks, `input_json_delta` streaming, cache breakpoints (system / last tool / last message). OpenAI-compat serves api.openai.com + every compatible endpoint (OpenRouter, Groq, Ollama…). Model resolution + credentials: `core/src/provider/registry.ts`. |
| **Tool registry & execution** | `core/src/tools/registry.ts` | `ToolRegistry.execute()` is the single execution path: output bound at 32K (head+tail, spill to disk). Built-in file tools: `core/src/tools/fs-read-write.ts`, `fs-edit.ts`, `fs-list-glob.ts` with shared guards (rooting, staleness, did-you-mean, per-path mutation queue) in `fs-guard.ts`. |
| **Subagent spawning** | `core/src/tools/task.ts` | The `task` tool: spawns a real child session (`meta: {parent, agent}`) running any agent to completion via `RunCoordinator.drainNow`, returns the child's final text in a `<task>` XML block. Depth-capped (`agents.subagentDepth`, default 1); children never offered/allowed `task`/`question`/`plan.exit`; batched task calls run concurrently (executeCalls stage 2); the result payload carries `subagent: {sessionId, agent}` for surface links. |
| **Custom tool files** | stored in `~/.config/bai/tools/*.ts`; loader `core/src/tools/loader.ts` | Contract: default export `{ description, schema (JSON Schema), execute(args, ctx) }`. Filename stem = tool name. Hot-imported on change (Bun ignores query-param cache busting → versioned temp copies). Created/edited from the TUI agent manager (supermenu → Switch agent) or web Agents page via `PUT /api/tool/:name`. |
| **Agents** | stored in `~/.config/bai/agents/*.md`; registry `core/src/agent/registry.ts` | Markdown + YAML frontmatter (`description`, `model?`, `tools` allow-list), body = system prompt, name = filename stem. `AgentRegistry` scans + `fs.watch`-es the directory (debounced rescan → live `agents.updated` event) — no restarts, ever. Schema + built-in `build` agent: `shared/src/agents.ts`. Selected per session (TUI supermenu's Switch agent, web chat-header picker) or defaulted via config `agents.default`. Created three ways: drop a file on disk, `PUT /api/agent/:name` (writes the markdown), or the TUI agent manager / web Agents page. |
| **Permissions** | `core/src/permissions/engine.ts` (pure rule match) + `core/src/permissions/ask.ts` (`PermissionGate`) | Layers: `fs.read/list/glob` allow-by-default < `config.permissions` < session approvals ("always" → `session.meta.approvals`). The gate blocks tool execution on a durable `permission.asked` event until `Service.replyPermission` resolves it — first reply wins across devices. |
| **Token discipline + compaction** | `core/src/context/discipline.ts`, `core/src/context/compact.ts` | Render-time transforms (transcript untouched): identical-result stubbing, old-result pruning. Compaction triggers at 75% of the context window from provider-reported usage; the summary persists as a message and `session.meta.compactionMessageId` slices history from then on. |
| **Revert / fork / snapshots** | `core/src/snapshot.ts` (shadow git repo), `core/src/revert.ts` (shared helpers), `core/src/service.ts` (`revertSession`/`unrevertSession`/`forkSession`) | Two-phase revert (opencode parity): every mutating tool batch (`bash`, `fs.write/fs.edit`, `task`) records a `patch` part `{hash, files}` — the shadow-repo tree before the batch + the files it changed (written in `executeCalls`). Revert stamps `session.meta.revert`, rolls each file back from the patch parts, and hides the tail; `RunCoordinator.revertCleanup` hard-deletes it at the next prompt admission (`message.removed` events). Unrevert restores the snapshot. Fork copies the history before a message into a new `"<title> (fork #N)"` session with fresh ids. Message-only fallback outside git worktrees. |
| **Sessions/parts/events persistence** | `core/src/store/*` (repos) + `core/src/event/{bus,log}.ts` | `parts` rows carry tool_call/tool_result payloads; the event log is the durable replay buffer behind the SSE streams. |
| **HTTP boundary** | `api/src/server/app.ts` (`buildApi` — one chained Hono expression for typed RPC) | Agent/tool routes live here; SSE in `server/sse.ts`. Typed client: `api/src/client/index.ts`. |
| **Composition root (boot)** | `cli/src/boot.ts` | Constructs store, registries, agents, tool loader, gate, service, app — and stops them all on shutdown. |

### 5.2 User-owned files (outside the repo)

| Path | Contents |
| --- | --- |
| `~/.config/bai/config.json` | layered config (§12) |
| `~/.config/bai/agents/*.md` | agent definitions — hot-reloaded (§9) |
| `~/.config/bai/tools/*.ts` | custom tool files — hot-imported |
| `~/.local/share/bai/` | `bai.db` (SQLite, WAL), `assets/`, `tmp/`, `snapshot/` (shadow git repos for revert's file rollback) |
| `~/.local/state/bai/server.json` | url/pid/token for local discovery |

## 6. Domain model

| Concept               | Meaning                                                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Session**           | A named conversation scoped to a workbench (`chat`, `code`, …). Durable. Has an inbox, message history, and an event log.                              |
| **Agent**             | A persona + tool allow-list (+ optional model override) defined as a markdown file (`~/.config/bai/agents/*.md`) or built-in (`build`). Selected per session via `session.meta.agent`; hot-reloaded. |
| **Message**           | One turn participant entry (`user`, `assistant`, `system`). Composed of ordered **Parts** (text, thinking, file ref, image ref, tool call, tool result, patch — the revert rollback record). |
| **Input / admission** | A submitted prompt is first persisted as an inbox row (durable), then _promoted_ into history when the runner picks it up. Crash-safe by construction. |
| **Run (drain)**       | One process-local execution span: promote eligible inputs → loop provider turns + tool calls until idle. Never two concurrent runs per session.        |
| **Steer vs queue**    | A prompt arriving mid-run _steers_ (promotes at the next safe boundary); one marked `queue` waits until idle.                                          |
| **Tool**              | A callable unit (builtin, workbench-provided, or MCP-provided). Registry merges all; namespaced (`fs.read`, `mcp/myserver/search`).                    |
| **Permission**        | Gate evaluated per tool call: rule match → `allow` / `ask` / `deny`. Unmatched defaults to `ask`.                                                      |
| **Event**             | Typed fact. Two flavors: **live** (firehose SSE, best-effort) and **durable** (per-session log rows, replayable by seq cursor).                        |
| **Revert (two-phase)**| A boundary USER message recorded in `session.meta.revert`: everything from it on is hidden and the file changes after it are rolled back (shadow-repo snapshot), until restored — or committed (hard-deleted) by the next prompt. |
| **Fork**              | A new independent session holding the history BEFORE a chosen message, with fresh ids; the boundary message's text seeds the composer.                  |
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
parts(id PK, message_id FK, ord, kind, payload JSON)         -- text|file|image|tool_call|tool_result|patch
inputs(id PK, session_id FK, payload JSON, state, queued, created_at) -- admitted|promoted|cancelled; queued = queue delivery (waits for idle)
events(aggregate_id, seq, type, payload JSON, created_at,
       PRIMARY KEY(aggregate_id, seq))                        -- durable per-session log
permissions(id PK, session_id FK, tool, args_digest, status, rule, created_at)
jobs(id PK, kind, session_id NULL, status, input JSON, output JSON, error, created_at, updated_at)
assets(id PK, kind, mime, path, bytes, meta JSON, job_id NULL, created_at)
kv(key PK, value JSON)                                        -- misc runtime state
usage(id PK, session_id FK NULL, kind, agent NULL, workspace NULL, provider, account NULL,
      model, input_tokens, output_tokens, reasoning_tokens NULL, cache_read_tokens,
      cache_write_tokens, cache_write_1h_tokens, *_rate_usd_1m ×5, error NULL, created_at)
                                                              -- append-only per-LLM-call analytics (D26)
```

Media files live under `~/.local/share/bai/assets/<kind>/<id>.<ext>`; the DB
holds metadata only. Numbered forward-only SQL migrations recorded in a meta
table. All timestamps UTC RFC3339. Queries stay explicit — no ORM.

The `usage` table (D26) is append-only analytics: one row per provider LLM
call (`kind`: run | title | compaction) with token counts and the EFFECTIVE
per-component rates (USD per 1M tokens) snapshotted at insert time. Dollars
are computed at FETCH time as Σ(tokens × rate) / 1e6 — never denormalized —
so history stays correct regardless of later catalog price edits and every
$ figure is auditable down to the row.

## 8. Events & sync — the continuity mechanism

**Envelope** (both live and durable):

```json
{ "seq": 42, "type": "message.part.delta", "ts": "2026-08-27T09:00:00Z",
  "session_id": "ses_01J...", "payload": { ... } }
```

Event types (initial set): `session.created|updated`, `input.admitted`,
`input.promoted|cancelled|updated` (message-queue lifecycle),
`message.created`, `message.part.updated`, `message.part.delta`,
`message.removed` (revert cleanup), `run.started|finished`,
`permission.asked|replied`, `job.updated`, `asset.created`,
`config.updated`, `provider.updated`, `agents.updated`, `tools.updated`,
`server.hello`. Live-only events (`config.updated`, `provider.updated`,
`agents.updated`, `tools.updated`, `server.hello`) use seq 0 and are
best-effort; everything session-scoped is durable.

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

*(Implementation: `core/src/run.ts` — see the code map, §5.1.)*

```
submit(prompt) ──► inputs row (durable, queued?) ──► wake coordinator
coordinator(session): if idle → start drain:
   resolve agent (session.meta.agent → config agents.default → built-in default) + tools
   promote steers (all) — else, at the would-be-idle boundary, ONE queued input
   → append user message(s)
   loop (≤ 50 turns per promotion batch):
      history → compaction-pointer slice → token discipline → renderOutbound
      stream provider turn → persist parts, emit deltas as events
      for each tool call: parse args → unknown-tool check → permission gate
                          → execute → append tool_result part
      promote steers admitted mid-run (next request carries them)
      continue while tool calls resolved (state-based, not finish-reason based)
   until: no continuation, steps capped, all calls denied, or interrupted
   → back to promotion (queued inputs drain one at a time) until idle
interrupt: AbortController cancels the drain; admitted-but-unpromoted inputs stay queued
```

- **One drain per session** (process-global `Map` keyed by session ID);
  different sessions run concurrently. Joins/coalesces wakes.
- **Agents** resolve at drain start and are snapshotted for the whole run —
  file edits mid-run apply next run. Tool defs = registry ∩ the agent's
  allow-list (`"*"` = everything), order-stable for prompt caching. The
  agent's `model` is a default; an explicit per-session model wins. Agent
  selection resolves session meta → config `agents.default` → built-in
  `build`; unknown names at any tier warn and fall back.
- **Tool registry** merges builtin + workbench + custom-file tools; enforces
  output size limits (truncate head+tail, spill full output to a managed
  temp file).
- **Permissions:** layers `fs.read/list/glob: allow` + **cwd-relative fs
  default** (an fs tool targeting a path inside the session's working
  directory is allowed without an ask — `fsPathInsideCwd`; bash/web and
  anything outside the cwd keep asking) < `config.permissions`
  (`{ "<tool-pattern>": "allow|ask|deny" }`, last-match-wins) < session
  approvals ("always" → `session.meta.approvals`). Unmatched defaults to
  `ask`; unknown tools error out before the gate (an unmatched tool would
  otherwise stall the run on an ask nobody can answer). Interactive asks
  broadcast to all surfaces; first reply wins; `always` persists for the
  session. A batch where every call was denied ends the run. Interrupted
  runs unblock pending asks: the gate wires the drain's AbortSignal into
  the wait — abort flips the row to rejected, broadcasts
  `permission.replied`, and resolves the call as a cancelled denial
  (QuestionService's abort handling is the precedent).
- **Token discipline** (render-time, transcript untouched): identical tool
  results collapse to one-line stubs; results outside the newest-10 window
  prune to summaries; errors always stay verbatim.
- **Usage capture invariant (D26):** EVERY `provider.stream()` call site —
  run turns, the title generator's detached refine, the compaction
  summarizer — records one kind-tagged row in the `usage` table through
  `RunCoordinator.recordLlmUsage` (tokens + per-row rate snapshot; see §7).
  FAILED calls record zero tokens plus the provider error message
  (`recordLlmError`) — user aborts are not failures. Future LLM call paths
  (new workbenches, MCP-driven calls) must do the same:
  `core/test/usage-capture.test.ts` scans the source and fails when a
  call site skips capture, so analytics completeness holds by construction.
  The web **Analytics** section (`/analytics`, rail item under Tools)
  aggregates these rows per agent/workspace/provider/account with
  day/month/year buckets — spend, tokens, requests, cache hit rate, blended
  $/1M, per-model usage/volume, token breakdown, prompt-caching, and
  error graphs.
- **Compaction:** when provider-reported input tokens cross 75% of the
  model's window (80K floor), the small-model path summarizes the transcript
  into a structured summary (Goal/Progress/Decisions/Next Steps/Critical
  Context + read/modified-files appendix); `session.meta.compactionMessageId`
  points at it and later drains slice history from that pointer.
- **Revert & fork:** every mutating tool batch snapshots the worktree into a
  shadow git repo (`core/src/snapshot.ts` — one repo per worktree under
  `~/.local/share/bai/snapshot/`, object db borrowed via alternates, ops
  serialized per gitdir) and appends a `patch` part `{hash, files}`.
  `revertSession` marks `session.meta.revert` and rolls each touched file
  back to its pre-change tree (created files deleted); the hidden tail is
  hard-deleted at the next prompt's admission (before the new user message
  lands) with `message.removed` events, and a stale compaction pointer is
  cleared if its summary was reverted away. `unrevertSession` restores the
  snapshot; `forkSession` copies the history before a message into a new
  `"<title> (fork #N)"` session with fresh ids, remapping the compaction
  pointer and stripping `parent`/`revert`. Outside a git worktree revert is
  message-only; `stopReason`-style guards apply — revert/unrevert/fork
  refuse while the session is draining.
- **Length guard:** `stopReason === "length"` fails every pending tool call
  (streamed JSON arguments may be truncated) and ends the run.
- **Env block:** every turn's system prompt is persona + `<env>` — working
  directory (fs paths resolve relative to it; bash runs there), workbench,
  agent, the agent's available tools, platform, and date
  (`core/src/run/env.ts`). Subagents inherit their parent's cwd through
  their own session row, so the whole session tree knows where it is.
- **Subagents (the `task` tool):** a call spawns a real child session
  (`meta: {parent, agent}`, title `"<task> (@<agent> subagent)"`, inherited
  workbench/cwd) and blocks on a new awaitable drain
  (`RunCoordinator.drainNow` — the `ActiveRun` now carries a settle-able
  `done` promise; `wake` semantics unchanged). Model precedence: the
  subagent's own `model` wins; otherwise the parent's explicit
  `meta.model` is copied down. Children get their own `MAX_STEPS` budget,
  compaction, discipline, and permission gate (config rules apply globally;
  asks surface on the child session, approved there). Guards: depth cap
  (`agents.subagentDepth`, default 1), interaction/recursion tools
  (`task`, `question`, `plan.exit`) stripped from both the offered defs
  (`toolDefsFor`) and execution (`executeCalls` backstop), and the spawn
  itself fails closed (`task` unmatched → ask). Batches made entirely of
  `task` calls run concurrently — independent sessions by contract; results
  persist in call order either way. Surfaces: the TUI renders a live
  subagent inspector bar (children of the active session, fed from the
  firehose — `tui/src/state/subagents.ts`) and thought-style task nodes
  that open the **subagent dialog** (`tui/src/views/subagent-dialog.tsx`):
  the child's live transcript with ←/→ cycling and inline permission-ask
  review; subagent sessions are deliberately kept out of the session
  lists. The web unwraps task bodies and links to the child session.

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

Adapters implemented today: **Anthropic** (`@anthropic-ai/sdk`) and one
**OpenAI-compatible catch-all** (`openai` SDK, custom base URL) covering
api.openai.com, OpenRouter, Groq, Ollama, llama.cpp, LM Studio, DeepSeek,
etc. Both speak tools: Anthropic uses `tool_use`/`tool_result` content
blocks with `input_json_delta` streaming; OpenAI uses `tool_calls`
accumulation and `role:"tool"` messages. A Gemini adapter is planned.
Vendor types stay isolated inside adapter files so SDK majors never leak
into `core`.

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
  "models": { "default": "anthropic/claude-sonnet-4-5", "title": "anthropic/claude-haiku-4-5" },
  "agents": { "default": "reviewer" },
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
- **Supermenu** (`ctrl+p`, `views/command-palette.tsx` + `state/commands.ts`):
  the single entry point for app commands — a searchable palette with
  category headers and a contextual Suggested section (opencode's command
  palette). The registry is pure data (`state/commands.ts`); the App
  dispatches a picked id to the same openers the hub chips use. The old
  ctrl+** chord family is gone; the ctrl+c hatch and editing/navigation
  chords (ctrl+j/k/w, ctrl+u/d) are unaffected.
- **Agent/tool switcher** (`views/agent-manager.tsx`): agents|tools
  tabs; enter (or u) applies the highlighted agent — per-session when a
  session is open, otherwise as the config default (`agents.default`); create
  (writes via API), edit (`$EDITOR` on the underlying file — the server's
  watcher hot-reloads on save), delete; refreshes live from
  `agents.updated`/`tools.updated`. The web chat header mirrors this with an
  agent picker button (same session/default duality as its model picker).
- Tool calls render as compact status lines (`✓ fs.read src/x.ts`) next to
  the collapsible thinking panel (`views/chat.tsx` + `state/sync.ts`,
  kind-aware delta reducer).
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

- Views: sessions sidebar, chat, **Agents section** (nested sidebar list +
  form editor for agent markdown — `agents.tsx`), **Tools section** (nested
  sidebar list + code editor for custom tools — `tools.tsx`, separate nav
  items), code (file tree + diffs), image gallery, video gallery, jobs
  queue, settings (config editor), pairing screen.
- Tool calls render as collapsible nodes beside the thinking panel
  (`chat-pane.tsx` + `state.ts` — the same kind-aware reducer semantics as
  the TUI).
- Sync engine mirroring the TUI's semantics (§8). Global events ride ONE
  shared firehose connection (`EventMux` in `@bai/api/client` — fan-out to
  every consumer; the page's SSE budget is the mux + the active session's
  durable stream), and all streams abort on `pagehide` — renderer
  destruction does not cancel streaming fetches, so unreleased SSEs would
  otherwise accumulate across reloads and starve the browser's
  6-per-origin connection budget.
- State: small stores + reducers over events (no heavyweight state library
  unless Phase 1 proves the need).
- Styling: utility-first CSS; responsive-first layouts (phone is a primary
  target, not an afterthought).
- Routing: a dependency-free client router (`router.ts` — pure
  `parseRoute`/`routeToPath` over the History API; no hash routing, which is
  reserved for `#pair=` pairing tokens). React state stays the source of
  truth; the URL is a synced projection: boot seeds state from the URL,
  user-initiated navigation pushes (`pushRoute`), a replace-only effect
  canonicalizes corrections (boot `/`, draft → created session, dead ids,
  stale workspace slugs), and `popstate` applies back/forward. Deep-linked
  sessions resolve with one `getSession` fetch. Routes:

  | URL | Screen |
  |---|---|
  | `/`, `/chat` | Chat, draft |
  | `/chat/{sessionId}` | Chat, session active |
  | `/workspace` | Workspace picker |
  | `/workspace?w={slug}` | Workspace, chat view (`&view=files` → files view, `&s={sessionId}` → session; combinable) |
  | `/settings/{user\|general\|providers}` | Settings subsection |
  | `/agents`, `/agents/new`, `/agents/{name}` | Agents list / create form / detail |
  | `/tools`, `/tools/new`, `/tools/{name}` | Tools (same shape) |
  | anything else | Chat draft (fallback) |

  The workspace path rides `?w=` as an opaque base64url slug
  (`wsSlug`/`wsUnslug`) — workspaces are config-listed folder paths with no
  id (`Config.workspaces: string[]`), so the path is the identity; the slug
  just keeps it out of the address bar. File tabs are ephemeral (not routed).

Serving contract (owned by `@bai/api`):

- Static hosting of `@bai/web/dist` with SPA fallback: real file → serve;
  otherwise rewrite to `/` for the client router; `/api/*` and `/mcp` never
  fall through.
- `hasAssets()` guard: friendly "run the web build" hint page instead of a
  blank 404 when dist is missing.
- Cache headers: immutable for hashed `/assets/*`, `no-cache` for index.html.
- Dev mode: Vite dev server proxies `/api` + `/mcp` to a running bai
  (see `packages/web/vite.config.ts`); alternatively the server proxies
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
make build                      # bun build --compile → dist/bai (+ dist/web on bun < 1.4)
make run                        # build and start the TUI
make dev-web                    # (see web package) vite dev server on :5173
bun run dev -- --filter @bai/cli # bun --hot server dev (fetch handler hot-reload)
bun test                         # bun:test across workspaces (--parallel ready)
make vet                         # tsc --noEmit per package
make release                     # all 8 cross-compile targets → dist/
```

Release matrix via `bun build --compile` targets:
`bun-linux-x64|arm64[-musl]`, `bun-windows-x64|arm64`, `bun-darwin-x64|arm64`.
`BAI_VERSION` is stamped into the binary via `define` (the analog of Go's
`-ldflags -X`). The SPA is embedded via compile assets on Bun ≥ 1.4; on 1.3.x
`make build` stages it to `dist/web` beside the binary and the runtime finds
it there. Expected binary size ~60–96 MB (Bun runtime included) vs the Go
design's <40 MB target — an accepted trade-off documented in the decision
log. Workers must be listed as explicit compile entrypoints if ever
introduced.

Graceful shutdown: drain in-flight runs → `server.stop(true, timeout)` →
checkpoint WAL → close DB → exit. A hard timeout guards against the known
Bun issue where `stop()` can hang after server-initiated WebSocket closes.

## 16. Roadmap

| Phase                     | Deliverable                                                                                                                | Success criteria                                                           | Status |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------ |
| **0 — Skeleton**          | workspaces, mode dispatch, config layers, store+migrations, hello-world API, web shell, TUI shell, compile pipeline        | `bai` opens TUI; `bai --web` serves SPA; `bai --one-shot hi` prints NDJSON | ✅ shipped |
| **1 — Chat**              | Provider layer (OpenAI-compat + Anthropic first), streaming, sessions/messages end-to-end, web chat + TUI chat             | Same conversation visible & continuable from TUI and phone browser         | ✅ shipped |
| **2 — Sync hardening**    | Durable event log + cursor resume, pairing token, config editing from web, `config.updated` propagation                    | Kill/resume mid-stream loses nothing                                       | ✅ shipped |
| **3 — Code workbench**    | fs/grep/bash/edit tools, permission engine, agents (file-defined, hot-reloaded), subagents (`task` tool), token discipline + compaction, diff viewer, per-message revert/fork/copy with file rollback | Guided multi-file edit with approvals from either surface                  | ✅ shipped (file-tree diff viewer pending) |
| **4 — MCP dual role**     | Client manager + server exposure (v2 SDK, Hono adapter), namespaced tool merge                                             | External MCP tools callable in sessions; external agent can drive bai      | ⏳ pending |
| **5 — Media workbenches** | Real image adapters (fal.ai first), job queue UX, galleries; video adapter after                                           | Prompt→job→asset→gallery round trip on phone                               | ⏳ pending (structured stubs live — see FEATURES.md) |
| **6 — Desktop**           | Native shell reusing SPA + core (tech decided then)                                                                        | Feature parity with web                                                    | ⏳ pending |

(The agents + custom-tools feature set was built as part of Phase 3's
execution; its plan and research notes live in `~/thoughts/plans/` and
`~/thoughts/research/`.)

## 17. Decision log

Carried over from the Go design where still applicable (D1–D12), plus
TypeScript-specific decisions (D13+):

| #   | Decision                                        | Rationale                                                                     | Alternatives rejected                        |
| --- | ----------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------- |
| D1  | Server-first core, thin surfaces                | Continuity across devices becomes structural                                  | Fat clients syncing P2P                      |
| D2  | Single Bun workspace + `packages/*`         | User-mandated layout; simplest builds; hoisted installs                       | Turborepo/Nx (no need yet), nested src dirs  |
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
| D21 | File-defined agents, hot-reloaded               | Markdown + minimal frontmatter beats config blobs; `fs.watch` + debounced rescan beats opencode's restart-to-apply | opencode.json agent blocks; forever-caches |
| D22 | Render-time token discipline, transcript sacred | Idempotent transforms = cache-stable prefixes; the event-sourced transcript is the recovery store | Mutating history in place; stateful rearm counters |
| D23 | Custom tools as TS files, dynamically imported  | Bun imports TS natively (no jiti); files stay the source of truth; CRUD UX writes files via the API | Declarative config tools; sandboxed workers (v1) |
| D24 | Subagents as durable child sessions (`task` tool) | Event-sourcing + multi-device inspection for free: the child is a real session with its own history, compaction, and permission gate, watchable from any surface — not a hidden in-memory transcript | pi-style child processes (no shared store/events), hermes-style thread pools (opaque to surfaces), synthetic in-memory subagents (no resume, no audit) |
| D25 | Shadow-repo git snapshots for revert (message-only fallback) | File rollback without ever touching the project's own `.git`; alternates seeding avoids re-hashing large repos; message-only fallback keeps revert useful outside git worktrees | Snapshotting via the project repo (mutates user state); per-turn full copies (unbounded growth); deferring file revert entirely |
| D26 | Every LLM call records usage (kind-tagged rows, per-row rate snapshot, cost computed at fetch) | Analytics completeness by construction — spend tracking can't be silently skipped (enforced by a source-scan test); rates frozen per data point keep history correct across catalog price edits; fetch-time Σ(tokens×rate) is auditable and drift-free | Deriving usage from events (lossy — no cache/reasoning fields); per-feature ad-hoc tracking; denormalized cost snapshot (drift risk) |

## 18. Glossary

See §6 for domain terms. **Surface** = a UI (TUI/web/desktop/CLI). **Mode** =
an invocation style choosing which surface(s) run. **Cursor** = opaque last-seen
event sequence number used for durable replay. **Pairing** = token exchange
granting a device API access. **Workbench** = registered modality module.
