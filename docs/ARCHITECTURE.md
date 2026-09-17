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
  (`task` tool), token discipline + compaction, per-message
  revert/fork/copy with shadow-repo file rollback, and **provider
  OAuth/subscription logins + custom providers** (§10.1) ship today. MCP
  (§11), media adapters, and desktop are next.
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
| `bai --router`                | Headless gateway         | Serve OpenAI-compatible `/v1/*` + `/api/help` (no web UI); `--web --router` combines both in one process |
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
| `provider`    | `packages/provider`| Model providers + adapters + OAuth + the router **SDK** (`ModelRouter`). Depends only on `shared`. |
| `core`        | `packages/core`    | Sessions, runs, tools, permissions + supporting submodules     |
| `api`         | `packages/api`     | Typed HTTP boundary, both sides (Hono app + typed client)      |
| `cli`         | `packages/cli`     | Flags, wiring, mode dispatch (composition root)                |
| `tui`         | `packages/tui`     | Ink surface                                                    |
| `web`         | `packages/web`     | React SPA source; built `dist/` served by api                  |
| `desktop`     | `packages/desktop` | Stub until Phase 6                                             |
| `router`      | `services/router`  | OpenAI-compatible JSON gateway (`/v1/*`) + `/api/help`; composed in-process, never its own core. |

Supporting modules live as submodules inside `core/src/`:

```
core/src/
├── store/        bun:sqlite persistence + migrations
├── event/        live bus + durable seq-cursor log
├── config/       layered configuration
├── agent/        file-defined agents: scan, watch, hot-reload
├── tools/        tool registry, built-in fs tools, custom-tool loader
├── context/      token discipline (pruning/stubbing) + compaction
├── permissions/  rule engine + interactive gate
├── mcp/          MCP client manager: file-first registry, transports, OAuth
└── workbench/    modality registry
    ├── chat/
    ├── code/
    ├── image/
    └── video/
```

(The former `core/src/provider/` submodule is now the standalone
`@bai/provider` package; core re-exports it at `core/src/index.ts`.)

```
cli ─► {config, store, event, provider, mcp, core, api, router, tui}
                          │
        core ◄────────────┼────────────── workbench/{chat,code,image,video}
        │  │              │                     (implement core contracts)
        │  └─► provider, mcp, event, store, shared
        └───► shared
provider ─► shared
router   ─► {provider, core, api, shared}
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
| **`#file` mentions** | `core/src/fs/find.ts` (search) + `core/src/run/mentions.ts` (resolve/read); grammar `shared/src/mention.ts`; pickers `tui/src/components/mention-picker.tsx` + `web/src/mention-picker.tsx` | `GET /api/fs/find` fuzzy-searches a registered workspace (hidden/ignored dirs skipped); the composer inserts the shortest unique leaf token (`#button.tsx` — opencode's chip display) and expands it to the full `#path[:from-to]` at submit. At promotion, each mention is resolved (root-scoped) and read into a `file` part (numbered lines / dir listing, capped like `fs.read`); `renderOutbound` attaches `<file>` blocks to the user turn. Optional `:from`/`:from-to`/`:from-`; gated to sessions with a workspace root. In the web transcript each mention renders as a leaf chip (hover = full path, click opens the workspace viewer via `openMentionedFile`); the TUI renders the leaf inline. |
| **Attachments (chat only)** | `core/src/attachments.ts` (classify/store/resolve), `core/src/run.ts` (`appendPromotedInputs` + `resolveAttachment`), `core/src/run/history.ts` (`renderOutbound` media blocks), adapters (`provider/adapters/anthropic.ts` image/document, `openai.ts` image_url/file); UI `web/src/attachments.tsx` + `web/src/chat-pane.tsx`; upload route `POST /api/attachment` (`api/src/server/app.ts`) | Cwd-less chat sessions only: web `+` button + composer drag-and-drop upload images/PDF/text → asset store (`assets/attachment/<id>.<ext>`, `kind:"file"`, `meta.attachment`). Text becomes a `file` part (read context); image/PDF become an `attachment` part. `renderOutbound` lowers them to provider blocks; missing/older-than-newest-3-user-turn attachments become omission notes (`context/discipline.ts`). Model capability (models.dev `attachment`/`modalities`) enforced at submit (`Service.assertAttachmentsSupported` → 400). Preview via `GET /api/asset/:id/content`. |
| **Workspace file uploads** | `api/src/server/fs.ts` (`writeFile`), route `POST /api/fs/upload` (`api/src/server/app.ts`), client `BaiClient.uploadWorkspaceFile`, UI `web/src/file-tree.tsx` (drop targets) + `web/src/App.tsx` (`uploadToWorkspace`) | Drag files from the OS onto a folder row or the tree root → raw bytes written into the registered workspace (realpath-contained, 64 MB cap, auto-rename on collision). No composer attach button in workspace; uploaded files are ordinary files and are immediately `#file`-able (`clearFindCache(root)`). |
| **The LLM calls (HTTP)** | `provider/src/types.ts` (`Provider.stream`) + `provider/src/adapters/anthropic.ts`, `adapters/openai.ts`, `adapters/responses.ts` | The ONLY files that touch vendor SDKs / provider HTTP. Anthropic: `tool_use`/`tool_result` blocks, `input_json_delta` streaming, cache breakpoints, OAuth Bearer/beta + Claude Code shape. OpenAI-compat serves api.openai.com + every compatible endpoint (OpenRouter, Groq, Ollama…). Responses serves ChatGPT/Codex + xAI (`store:false`, `function_call` items, `ChatGPT-Account-ID`). Model resolution + credentials: `provider/src/registry.ts`; the router SDK seam: `provider/src/router.ts`; logins: `provider/src/oauth/`. |
| **Custom provider files** | `provider/src/file-registry.ts` (`ProviderFileRegistry`) + `shared/src/provider-files.ts` (schema) + `core/src/workbench/media/{file-providers,generic,mapping}.ts`; routes `GET/PUT/DELETE /api/provider/file(s)`; web `web/src/provider-file-form.tsx` | `~/.config/bai/providers/<id>.json` (JSONC), hot-reloaded (fs.watch + poll, like `McpRegistry`). A required `providerType` (`text`/`image`/`video`) gates the optional `text`, `image`, and `video` blocks. Files merge into the catalog as the top layer (`source: "file"`; env/base URL + `mediaOnly` hiding), and image blocks become workbench provider defs — the OpenAI-images template reuses `OpenAiImagesAdapter`, anything else uses `GenericMediaAdapter` (interpolated request body + response path mapping). Built-in media ids are reserved. Writes are validated + atomic; `onChange` invalidates the catalog/registry and broadcasts `provider.updated`. |
| **Router gateway / SDK** | `services/router/src/{index,chat,images,models,openai,help,deps}.ts`; `provider/src/router.ts` (`ModelRouter`); CLI `cli/src/modes/router.ts`; app composition `api/src/server/app.ts` (`extraRoutes`, `serveSpa`) | The **SDK version** (`ModelRouter`) resolves `provider/model` + `x-bai-account` → adapter + credentials and streams; core's run loop and the gateway share it. `@bai/router` wraps it in an OpenAI-compatible HTTP surface: `POST /v1/chat/completions` (SSE or JSON), `GET /v1/models`, `POST /v1/images/generations` (enqueues on the shared image job queue, returns base64). `/v1/*` is mounted in **every** mode via `ApiDeps.extraRoutes`; `/api/help` (HTML) + `/api/help/openapi.json` (OpenAPI 3.1) only in `--router`. Composed in-process — never a second core (boot reconciles jobs/automations). |
| **Tool registry & execution** | `core/src/tools/registry.ts` | `ToolRegistry.execute()` is the single execution path: output bound at 32K (head+tail, spill to disk). Built-in file tools: `core/src/tools/fs-read-write.ts`, `fs-edit.ts`, `fs-list-glob.ts` with shared guards (rooting, staleness, did-you-mean, per-path mutation queue) in `fs-guard.ts`. |
| **Image generation (workbench + adapters)** | `core/src/workbench/image.ts` (job executor) + `core/src/workbench/media/{adapter,registry,http,openrouter,openai-images,openai,xai,together,deepinfra,recraft,gemini,bfl,fal,replicate,stability,ideogram,minimax,stub,dimensions}.ts` + the shared `shared/src/media-providers.ts` spec table; agent tool `core/src/tools/image.ts` (`image.generate`, registered by `Service`); service `Service.{imageProviders,revealAccountKey,enqueueImageGeneration,imageCapabilities,imageGallery,imageTags,imageRecent,deleteAsset,setAssetTags,retryJob,cancelJob}`; routes in `api/src/server/app.ts`; web `web/src/image.tsx` + `use-image-gallery.ts` + `components/TagInput.tsx`; analytics `store/media-usage.ts` + `GET /api/image/usage` + the Analytics page's **Image generation** card | Adapters own the provider wire shape (no vendor SDKs — direct REST via `fetch`/`FormData`) and declare a generic `MediaParamSpec` vocabulary; the web renders it and fetches the provider list from `GET /api/image/providers` (models + saved accounts). `media-providers.ts` feeds the curated overlay (`mediaOnly` providers resolve env keys/base URLs but are hidden from chat pickers). The Image page has no provider picker — its model list aggregates every connected provider's models. `GET /api/provider/:provider/account/:account/key` reveals one **stored API key** for copy-to-clipboard (`no-store`; OAuth tokens and env keys are never returned). Transports: sync JSON (OpenAI/xAI/Together/DeepInfra/Recraft/OpenRouter), multipart (Stability/Ideogram/OpenAI edits), Google Interactions (Gemini), async submit→poll (BFL/fal/Replicate, abort-aware with backoff, result URLs downloaded to bytes). Assets are self-describing (`meta.gen` = the request) and independently deletable; tags are indexed in `asset_tags`. Jobs run on the hardened `JobQueue` (boot recovery, timeout, bounded retry/backoff, **parallel up to `config.jobs.concurrency`**, cancel, graceful stop, atomic asset writes); each terminal image job records one `media_events` analytics row. The `image.generate` tool merges the Image Generation settings defaults, awaits the job via `JobQueue.waitFor`, optionally writes results into the workspace (`save_to`, snapshot-covered), and returns `assets` on the tool result for inline thumbnails. |
| **Video generation (workflow-driven workbench + adapters)** | `core/src/workbench/video.ts` (job executor) + `core/src/workbench/media/{video-adapter,video-registry,video-http,video-dimensions,upload,workflow-specs}.ts` + `video/{stub,openrouter,fal,replicate,gemini-veo,runway,kling,luma,minimax,wan,seedance,generic}.ts` + the shared `shared/src/media-providers.ts` spec table; agent tool `core/src/tools/video.ts` (`video.generate`, registered by `Service`); service `Service.{videoProviders,videoCapabilities,enqueueVideoGeneration,videoGallery,videoTags,videoRecent}`; routes `POST /api/video/generate` + `GET /api/video/{providers,capabilities,gallery,tags,recent,usage}`; web `web/src/video.tsx` + `use-video-gallery.ts` + `media-asset-picker.tsx`; analytics `store/media-usage.ts` (`kind='video'`) + the Analytics page's **Video generation** card | Video is workflow-driven: adapters declare `VideoCapabilities.workflows[]` (t2v/i2v/flf2v/ref2v/v2v/extend/upscale/motion/lipsync/reframe), each with role-tagged `VideoInput` slots (first_frame/last_frame/reference_image|video|audio/source_video). Inputs resolve from stored assets, workspace uploads, or hosted URLs; providers that need hosted bytes upload through `media/upload.ts` (fal storage, Runway `/v1/uploads`, Replicate Files) while inline-capable providers skip the hop. Result bytes are downloaded inside `generate()` (providers return expiring URLs) and probed for duration/size (`video-dimensions.ts`, MP4 `mvhd`/`tkhd`). The job queue extracts a first-frame **poster** with ffmpeg (`core/src/jobs/poster.ts`, via `ffmpeg-static`; `FFMPEG_PATH`/system-`ffmpeg` fallback, `BAI_VIDEO_POSTERS=0` to disable) into a JPEG beside the video, served at `GET /api/asset/:id/poster`; gallery cards render that still and the `<video>` is only instantiated in the modal. `video.generate` jobs run on the shared `JobQueue` with a per-kind timeout (`config.jobs.videoTimeoutMs`, default 900 s); each terminal job records one `media_events` row with `kind='video'`. Assets live under `assets/video/`; the page model picker aggregates connected providers and the offline stub advertises every workflow. |
| **Subagent spawning** | `core/src/tools/task.ts` | The `task` tool: spawns a real child session (`meta: {parent, agent}`) running any agent to completion via `RunCoordinator.drainNow`, returns the child's final text in a `<task>` XML block. Depth-capped (`agents.subagentDepth`, default 1); children never offered/allowed `task`/`question`/`plan.exit`; batched task calls run concurrently (executeCalls stage 2); the result payload carries `subagent: {sessionId, agent}` for surface links. |
| **Custom tool files** | stored in `~/.config/bai/tools/*.ts`; loader `core/src/tools/loader.ts` | Contract: default export `{ description, schema (JSON Schema), execute(args, ctx) }`. Filename stem = tool name. Hot-imported on change (Bun ignores query-param cache busting → versioned temp copies). Created/edited from the TUI agent manager (supermenu → Switch agent) or web Agents page via `PUT /api/tool/:name`. |
| **Session plans & notes** | `core/src/session-files.ts` (`<dataDir>/sessions/<sessionId>/{notes.md,plans/*.md}`) + `core/src/tools/{plan-write,plan-read,notes}.ts` | Plans/notes are session-scoped FILES (portable between surfaces). `plan.write` is session-scoped (the plan agent's only write); `plan.read` lists/reads them for any agent (the Plans panel's build action hands a plan to the build agent); `notes.read`/`notes.write` give the agent the user's scratchpad. Service methods emit durable `plans.updated`/`notes.updated`; REST at `/api/session/:id/{notes,plan,todo}`. The web workspace right rail renders collapsible **Checklist** (editable `session.meta.todos`), **Plans** (list; click opens an editable editor in the Files view; a hammer builds a plan), and **Notes** (inline autosave) panels. |
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
| `~/.config/bai/providers/*.json` | custom provider files (text/image/video capabilities) — hot-reloaded |
| `~/.config/bai/mcp/*.{json,yaml}` | external MCP server definitions — hot-reloaded |
| `~/.local/share/bai/` | `bai.db` (SQLite, WAL), `assets/`, `tmp/`, `snapshot/` (shadow git repos for revert's file rollback) |
| `~/.local/share/bai/sessions/<sessionId>/` | `notes.md` + `plans/<name>.md` — the session's notes and plans, files so they are portable between surfaces (web/TUI) |
| `~/.local/state/bai/server.json` | url/pid/token for local discovery |

## 6. Domain model

| Concept               | Meaning                                                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Session**           | A named conversation scoped to a workbench (`chat`, `code`, …). Durable. Has an inbox, message history, and an event log.                              |
| **Agent**             | A persona + tool allow-list (+ optional model override) defined as a markdown file (`~/.config/bai/agents/*.md`) or built-in (`build`). Selected per session via `session.meta.agent`; hot-reloaded. |
| **Message**           | One turn participant entry (`user`, `assistant`, `system`). Composed of ordered **Parts** (text, thinking, file ref, image, attachment, tool call, tool result, patch — the revert rollback record). |
| **Input / admission** | A submitted prompt is first persisted as an inbox row (durable), then _promoted_ into history when the runner picks it up. Crash-safe by construction. |
| **Run (drain)**       | One process-local execution span: promote eligible inputs → loop provider turns + tool calls until idle. Never two concurrent runs per session.        |
| **Steer vs queue**    | A prompt arriving mid-run _steers_ (promotes at the next safe boundary); one marked `queue` waits until idle.                                          |
| **Tool**              | A callable unit (builtin, workbench-provided, or MCP-provided). Registry merges all; namespaced (`fs.read`, `mcp/myserver/search`).                    |
| **Permission**        | Gate evaluated per tool call: rule match → `allow` / `ask` / `deny`. Unmatched defaults to `ask`.                                                      |
| **Event**             | Typed fact. Two flavors: **live** (firehose SSE, best-effort) and **durable** (per-session log rows, replayable by seq cursor).                        |
| **Revert (two-phase)**| A boundary USER message recorded in `session.meta.revert`: everything from it on is hidden and the file changes after it are rolled back (shadow-repo snapshot), until restored — or committed (hard-deleted) by the next prompt. |
| **Fork**              | A new independent session holding the history BEFORE a chosen message, with fresh ids; the boundary message's text seeds the composer.                  |
| **Job**               | Long-running async unit of work (image generation, video generation). Queued, progress-reported, produces **Assets**.                                  |
| **Automation**        | A named prompt on an interval/daily/weekly schedule. The scheduler fires it; each run creates a new auto-approved Chat session and records an **Automation run**. |
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
parts(id PK, message_id FK, ord, kind, payload JSON)         -- text|file|image|attachment|tool_call|tool_result|patch
inputs(id PK, session_id FK, payload JSON, state, queued, created_at) -- admitted|promoted|cancelled; queued = queue delivery (waits for idle)
events(aggregate_id, seq, type, payload JSON, created_at,
       PRIMARY KEY(aggregate_id, seq))                        -- durable per-session log
permissions(id PK, session_id FK, tool, args_digest, status, rule, created_at)
jobs(id PK, kind, session_id NULL, status, input JSON, output JSON, error, created_at, updated_at)
assets(id PK, kind, mime, path, bytes, meta JSON, job_id NULL, created_at)
automations(id PK, name, prompt, schedule JSON, schedule_display, agent NULL, model NULL,
            workspace NULL, enabled, next_run_at NULL, last_run_at NULL, last_status,
            last_error NULL, last_session_id FK NULL, created_at, updated_at)  -- scheduled prompts
automation_runs(id PK, automation_id FK, session_id FK NULL, status, error NULL, output NULL,
                started_at, finished_at NULL)                        -- per-fire ledger
kv(key PK, value JSON)                                        -- misc runtime state
usage(id PK, session_id FK NULL, kind, agent NULL, workspace NULL, provider, account NULL,
      model, input_tokens, output_tokens, reasoning_tokens NULL, cache_read_tokens,
      cache_write_tokens, cache_write_1h_tokens, *_rate_usd_1m ×5, error NULL, created_at)
                                                              -- append-only per-LLM-call analytics (D26)
skill_events(id PK, session_id FK NULL, skill, agent NULL, file_path NULL, ok, error NULL,
             bytes, created_at)                               -- append-only skills.view analytics
mcp_events(id PK, session_id FK NULL, server, tool, kind, agent NULL, ok, error NULL,
           duration_ms, bytes, args_digest NULL, created_at)  -- append-only MCP interaction analytics
media_events(id PK, provider, account NULL, model, mode, images, cost_usd,
             duration_ms, ok, error NULL, created_at)         -- append-only image-generation analytics
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
`run.usage` (one durable event per provider turn — the context tracker's
live feed; carries the full token breakdown + the model's context window;
after compaction a token-less row means "unknown until the next turn"),
`permission.asked|replied`, `job.updated`, `asset.created`, `asset.deleted`,
`config.updated`, `provider.updated`, `agents.updated`, `tools.updated`,
`skills.updated`, `automations.updated`, `server.hello`. Live-only events
(`config.updated`, `provider.updated`, `agents.updated`, `tools.updated`,
`skills.updated`, `automations.updated`, `server.hello`) use seq 0 and are
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
- **Interrupts cancel the in-flight provider request** (`run.ts`): the
  drain's AbortSignal rides `LlmRequest` into both adapters (SDK `signal`
  option + `stream.close()` in the finally), and `raceSignal` stops
  consuming instantly on every runtime. Whether the HTTP connection itself
  tears down is runtime behavior: **Bun ≥ 1.4.0 cancels upstream**
  (fetch-abort socket teardown, oven-sh/bun#32578) so the provider stops
  generating and billing; on 1.3.x the request lingers server-side until
  the model finishes — the stop is instant, but tokens generated after it
  may still be billed.
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
  Non-LLM media calls that bill a flat USD cost use the separate append-only
  `media_events` ledger instead (the job queue records one row per terminal
  image job — provider/model/account/mode, images, cost, duration, ok/error),
  surfaced as the Analytics page's **Image generation** card via
  `GET /api/image/usage`.
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

Adapters implemented today: **Anthropic** (`@anthropic-ai/sdk`), one
**OpenAI-compatible catch-all** (`openai` SDK, custom base URL) covering
api.openai.com, OpenRouter, Groq, Ollama, llama.cpp, LM Studio, DeepSeek,
etc., and a **Responses** adapter (`adapters/responses.ts`) serving
ChatGPT/Codex (`chatgpt.com/backend-api/codex`) and xAI. All speak tools:
Anthropic uses `tool_use`/`tool_result` content blocks with
`input_json_delta` streaming; OpenAI uses `tool_calls` accumulation and
`role:"tool"` messages; Responses uses `function_call`/`function_call_output`
input items. Vendor types stay isolated inside adapter files so SDK majors
never leak into `core`.

Model catalog = models.dev (via `@opencode-ai/models`: live fetch ⊕ bundled
offline snapshot ≤24 h behind) ⊕ user config overrides ⊕ a **curated
bai-owned overlay** (`provider/overlay.ts`) that adds providers models.dev
omits (coding plans, gateways, OAuth-only providers) and attaches
adapter/auth/header metadata. Auth via env vars, config, API-key accounts,
and **OAuth/subscription logins**.

### 10.1 OAuth / subscription logins

`core/src/provider/oauth/` is a server-side login engine: a spec per provider
(`providers/*.ts`), a generic RFC 8628 device-code runner (`device.ts`), PKCE
helpers (`pkce.ts`), single-flight token refresh (`refresh.ts`), and an
`OAuthLoginManager` that runs detached login sessions over a start/poll/
submit/cancel surface. Tokens are written to the widened `auth.json`
(`type:"oauth"` records: access/refresh/expiry/upstream id); the registry
resolves + renews them at stream time and injects provider/account headers.

Supported logins: **ChatGPT/Codex** (device-code), **Anthropic Claude
Pro/Max** (paste-code PKCE), **GitHub Copilot** (device-code + token
exchange), **xAI Grok** (OIDC discovery + device-code), **Qwen** (imports the
Qwen CLI credential file), **Nous Portal** (device-code), **MiniMax**
(user_code + PKCE), and **Vertex** (ADC / service-account via
`google-auth-library`). Device-code and paste-code flows work identically for
local and remote (`--host`) surfaces — no client-side loopback.

Login attempts are exposed at `GET /api/provider/oauth` and
`POST/GET/DELETE /api/provider/:provider/oauth/...`; web Settings and the TUI
ctrl+p wizard drive them. Custom providers are config-defined entities
(name, base URL, adapter, key env/secret, models, headers, context length)
with `PUT/DELETE /api/provider/:provider/custom`.

### 10.2 Router gateway (OpenAI-compatible)

The provider layer is extracted into the transport-free `@bai/provider` package
(adapters, registry, catalog, credentials, OAuth). Its **router SDK** —
`ModelRouter.resolve()` / `.chat()` — is the single seam that turns a
`provider/model` id + optional account into a live adapter + credentials;
core's run loop and the `@bai/router` service both use it.

`@bai/router` (`services/router`) exposes that SDK over HTTP:

- `POST /v1/chat/completions` — OpenAI chat body → bai `OutboundMessage[]` →
  `provider.stream()`; `StreamEvent`s map back to OpenAI SSE chunks (`[DONE]`
  terminated) or a single completion object.
- `GET /v1/models` — every routable `provider/model` id.
- `POST /v1/images/generations` — enqueues on the shared image job queue and
  returns base64 images.
- `GET /api/help` (HTML) + `GET /api/help/openapi.json` (OpenAPI 3.1) — only in
  `--router` mode.

**Target selection:** `model` = bai `provider/model`; the saved account rides
the `x-bai-account` header (default: `config.models.defaultAccount`, else the
first stored account / env). `/v1/*` + `/api/help` are mounted in **every**
mode via `ApiDeps.extraRoutes`, gated **live** by `config.router.enabled`
(Settings → Model Providers → **Run as router**, persisted to
`~/.config/bai/config.json`). It defaults **on**, so `bai --web` is a gateway
out of the box; toggling it off takes effect without a restart (a disabled
router 404s `router_disabled`), and the explicit `--router` flag forces it on.
The router is composed in-process against the one core — running two
independent bai processes would double-run media jobs and automations
(`JobQueue.start` / `AutomationScheduler.start` reconcile shared store state),
so `--router` combines with `--web`/`--host` rather than running beside them.

## 11. Extensibility (MCP-first)

**bai as MCP client** (`core/src/mcp`): **implemented**. External servers are
declared file-first — `~/.config/bai/mcp/<name>.{json,yaml}` (hot-reloaded,
name = filename stem, a `{ "mcpServers": { ... } }` wrapper accepted) — with
`config.json`'s `mcp` map as the programmatic layer; file-defined servers win
on name collisions. Transports: stdio (spawned subprocess, allowlisted env) and
streamable HTTP with SSE fallback; OAuth 2.1 tokens live under
`~/.local/share/bai/mcp-tokens/` (0600), never in config. Their tools merge into
the registry namespaced as `mcp/<server>/<tool>`, alongside the
`mcp/list_resources`, `mcp/read_resource`, `mcp/list_prompts`, `mcp/get_prompt`
helpers. Official SDK: `@modelcontextprotocol/client` **v2** (protocol rev
**2026-07-28**).

**MCP usage analytics** (`mcp_events`): every MCP interaction — a namespaced
server tool call or a helper call — records one append-only row (server, tool,
kind `tool|resource|prompt`, agent, session, ok/error, `duration_ms`, `bytes`,
and a SHA-256 args digest — never the raw args). Recording is best-effort in
`core/src/mcp/manager.ts` (a failed insert never breaks a tool call), mirroring
the `skill_events` precedent. `GET /api/mcp/usage` aggregates KPIs + per-server
and per-tool totals + a calls/errors series; `GET /api/mcp/server/:name/usage`
returns per-server totals (history survives server removal). The web
**Analytics** page renders an "MCP activity" card from it.

**bai as MCP server** (planned): exposes built-in tools and basic session
operations at `/mcp` (streamable HTTP, stateless mode — the v2 default),
mounted through the SDK's official **Hono adapter** (`createMcpHonoApp` +
`createMcpHandler`) and guarded by the same bearer token — so external agents
can drive bai. Tool schemas use Standard Schema (Zod v4), matching the rest of
the validation stack.

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
  "workbenches": { "image": { "adapter": "fal", "model": "flux-2" } },
  "imageGen": { "provider": "fal", "model": "fal-ai/flux/schnell" },
  "jobs": { "timeoutMs": 180000, "maxAttempts": 3, "backoffMs": 1500, "concurrency": 3 },
  "router": { "enabled": true }
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
- **Dialog model (opencode's overlay split):** the pickers + palette
  (sessions, themes, provider/model wizard, ctrl+p) render as compact
  floating overlays (`components/dialog-overlay.tsx` — absolute-positioned
  panel, ¼ from the top, width 60, list window capped to ~60% of the
  terminal) over the LIVE view: the chat stays mounted and visible behind
  (transparent backdrop — Ink has no alpha) and keeps streaming. The
  workspace-like managers (agents, skills, subagents) keep the full-screen
  render-branch swap. While an overlay is open the chat goes silent
  (`deferInput` → `useInput` `isActive` gating) — Ink delivers input to
  every mounted handler, so ungated keys would double-handle.
- **Context tracker** (leads the composer hub's commands row, pi/opencode
  parity): the session's live context usage — `45k/200k (23%)`, tone-shifted at
  70/90% of the window, `?/200k` after compaction. Data: the durable
  `run.usage` event per provider turn + the snapshot's `usage` seed
  (`meta.lastUsage`); the math is pure in `shared/src/display.ts`
  (`contextTracker`), shared verbatim with the web chip. The web chip is
  clickable: `web/src/context-modal.tsx` renders a fullness bar over the
  exact provider tokens plus the estimated per-category prompt composition
  (`SessionUsage.breakdown`, chars/4, emitted by `run.ts` and labelled `~`
  because providers report only the total). Both surfaces also show the
  cumulative estimated session cost (`SessionUsage.costUsd`) — summed from
  the usage rows' frozen per-row rates (`UsageRepo.spendForSession`), so it
  survives compaction and includes background title/compaction calls. The TUI
  has a parity panel: the supermenu's **Context Usage** opens
  `views/context-usage.tsx` — a floating overlay with the same fullness bar,
  per-category rows (the `mcp` row is the MCP tool-schema share of the
  prompt), and session cost.
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
  items), **Skills section** (`skills.tsx`), **Automations section** (nested
  sidebar list + schedule/prompt editor + run history — `automations.tsx`),
  code (file tree + diffs), image gallery, video gallery, jobs queue, settings
  (config editor), pairing screen.
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
  target, not an afterthought). The token system — self-hosted fonts (Inter +
  JetBrains Mono), the type scale, weights, spacing, radii, control heights —
  is documented in [DESIGN-SYSTEM.md](DESIGN-SYSTEM.md) and enforced by
  `packages/web/test/theme-css.test.ts`.
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
  | `/settings/{user\|general\|providers\|image\|webSearch}` | Settings subsection |
  | `/agents`, `/agents/new`, `/agents/{name}` | Agents list / create form / detail |
  | `/tools`, `/tools/new`, `/tools/{name}` | Tools (same shape) |
  | anything else | Chat draft (fallback) |

  The workspace path rides `?w=` as an opaque base64url slug
  (`wsSlug`/`wsUnslug`) — workspaces are config-listed folder paths with no
  id (`Config.workspaces: string[]`), so the path is the identity; the slug
  just keeps it out of the address bar. File tabs are ephemeral (not routed).

Serving contract (owned by `@bai/api`):

- Static hosting of `@bai/web/dist` with SPA fallback: real file → serve;
  otherwise rewrite to `/` for the client router; `/api/*`, `/mcp`, `/v1/*`,
  and `/wb/*` never fall through.
- **PWA service worker**: Workbox's `NavigationRoute` handles *every* browser
  navigation, so `vite.config.ts` sets `workbox.navigateFallbackDenylist` for
  `/api`, `/mcp`, `/v1`, `/wb` — otherwise opening `/api/help` in a browser
  serves the cached app shell and the SPA lands on chat (curl can't catch this;
  only navigations are intercepted).
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
it there. Bun ≥ 1.4 is also the recommended runtime beyond packaging: 1.4.0's
fetch-abort socket teardown (oven-sh/bun#32578) makes stopping a run cancel
the upstream provider request; on 1.3.x it lingers until the model finishes
(see the run-loop interrupt notes). Expected binary size ~60–96 MB (Bun runtime included) vs the Go
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
| **5 — Media workbenches** | Image workbench shipped (OpenRouter adapter + hardened job runtime + tag gallery); video adapter after | Prompt→job→asset→gallery round trip on phone | 🟡 image shipped; video pending |
| **6 — Desktop**           | Native shell reusing SPA + core (tech decided then)                                                                        | Feature parity with web                                                    | ⏳ pending |

(The agents + custom-tools feature set was built as part of Phase 3's
execution; its plan and research notes live in `~/thoughts/plans/` and
`~/thoughts/research/`.)

**Provider extraction + router gateway (2026-09-16):** the provider subsystem
moved from `core/src/provider/` to `packages/provider` (`@bai/provider`), and a
new `services/router` (`@bai/router`) serves an OpenAI-compatible `/v1/*`
gateway (text + image) plus `/api/help` (HTML + OpenAPI). `/v1/*` mounts in
every mode; `--router` is a modifier that adds the help page and drops the
SPA. See [§10.2](#102-router-gateway-openai-compatible) and D29.

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
| D12 | Single-user pairing-token auth                  | Matches "just me, many devices". Provider/subscription OAuth (D27) is unrelated to device accounts | Accounts/multi-user device auth |
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
| D27 | Server-side OAuth login engine + widened auth.json + curated provider overlay | Subscription/ChatGPT-style logins (device-code, paste-code PKCE, import, ADC) are first-class provider accounts, resolved and refreshed at stream time; device-code/paste-code work for remote surfaces without client loopback; the overlay closes models.dev gaps without forking the catalog | Per-client browser OAuth (breaks `--host`); hardcoding a second 39-provider list (drifts from models.dev); storing tokens in config (leaks via sync) |
| D28 | Responses API as a first-class wire adapter | ChatGPT/Codex and xAI cannot be expressed over chat.completions; one adapter serves both plus future Responses endpoints, sharing tool-name/usage/StreamEvent handling | Codex-only special path (not reusable); SDK feature flags without a wire adapter |
| D29 | Extract providers to `@bai/provider`; router gateway as a separate in-process service | The provider subsystem became a large transport-free domain (adapters, catalog, credentials, OAuth, router SDK); isolating it slims core and lets an OpenAI-compatible gateway (`@bai/router`) share the exact resolution seam (`ModelRouter`) with the run loop. A separate *process* was rejected: `boot()` reconciles shared JobQueue/AutomationScheduler state, so two cores would double-run work — `--router` composes with `--web`/`--host` instead. | Providers left in core; a second stateful daemon; per-mode bespoke gateway code |

## 18. Glossary

See §6 for domain terms. **Surface** = a UI (TUI/web/desktop/CLI). **Mode** =
an invocation style choosing which surface(s) run. **Cursor** = opaque last-seen
event sequence number used for durable replay. **Pairing** = token exchange
granting a device API access. **Workbench** = registered modality module.
