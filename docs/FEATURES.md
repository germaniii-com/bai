# bai — Features

What each part of bai does, honestly: what ships today, how it works under
the hood, and what's next. Statuses mirror
[ARCHITECTURE.md §16](ARCHITECTURE.md#16-roadmap).

Workbenches are bai's modalities — chat, code/workspace, image, video — each
registered against the same core contract (`core/src/workbench/types.ts`).
They all share one server, one event log, one store, and the same surfaces.
The web nav groups them accordingly: **Chat, Workspace, Image, Video** (the
workbenches) above the divider, **Agents, Tools, Skills, Automations** (the
agent machinery) below it — and the same split lives in the TUI's supermenu
(`ctrl+p`).

---

## 💬 Chat — shipped

The conversation modality and bai's default session type.

**What you can do today**

- Multi-provider conversations: any OpenAI-compatible endpoint (OpenAI,
  OpenRouter, Groq, Ollama, LM Studio, DeepSeek, …), Anthropic, and the
  OpenAI Responses API (ChatGPT/Codex, xAI) — selected per session (the TUI
  supermenu) or globally in config
- **OAuth / subscription logins** from web Settings or the TUI wizard:
  ChatGPT/Codex, Anthropic Claude Pro/Max, GitHub Copilot, xAI Grok, Qwen,
  Nous Portal, MiniMax, Vertex — plus API-key accounts and config-defined
  custom providers (name, base URL, adapter, key env, models, headers,
  context length)
- Streaming responses with reasoning panels (thinking parts render behind a
  click-to-reveal node in both TUI and web)
- **Stop generating** mid-stream: double-esc in the TUI, the red stop button
  on the web — the reply stops instantly and the partial text stays in the
  transcript. On **Bun ≥ 1.4.0** the upstream provider request is cancelled
  too, so nothing past the stop is billed; on 1.3.x the provider side runs
  to completion server-side (your stop remains instant either way)
- Sessions are durable: close the terminal, answer on the phone — the
  durable event log + seq cursors guarantee gap-free resume
- Auto-generated session titles (small-model refine on the first prompt; a
  concurrent rename always wins)
- Per-message actions on user messages: **copy**, **revert** (undo the
  message, everything after it, and the file changes they made), and
  **fork** (branch the history into a new session) — see
  [Revert / Fork / Copy](#-revert--fork--copy--shipped)
- **Supermenu** (`ctrl+p` in the TUI): one searchable command palette —
  opencode-style — for everything the old ctrl+** chord family did: switch
  session/model/agent/theme, connect a provider, new session, gallery,
  settings, quit. Contextual commands float under a **Suggested** header
  (no provider connected → Connect provider; away from chat → Back to
  chat), the rest group under category headers, and typing filters across
  titles, categories, and ids
- Per-session model override, live from any surface (`config.updated` /
  `provider.updated` propagate instantly)
- **Context tracker** (pi/opencode parity): the composer hub shows the
  session's live context usage — `45k/200k (23%) $0.01` in the TUI's commands
  row, a chip on the web's composer status row — tone-shifted as the window
  fills (warning >70%, danger >90%), `?/200k` after compaction until the next
  model response. The trailing figure is the cumulative estimated session
  cost (Σ tokens × frozen per-row rates; survives compaction). One durable
  `run.usage` event per provider turn keeps every surface in sync. In the
  web, clicking the chip opens a **Context Usage** modal — a fullness bar
  over the exact provider tokens plus the estimated (`~`, chars/4)
  per-category composition of that turn's prompt (system prompt · tools ·
  skills · mcp · subagents · conversation) and a session-cost line. The TUI
  has the same panel via the supermenu (`ctrl+p` → **Context Usage**), with
  the `mcp` row highlighted as the MCP tool-schema share
- **`#file` mentions** (opencode2's completion): type `#` in the composer to
  fuzzy-search the session's workspace and insert a file reference. The
  composer shows the shortest unique leaf (`#button.tsx`, extending to
  `#components/button.tsx` only when a basename collides) and expands it to
  the full path before send, so the transcript and model still get the real
  file. Add an optional line range — `#foo.ts:10-20` (also `:10` / `:10-`);
  directories insert `#src/` and keep the picker open to drill in. In the
  web transcript the mention renders as a leaf chip — hover shows the full
  path, click opens the file in the workspace viewer (the TUI shows the leaf
  inline). Mentioned files are resolved server-side at send time and the
  requested lines are attached to the turn as read context, so the model
  sees exactly what you pointed at. Available only when the session has a
  workspace root (web: the Workspace section; the chat section has none),
  matching opencode2's project-scoped completion. `/commands` are not
  implemented yet
- **Attachments (chat only)**: the web composer's **`+`** button (beside
  Send) or a **file drag-and-drop onto the composer** uploads a local
  image/PDF/text file. Cwd-less chat sessions have no `#file` picker, so this
  is how files reach a chat prompt. Bytes are stored under
  `~/.local/share/bai/assets/attachment/` (asset table, no blobs in SQLite or
  the event stream) and lowered to native provider blocks — Anthropic
  `image`/`document`, OpenAI `image_url`/`file`; text attachments attach as
  read context (`<file>` blocks). The selected model's capability is checked
  at send (models.dev `attachment`/`modalities`), so an unsupported model or
  file type is rejected with a clear error instead of silently dropped. The
  web renders image thumbnails (click = maximized lightbox) and PDF/text
  chips. Attachments older than the newest 3 user turns are omitted from the
  provider request (transcript untouched) to bound token cost
- **Compact overlay dialogs** (TUI): the session/theme/model pickers and the
  ctrl+p supermenu float as centered panels over the live conversation —
  the transcript stays visible and streaming behind them (opencode's dialog
  model); the agent/skills/subagent managers remain full-screen
- Headless mode: `bai --one-shot "prompt" --format json` streams NDJSON and
  exits when the run goes idle

**Under the hood**

- The provider layer is deliberately thin (`core/src/provider/`): adapters
  isolate vendor SDKs and translate one neutral `LlmRequest`/`StreamEvent`
  shape; the model catalog comes from models.dev ⊕ a curated overlay ⊕ user
  config ⊕ **provider files**, and credentials are multi-account API keys or
  OAuth tokens in `auth.json` (§10.1)
- **Custom provider files** (`~/.config/bai/providers/<id>.json`, hot-reloaded)
  declare their capabilities with a required `providerType`
  (`text`/`image`/`video`), a `baseUrl`, env/headers/auth, an optional chat
  block (adapter + models) and an optional **image block** — either the
  OpenAI-images wire template or a **generic request/response mapping**
  (`$prompt`/`$model`/`$param.*` body tokens + a tiny response path syntax like
  `data[*].b64_json`). Files win over same-id config providers; built-in media
  ids are reserved. Created/edited from Settings → Model Providers (a
  "Provider Files" section) or Settings → Image Generation → Providers, and
  also plain files on disk. `providerType` decides placement: `text` shows in
  chat pickers, `image` in the image workbench, `video` is accepted but inert
  until the video adapter ships.
- Everything streams through the same event system as every other feature —
  chat is just the first consumer of the sync machinery

**Coming next**

- Gemini native adapter · MCP-fetched models · TLS overrides for custom
  providers · a `/commands` palette in the
  composer (deferred; the app-command supermenu + markdown command files are
  the planned sources)

---

## 🧑‍💻 Workspace / Code — shipped (core), growing

The coding-agent modality: sessions rooted in a real folder, driven by
agents that can actually touch the files.

**What you can do today**

- Register workspaces (folders) in the web UI or config; workspace sessions
  root there and render a read-only file tree beside the chat
- Pick an agent for the session (see Agents below) — the built-in `build`
  agent drives real tools:
  - `fs.read` — line-numbered reads with pagination hints and "did you
    mean" suggestions on a miss
  - `fs.list` / `fs.glob` — tree + pattern search with caps and refine hints
  - `fs.grep` — ripgrep-backed content search (JS fallback), 100-match cap
  - `bash` — shell commands with timeouts and head+tail output truncation
  - `fs.write` / `fs.edit` — exact-match edits with uniqueness errors,
    read-before-edit staleness guard (never clobbers a file changed on
    disk), per-path mutation queue
- **Fail-closed interactive permissions, fully surfaced**: reads are allowed
  by default; writes/edits **inside the session's working directory** are
  allowed silently (the agent is working where you pointed it); writes
  outside the cwd, bash, and web tools raise `permission.asked` to every
  connected surface — **TUI dialog** (a allow once · s allow always · d
  reject with optional feedback) and **web modal** (Allow once / Allow
  always / Reject) render the computed diff for file changes; reject
  feedback flows back to the model; first reply wins across devices;
  "always" persists for the session; asks raised before a surface connects
  arrive via the snapshot; config rules and session approvals always
  override the cwd default
- **`#file` mentions**: the composer's `#` picker is rooted at the workspace
  folder — insert `#foo.ts` (leaf display, expanded to the full path at send)
  or `#foo.ts:10-20` to hand the agent exactly those lines as read context
  (see [Chat](#-chat--shipped))
- **Drag-and-drop uploads**: drop files from the OS onto a folder in the
  file tree (or the tree root) to write them into the workspace — or use the
  **upload button beside the dotfiles toggle** to send files to the workspace
  root. The Files tab opens the upload, and the `#file` picker finds it
  immediately (collisions auto-rename `report (1).pdf`; 64 MB cap). The workspace
  composer deliberately has no attach button — files live on disk and are
  referenced with `#file`. The same `#` picker attaches a mentioned image or
  PDF to the prompt, and reads a mentioned text file as context — see
  [Chat](#-chat--shipped)
- **Session artifacts in the right rail**: below the file tree, three
  collapsible panels keep session-scoped work in view — **Checklist**
  (the `todo` tool's list, now user-editable: add/toggle/rename/remove),
  **Plans** (the `plan.write` plans; click one to open an autosaving markdown
  editor in the Files view, or hit the **hammer** to hand it to the build
  agent to implement), and **Notes** (the user's `notes.md` scratchpad, inline
  autosave). The rail is resizable and scrolls.
- **Token discipline** keeps long agentic sessions affordable: identical
  tool results collapse to stubs, old results prune to one-liners (the full
  transcript stays recoverable), and context auto-compacts at ~75% of the
  model's window with a structured summary

**Under the hood**

- The agentic loop lives in `core/src/run.ts` (`RunCoordinator.drainOnce`);
  the full code map is [ARCHITECTURE.md §5.1](ARCHITECTURE.md#51-code-map--where-the-important-things-live)
- Every run's system prompt carries an `<env>` block — working directory,
  workbench, agent, available tools, platform, date — so agents and
  subagents always know where they are (`core/src/run/env.ts`); subagents
  inherit their parent's cwd through their own session row
- History → provider messages: `core/src/run/history.ts`; the permission
  gate: `core/src/permissions/ask.ts`; discipline + compaction:
  `core/src/context/`

**Coming next**

- File-tree diff viewer (conversation-level revert with file rollback
  already shipped — see [Revert / Fork / Copy](#-revert--fork--copy--shipped))

---

## ⏪ Revert / Fork / Copy — shipped

Per-user-message transcript actions, opencode parity, on every surface.

**What you can do today**

- **Copy** — a user message's text to the clipboard: hover it in the web
  (the icon flips to a check for two seconds), or focus it in the TUI
  (ctrl+j/k) and press enter → "Copy" (OSC 52 — honored locally and over
  SSH, no subprocess)
- **Revert** — undo a user message, everything after it, and the file
  changes they made: messages from the boundary on disappear, a
  "N messages reverted" banner marks the cut, and the prompt text returns
  to the composer ready to edit & resend
  - **Two-phase, undoable**: nothing is deleted until you send the next
    message — restore from the web banner or in the TUI (enter on the
    revert banner, or open the actions modal on any user message →
    "Restore reverted messages")
  - **File rollback is real**: before every mutating tool batch (bash,
    fs.write/fs.edit, task) the worktree is recorded in a shadow git repo;
    revert checks each touched file back out of its pre-change tree
    (files the batch created are deleted). Outside a git worktree revert
    is message-only
  - Reverting while a run is active interrupts it first; the server still
    refuses mid-drain (409) and surfaces retry through the unwind window
- **Fork** — branch the conversation: a new session titled
  `<title> (fork #N)` containing everything BEFORE the chosen message,
  composer prefilled with its text so you can resend a variant (the TUI
  lands you in the new session; the web switches and seeds the draft)

**Under the hood**

- Revert state lives in `session.meta.revert` `{messageId, snapshot?, diff?}`
  — surfaces derive visibility from that one boundary marker (hidden is not
  deleted); the diff rides along for future banner rendering
- Cleanup commits the revert at the next prompt admission: the tail is
  hard-deleted and `message.removed` events drop it from every connected
  surface (the LLM history shrinks with it)
- `core/src/snapshot.ts` — one shadow git repo per worktree under
  `~/.local/share/bai/snapshot/`, object database borrowed from the project
  repo via alternates (no re-hashing), every git op serialized per gitdir;
  `core/src/revert.ts` + `Service.revertSession/unrevertSession/forkSession`;
  routes `POST /api/session/:id/revert|unrevert|fork`

**Coming next**

- Per-file restore in the reverted banner (opencode's step-forward redo) ·
  snapshot GC

---

## 🤖 Agents — shipped

First-class citizens with their own nav section (web), chat-header picker
(web), and switcher dialog (TUI supermenu): the personas that drive the
workspace.

**What you can do today**

- Markdown-defined agents: YAML frontmatter (`description`, optional model
  override, tool allow-list) + the system prompt as the body, stored in
  `~/.config/bai/agents/*.md` — name = filename stem
- **Three built-ins** (never shadowable by files):
  - `build` — the default worker: fs tools + bash + grep, permission-gated;
    can delegate work via the `task` tool
  - `plan` — planning mode: read-only exploration (`fs.read/list/glob/grep`)
    **plus live web research** (`web.search` + `web.fetch` for external docs,
    APIs, and versions the plan depends on), clarifying questions, todo
    tracking, `notes.read` for user context, and
    `plan.write`/`plan.read` (plans are stored on the session —
    `~/.local/share/bai/sessions/<sessionId>/plans/<name>.md` — and appear in
    the workspace **Plans** panel; `plan.write` is the only write surface it
    has, `plan.read` reads them back). Finishes with `plan.exit`: asks the
    user; on approval the session switches to `build` **mid-run** and keeps
    going
  - `chat` — general-purpose conversationalist with live web access
    (`web.search` + `web.fetch`)
- **Subagent spawning**: any agent can be launched as a subagent via the
  `task` tool (`build` has it in its allow-list; file agents opt in by
  adding `task` to theirs). Each call spawns a **real child session** —
  linked via `meta.parent`, titled `"<task> (@<agent> subagent)"` — that
  runs a full agentic loop with its own step budget, compaction, and tool
  allow-list, and returns its final message to the caller wrapped in a
  `<task>` block. In the **TUI** the transcript is a flat list of nodes —
  thought, **every tool call**, the reply text — each individually
  highlightable (ctrl+j/k) and clickable: any tool node expands inline to
  its output, and a task node (`▸ task <task> (@<agent>)`) opens the
  **subagent dialog** — the child's full transcript, live-refreshing while
  it works, with ←/→ cycling between multiple subagents and ↑ (at top) or
  esc to exit — with the main chat view's node interaction: ctrl+j/k
  traverses the child's nodes and space/enter expands a thought or any
  tool call's output (failed calls show their error text). A child's
  pending permission ask **pops the same dialog a
  parent ask gets** — tagged with the subagent's name — on every surface
  (TUI modal, web modal), and is also reviewable inside the subagent
  dialog; the run can never sit blocked on a dialog nobody saw. Task nodes
  show the child's live status (working / needs approval) right on the
  node. Subagent sessions stay out of the session lists on every surface —
  the dialog is the way in. The web shows an `↗ agent` chip on task nodes
  linking to the child session. Guards: nesting is capped by
  `agents.subagentDepth` (default 1 — subagents can't spawn subagents),
  children are never offered/allowed `task`, `question`, or `plan.exit`
  (they run autonomously), each spawn asks fail-closed (the dialog names
  the agent + task), and child permission asks are approved from the child
  session's view. Multiple `task` calls in one message run concurrently;
  results land in call order.
- **Hot-reloaded**: drop a file on disk, save from the web form, or edit via
  `$EDITOR` in the TUI — it's live everywhere in ~150 ms, no restart (the
  thing opencode makes you restart for); a 2 s polling safety net catches
  watcher misses
- Create, edit, delete, and "use in session" from the web Agents section,
  switch or set the default from the chat-header picker (web) or the TUI
  supermenu's Switch agent; sessions fall back gracefully if a selected agent is
  deleted before the next prompt
- Optional per-agent model override; default agent (`agents.default` in
  config): applying an agent with no session open persists it for every
  session that selects none; resolution order is session choice → config
  default → built-in `build`

**Under the hood**

- `core/src/agent/registry.ts` scans + watches the directory
  (debounced rescan + poll → live `agents.updated` event); schema in
  `shared/src/agents.ts`

**Coming next**

- Per-agent permission overrides beyond the tool allow-list · agent
  variables (temperature, top-p) · resuming a previous subagent session
  (`task_id`)

---

## 🔧 Tools — shipped

The tool system, with its own nav section (web) and manager dialog (TUI):
built-in file tools plus user-written TypeScript tools.

**What you can do today**

- Built-ins: `fs.read`, `fs.list`, `fs.glob`, `fs.grep`, `fs.write`,
  `fs.edit`, `bash`, `task` (subagent spawning — see Agents), plus the
  interaction tools:
  - `question` — the agent asks the user 1–5 multiple-choice questions
    mid-run; the run blocks until someone answers on any surface (TUI
    dialog or web modal; custom free-text always available); dismissal
    surfaces as an error result
  - `todo` — the session task list, persisted in session meta with
    `todos.updated` events; omit its `todos` argument to read the list
    (the workspace **Checklist** panel is the same list, user-editable)
  - `notes.read` / `notes.write` — the session's `notes.md` scratchpad
    (shown in the workspace **Notes** panel); read for context, write to
    update it
  - `web.fetch` — URL → markdown/text/html (opencode's fetch: UA/Accept
    negotiation, Cloudflare-challenge retry, 5 MB cap); when a direct fetch
    fails, markdown/text fall back to the MCP extract provider (Exa
    `web_fetch_exa` / Parallel `web_fetch`)
  - `web.search` — MCP-first pluggable providers: **Exa → Parallel → DDGS**
    (Exa/Parallel work keyless on their public free tiers, or keyed via
    `EXA_API_KEY` / `PARALLEL_API_KEY` for higher limits; DuckDuckGo is a
    hardened last resort with a hard timeout). 5-minute success cache; pin
    via `tools.webSearch.provider` (`auto`/`exa`/`parallel`/`ddgs`) or
    disable keyless tiers with `tools.webSearch.keylessFallback: false`.
    Configure it in **Settings → Web Search** (provider, keyless fallback,
    key-detection status)
  - `task` — **subagent spawning**: launches another agent in its own
    durable child session and returns its final message (see Agents below);
    batched `task` calls in one turn run concurrently
  - `image.generate` — **generate images**: text-to-image from a prompt, or
    image-to-image from a reference (an asset id or a workspace image file).
    Uses the Image Generation settings defaults (provider/model + default
    params/tags), enqueues a real media job and waits for it, and returns the
    generated assets (inline thumbnails in the web transcript; the TUI shows
    a count). Pass `save_to` to also write the files into the workspace
    (snapshot-covered). A batch of calls runs in parallel, bounded by
    `jobs.concurrency`. Defaults to **ask** on first use (it spends money)
- **Permission defaults**: `question`/`todo`/`plan.write`/`plan.exit`
  auto-allow (they ARE the user interaction); `web.fetch`, `web.search`,
  `bash`, `task` default to **ask** — fail-closed like everything unmatched
- **Custom tools as TypeScript files**: create from the web Tools section or
  the TUI manager, write a default export
  `{ description, schema, execute(args, ctx) }`, save — the file lands in
  `~/.config/bai/tools/` and is **hot-imported** (no restart); registration
  failures are reported instead of silently swallowed
- Built-ins are listed for reference but view-only — their source lives in
  bai itself, and custom files can never shadow them
- Tool allow-lists per agent decide who can call what; the permission gate
  covers every tool, builtin or user-written

**Under the hood**

- `core/src/tools/loader.ts` scans, validates, and dynamically imports tool
  files (Bun ignores query-param cache busting, so changed files are
  re-imported through versioned temp copies); `tools.updated` events keep
  surfaces live. The `task` tool lives in `core/src/tools/task.ts` and
  re-registers itself whenever the agent catalog changes so its description
  always lists the current agents.

**Coming next**

- Per-server tool include/exclude in the Integrations UI

---

## 🔌 Integrations (MCP) — shipped

External MCP (Model Context Protocol) servers, added **file-first** — the same
drop-in model as agents, skills, and tools.

**What you can do today**

- Add a server by dropping a file in `~/.config/bai/mcp/`: `<name>.json` (or
  `.yaml`), one server per file (the filename stem is its name), or a
  `{ "mcpServers": { ... } }` wrapper carrying several. It is **hot-reloaded**
  within ~150 ms — no restart. `${VAR}` references resolve from the shell env,
  so secrets never sit in a definition file.
- Or declare servers in `config.json`'s `mcp` map; **file-defined servers win**
  on a name collision.
- Transports: **stdio** (spawned subprocess with an allowlisted environment —
  never the full `process.env`), remote **streamable HTTP** (with automatic SSE
  fallback), and explicit **SSE** servers. Remote servers support **OAuth 2.1**;
  tokens live in `~/.local/share/bai/mcp-tokens/<server>.json` (mode 0600),
  never in config.
- A server's tools appear to the model as **`mcp/<server>/<tool>`**; resources
  and prompts ride the `mcp/list_resources`, `mcp/read_resource`,
  `mcp/list_prompts`, and `mcp/get_prompt` helpers.
- **MCP usage analytics**: every MCP call (server tool or helper) records a
  best-effort row — server, tool, kind, agent, session, success/failure,
  latency, response size, and an args digest. The web **Analytics** page's
  **MCP activity** card graphs calls/errors over time and lists per-server
  totals (calls, errors, sessions, last used), filterable by the same
  day/month/year window as the token charts.
- **Settings → Integrations** (web): a scrollable, **searchable Catalog** of
  63 vendor-hosted MCP servers grouped by category — Developer tools,
  Productivity, Communications & CRM, Analytics & data, Payments & finance,
  Media & creative, Travel & fitness, Docs & knowledge, Jobs — each row showing
  a **brand mark** (compiled from simple-icons ∪ SVG Logos, monochrome to match
  the lucide UI icons, with lucide fallbacks for the few brands neither carries)
  plus an `OAuth` / `No auth` badge and any env-var hints. One click installs
  (writing a drop-in file and starting OAuth where required; the docs servers
  are keyless). Below it, **Custom MCP Servers** — your own servers with live
  status (connected / failed / needs authorization / disabled), **add/edit**
  (stdio: command · args · env · cwd, or HTTP/SSE: url · headers · OAuth), plus
  enable/disable, retry, authorize, and remove. Authorization runs an OAuth
  2.1 flow against a local loopback callback (127.0.0.1:1455, ephemeral
  fallback) so it **completes automatically** when the browser lands — with a
  paste-the-code fallback if the callback can't be reached. Catalog entries
  already installed render a muted **Installed** button.
- Failures are isolated per server: one broken server never blocks the others,
  and the rest of bai starts immediately.

**Under the hood**

- `core/src/mcp/registry.ts` scans + watches `~/.config/bai/mcp/` (the
  `AgentRegistry` pattern: debounced `fs.watch` + poll safety net + signature
  diff), `manager.ts` reconciles live connections and merges tools,
  `transport.ts` builds stdio/HTTP/SSE transports, and `auth.ts` persists OAuth
  credentials. `mcp.updated` + `tools.updated` events keep surfaces live.
  REST: `GET /api/mcp/servers`, `GET /api/mcp/server/:name`,
  `GET /api/mcp/catalog`, `PUT/DELETE /api/mcp/server/:name`,
  `POST /api/mcp/server/:name/{enabled,reconnect,auth,auth/finish}`,
  `POST /api/mcp/catalog/:name/install`; usage analytics:
  `GET /api/mcp/usage` + `GET /api/mcp/server/:name/usage` (the
  `mcp_events` store, `store/mcp-usage.ts`).
- SDK: `@modelcontextprotocol/client` v2 (protocol rev `2026-07-28`).

**Coming next**

- The MCP **server** role: expose bai's own tools at `/mcp` (streamable HTTP,
  bearer-guarded) so external agents can drive bai
- Per-server tool include/exclude in the Integrations UI

---

## ⏰ Automations (scheduled jobs) — shipped

Named prompts that run an agent on a schedule — the web nav's **Automations**
section (its own rail item + nested sidebar with `+ New Automation` and the
list of name / schedule).

**What you can do today**

- Create an automation: name, prompt, schedule, optional agent, optional
  model override, optional workspace, enabled toggle
- Schedules: **interval** (`every 30m`, `every 2h`, `every 1d`), **daily**
  (`every day at 9am`), **weekly** (`every monday at 9am`, `weekdays at 9am`,
  `mon, wed at 9:00`) — server-local time
- **Run now** (works while paused), pause/resume, delete, and a per-automation
  **run history** (status / time / error / truncated output) that links each
  run to the Chat session it created
- Each fire creates a fresh **Chat session** (title `<name> — <timestamp>`,
  an `automation` badge in the Chat sidebar) and runs the prompt
  **unattended**: automation sessions auto-approve every tool, overriding a
  config-level `deny` for that session only
- A due fire is **skipped** while the previous run is still in flight (no
  pile-up); missed fires while bai was down run once on the next tick and
  reschedule; runs interrupted by a crash are marked `error` on boot

**Under the hood**

- `core/src/automations/scheduler.ts` — a 30s `unref`'d ticker with a due
  scan (`automations(enabled, next_run_at)` index), a per-automation in-flight
  guard, boot recovery, and CRUD that broadcasts live `automations.updated`
- `shared/src/automations.ts` — one pure source of truth for schedule parsing,
  display, and next-run math (shared by core and web)
- Run sessions are stamped `meta.autoApprove` + `meta.automationId/Name`;
  `PermissionGate` appends a final `{ "*": "allow" }` layer for them
- `automations` + `automation_runs` tables (migration 007), REST at
  `/api/automation*`, `automation.list` + `automation.save` agent tools
  (`save` is fail-closed — it can schedule unattended runs)

**Coming next**

- TUI surface · raw cron expressions · external delivery channels

---

## 🖼️ Image generation — shipped

The image modality is a **single-page web workbench**: pick a workflow
(Text to Image / Image to Image), tune the model's parameters, generate, and
browse a tag-searchable gallery. Images are standalone, self-describing assets
— no session or batch container.

**What you can do today**

- **Text to Image and Image to Image.** Image-to-image takes a reference image
  (drop or pick — **PNG, JPG, GIF, or WebP, up to 10 MB**; uploaded once,
  stored as an asset, lowered to the provider's `input_references` data URL).
- **Multi-provider.** `imageGen.provider` picks an adapter from a
  data-driven registry. The Image page shows a single **model** picker that
  aggregates the models of every provider you've connected (provider selection
  lives in **Settings → Image Generation**, where keys are saved); when nothing
  is connected it falls back to the offline **stub**. Shipped adapters:
  **OpenRouter**, **OpenAI Images**, **Google Gemini (Nano Banana)**,
  **xAI Grok Imagine**, **Together AI**, **DeepInfra**, **Recraft**,
  **Black Forest Labs (FLUX)**, **fal.ai**, **Replicate**, **Stability AI**,
  **Ideogram**, and **MiniMax Image** — across sync JSON, multipart, Google
  Interactions, and async submit→poll transports. `imageGen.model` picks the
  model; per-provider model lists are curated but the pickers are **creatable**
  so any id can be typed. Any other/unset provider uses the deterministic
  **stub** adapter — the workbench works offline with no keys. Keys are saved
  from **Settings → Image Generation**, in a **Providers** card above the
  defaults (covering image-only vendors like fal/BFL that don't appear in Model
  Providers), and listed there as `Provider — account` rows with a
  **copy-to-clipboard** and a **delete** action (stored API keys only; OAuth
  tokens and env keys are never revealed). They can also come from env (`OPENAI_API_KEY`,
  `GEMINI_API_KEY`, `BFL_API_KEY`, `FAL_KEY`, `REPLICATE_API_TOKEN`,
  `STABILITY_API_KEY`, `IDEOGRAM_API_KEY`, `RECRAFT_API_TOKEN`,
  `MINIMAX_API_KEY`, …), saved accounts, or `config.providers.<id>.apiKeyEnv`.
- **Cost where the provider reports it.** Adapters surface the provider's own
  USD cost when available (OpenRouter `usage.cost`, xAI `cost_in_usd_ticks`);
  others leave cost blank rather than guessing. Slow async models
  (BFL/fal/Replicate) must finish within `config.jobs.timeoutMs` — raise it
  from the default 180 s for heavy jobs.
- **Settings → Image Generation** opens with a **Providers** card (API keys),
  then owns the image workbench defaults (provider · account · model ·
  **default parameters and tags** — the param controls come from the selected
  model's spec) and the media job limits: **concurrent generations** (1–10),
  timeout, retry attempts, and backoff (config `jobs`). The agent
  `image.generate` tool and the page both fall back to these.
- **Capability-driven params.** Every adapter declares its parameter
  vocabulary (enum pickers, toggles, ranges with min/max, numbers, text); the
  page renders them generically. OpenRouter exposes aspect ratio, resolution,
  quality, output format, background, compression, seed, count, and provider
  fallbacks; OpenAI size/quality/background/format; Gemini aspect ratio +
  1K/2K/4K; FLUX width/height/seed; and so on — so a new provider is data,
  not UI work.
- **Tags + gallery.** Tags applied to a batch are normalized and indexed;
  the gallery's tag search is **fuzzy** — every whitespace token must match
  (prefix, substring, or subsequence), so `gemini` (or even `g3p`) finds a
  `gemini 3 pro` tag — and tag autocomplete ranks the same way. The prompt is
  searchable by **loading** an image's inputs (see below) — there is
  deliberately no prompt text search.
- **Reusable history.** Every image carries its full generation request
  (`meta.gen`). Each card's floating **`…`** menu offers **Download / Load
  Inputs / Edit Tags / Delete** — and **Open chat** when the image was produced
  by an agent/skill run (the job's session is stamped onto the asset, so the
  menu deep-links back to the originating chat; Image-page generations have no
  session and show no such action). Load Inputs repopulates the workflow,
  prompt, tags, params, model, and reference in the form, and Edit Tags rewrites
  the image's tags in place (index + recipe); clicking the image itself always
  opens the expanded modal. **Generate always creates a new image**, never
  mutates history.
- **One output view.** The gallery *is* the output area (no duplicate batch
  panel): a click on **Generate** immediately adds a placeholder card
  (spinning `LoaderCircle` + "Generating…") that becomes the images as they
  land; a failed job shows an **X + "Failed"** card whose **`…`** menu offers
  **Retry** (clicking the card opens a modal with the full error). Generate
  stays clickable while a job runs, so several generations
  with **different prompts** run in parallel (up to `jobs.concurrency`). The
  gallery is the full searchable history; job **retry/cancel** also sit beside
  Generate.
- **Live** via `job.updated` / `asset.created` / `asset.deleted` — progress,
  new images, and deletions appear on every connected surface.

**Under the hood**

- `core/src/workbench/media/` — the adapter seam (`MediaGenAdapter`),
  `registry.ts` (specs → adapters), `http.ts` (JSON/multipart + async-poll
  helpers), one file per vendor that speaks its wire shape
  (`openrouter.ts`, `openai-images.ts` + `openai/xai/together/deepinfra/recraft.ts`,
  `gemini.ts`, `bfl.ts`, `fal.ts`, `replicate.ts`,
  `stability.ts`, `ideogram.ts`, `minimax.ts`), plus `stub.ts` and
  `dimensions.ts` (image-header size parsing for the card's `1920×1080`).
  `core/src/media-providers.ts` is the shared spec table (id/label/base URL/env)
  consumed by the curated provider overlay. `core/src/workbench/image.ts` owns
  the job executor and stamps each asset's recipe/metadata. **No vendor SDKs** —
  adapters call provider REST APIs directly through `fetch`/`FormData`.
- **Hardened job runtime** (`core/src/jobs/queue.ts`): boot recovery for
  interrupted jobs, a per-job timeout (a hung provider never blocks the
  queue), **parallel execution** up to `jobs.concurrency` (default 3), bounded
  retries with abortable backoff and persisted `attempt`/`note`, abort
  re-checks (cancelled jobs never persist assets), graceful `stop()` on
  shutdown, and atomic asset writes. Limits live in `config.jobs`
  (`timeoutMs` / `maxAttempts` / `backoffMs` / `concurrency`).
- Routes: `POST /api/image/generate`, `GET /api/image/{providers,capabilities,
  gallery,tags,recent,usage}`, `DELETE /api/asset/:id`, `PUT /api/asset/:id/tags`,
  `POST /api/job/:id/{cancel,retry}`.
  Assets live under `~/.local/share/bai/assets/image/`; tags in the
  `asset_tags` index. Every terminal job records one append-only
  `media_events` row (provider/model/account/mode, images, cost, duration,
  ok/error) that feeds the Analytics page's **Image generation** card.
- The web page is `packages/web/src/image.tsx` (single page, no nested
  sidebar); the router exposes `/image`.

**Coming next**

- Streaming partial images · provider-side async result storage (fal
  image-to-image uploads)

---

## 🎬 Video generation — shipped

The video modality is a **workflow-driven single-page web workbench**. Unlike
images, video is task-verb driven: pick a workflow (`t2v`, `i2v`, `flf2v`,
`ref2v`, `v2v`, `extend`, `upscale`, `motion`, `lipsync`, `reframe`), attach
its **role-tagged** inputs (first/last frame, reference images/videos/audio,
source video), tune the params, and generate. Workflows and input roles come
from each adapter's declarative capabilities, so a new provider is data — not
UI work.

**What you can do today**

- **Ten workflows.** Text to video; image to video (first frame); first + last
  frame; reference-to-video; video-to-video edit; extend; upscale/enhance;
  motion control; lip-sync/avatar; reframe.
- **Role-tagged references.** Each workflow declares its input slots
  (`first_frame`, `last_frame`, `reference_image`, `reference_video`,
  `reference_audio`, `source_video`). A slot accepts a **stored bai asset**
  (picked from any gallery, any kind), an **upload**, or a **hosted URL** — so
  a generated video can seed a later extend/v2v/upscale job.
- **Multi-provider.** `videoGen.provider` picks an adapter from a data-driven
  registry. The Video page shows one **model** picker aggregating every
  connected provider's models, filtered to the workflows each model supports;
  with nothing connected it falls back to the offline **stub** (which
  advertises every workflow). Shipped adapters: **OpenRouter**, **fal.ai**,
  **Replicate**, **Google Veo 3.1 (Gemini API)**, **Runway**, **Kuaishou
  Kling**, **Luma (Agents)**, **MiniMax Video**, **Alibaba Wan**, and
  **ByteDance Seedance**. Keys live in **Settings → Video Generation** (the
  same Providers card as images), or env (`OPENROUTER_API_KEY`, `FAL_KEY`,
  `REPLICATE_API_TOKEN`, `GEMINI_API_KEY`, `RUNWAYML_API_SECRET`,
  `KLING_API_KEY`, `LUMA_API_KEY`, `MINIMAX_API_KEY`, `DASHSCOPE_API_KEY`,
  `ARK_API_KEY`).
- **Honest workflow coverage.** Adapters advertise only the workflows they can
  serve with local bytes and throw a clear error otherwise. Inline
  base64/data-URI inputs work for Gemini Veo, Runway, Kling, MiniMax, Wan, and
  Seedance; fal/Replicate upload through the vendor's storage API; OpenRouter is
  HTTPS-URL-only (its reference inputs accept a pasted URL, not an uploaded
  asset). i2v/flf2v/ref2v are available wherever the vendor accepts inline
  bytes; URL-only paths (e.g. Luma's legacy Dream Machine) are not used.
- **Still posters; the modal plays the clip.** The job queue extracts the first
  frame of every produced video with ffmpeg (the bundled `ffmpeg-static` binary;
  override with `FFMPEG_PATH`, or a system `ffmpeg`) into a JPEG beside the
  file, served at `GET /api/asset/:id/poster`. Gallery cards render that still —
  **no `<video>` element in the grid** — and the clip plays only in the expanded
  modal. Posters are best-effort: without an ffmpeg the asset simply has none.
- **Reusable history.** Every video carries its full request (`meta.gen` plus
  `durationSeconds`/`width`/`height`), so a gallery card's `…` menu can Load
  Inputs (repopulate the workflow/slots/params) — Generate always enqueues a NEW
  job. The gallery is fuzzy tag-searchable; the expanded view plays the clip.
- **Longer job budget.** Video renders run minutes, so `video.generate` uses
  `config.jobs.videoTimeoutMs` (default 900 s) — images keep `jobs.timeoutMs`
  (180 s). Both are editable in Settings.
- **Live** via `job.updated` / `asset.created` / `asset.deleted`, and a
  **Video generation** card on Analytics (a `kind='video'` slice of the
  `media_events` ledger).

**Under the hood**

- `core/src/workbench/media/video-*` — the video seam (`VideoGenAdapter`,
  workflow/role vocabulary, registry, container probe, upload helpers) and one
  file per vendor under `video/`. `core/src/workbench/video.ts` owns the
  workflow-aware job executor and stamps each asset's recipe/metadata. Routes:
  `POST /api/video/generate`, `GET /api/video/{providers,capabilities,gallery,
  tags,recent,usage}`. Assets live under `~/.local/share/bai/assets/video/`.
  The web page is `packages/web/src/video.tsx`; the router exposes `/video`.

**Coming next**

- Per-model workflow field mapping refinements · generated posters/thumbnails ·
  enrolled reference assets (Kling Elements) · C2PA provenance metadata

---

## 🔤 Design system — shipped

The web surface's visual language as a small set of tokens: self-hosted
fonts, one type scale, one weight scale, and shared spacing/radii/control
heights. Full reference in [DESIGN-SYSTEM.md](DESIGN-SYSTEM.md).

**What you can do today**

- **Self-hosted fonts, offline-capable**: **Inter** for the UI and
  **JetBrains Mono** for code, Monaco, and the web shell — bundled as woff2
  in the app (no CDN, no Google Fonts), so the PWA renders correctly with no
  network. Only the latin + latin-ext subsets ship (≈190 KB total)
- **One type scale** (`--text-xs` 11px → `--text-xl` 20px) and **one weight
  scale** (400/500/600/700) — every size and weight in the stylesheet is a
  token; there is no sub-11px tier
- **Monaco with ligatures**: the editor uses JetBrains Mono at the shared
  code size with programming ligatures on; the web shell uses the same family
  (ligatures off — xterm needs an addon)
- **Consistent controls**: buttons and inputs share one height per size, and
  every control meets the 44px touch target on coarse pointers

**Under the hood**

- Tokens live in `packages/web/src/styles.css` (`:root`); `@font-face` rules
  in `fonts.css`; Monaco/xterm font config in `editor-font.ts`
- `packages/web/test/theme-css.test.ts` enforces the contract: the font
  tokens exist, they lead with the self-hosted families, and no raw
  `font-size: <n>px` or `font-weight: <n>` appears outside `:root`
- The TUI is terminal-native — fonts come from the user's terminal emulator,
  so only an OS-level install affects it; server-rendered pages (the "web UI
  not built" hint, OAuth/MCP callbacks) name Inter with a system fallback

---

## 🎨 Themes — shipped

One theme everywhere: 24 built-ins, a live-preview picker on every surface,
and user-defined themes as plain JSON files.

**What you can do today**

- **24 built-in themes** — Light, Dark, the four Catppuccin flavors, Dracula,
  Nord, Solarized (light/dark), One Dark Pro, GitHub (light/dark), Gruvbox
  (light/dark), Tokyo Night, Monokai, Ayu (light/dark), Everforest
  (light/dark), Kanagawa, and Rose Pine (plus Dawn) — the same catalog as
  germaniii.com, plus a per-theme `warning` color both surfaces need
- **One theme everywhere, synced live**: the selection is `config.theme` —
  pick it on the phone and the terminal recolors within a heartbeat
  (`config.updated`), and vice versa. Unknown ids (a deleted custom theme,
  a newer build's theme) fall back to Dark
- **Web selector**: the palette button in the master rail (or Settings →
  General → Theme) opens a grid of preview cards — each card is a
  self-contained miniature of its theme (hardcoded from that theme's own
  palette, not the active one), with swatches, the theme name, and a type
  sample; esc or click-outside dismisses
- **TUI picker**: a type-to-filter list (the supermenu's Switch theme) where
  moving the cursor
  **live-previews** the highlighted theme across the whole app — esc
  restores the previous theme, enter persists it (opencode's picker
  semantics). The composer hub's commands row points at the supermenu
- **Custom themes**: the "+ Custom Theme" card in the web selector opens a
  form (name + the 12 palette colors, prefilled from the active theme) and
  saves to `~/.config/bai/themes/<name>.json` — the file stem becomes the
  theme id. Hand-written JSON works too (same shape; the light/dark mode is
  derived from the surface color's luminance); both surfaces list custom
  themes after the built-ins and apply them like any other theme
- **No flash on boot**: the web caches the selection in `localStorage` and
  an inline script applies it before the bundle loads; the server config
  remains the source of truth

**Under the hood**

- The catalog is shared data (`shared/src/themes.ts`) — the web's
  `[data-theme]` CSS blocks are pinned to it by a unit test, and the TUI
  resolves the same palettes to Ink colors. The TUI paints the theme's
  surface across the whole terminal (opencode's
  `renderer.setBackgroundColor` parity), so a theme looks identical
  everywhere instead of blending with the terminal's own palette
- Custom themes ride `GET/PUT/DELETE /api/theme/custom`
  (`api/src/server/themes.ts`, atomic writes, strict filename-slug ids);
  the web applies them as inline CSS variables (no static CSS block
  needed), the TUI registers them into its palette resolver
- Deleting a custom theme: the trash icon is a future nicety — for now
  remove the file (or `DELETE /api/theme/custom/:id`); a config pointing at
  a missing theme falls back to Dark

**Coming next**

- Delete/edit affordances for custom themes in the picker · a TUI custom
  theme editor · theme hot-reload on file change (pickers fetch on open
  today)

---

## 🖥️ Shell (web terminal) — shipped

A real terminal in the browser: the Shell item in the web nav (between Theme
and Settings) opens a persistent interactive bash on the server machine.

**What you can do today**

- **Persistent shell sessions**: one bash per browser connection — `cd`,
  env vars, and shell state persist across commands; navigating away or
  refreshing ends the session, and reconnecting spawns a fresh one
- **Full terminal semantics**: the server bridges the shell through a real
  PTY (a tiny python3 `pty.fork` select-loop — no native modules, so the
  single-executable build is unaffected), so line editing, ANSI colors,
  tab completion, and ctrl-c all work; the client renders with xterm.js,
  themed from the active bai palette
- **Auth stance**: loopback binds (`bai --web`) open the shell directly;
  beyond loopback (`bai --host`) the WebSocket upgrade requires the pairing
  token as `?token=` (browser WebSockets cannot set Authorization headers),
  compared constant-time — no token configured → the shell is refused
  (fail closed), and the pane explains why
- Deep-linkable at `/shell`; the pane shows connection status and
  auto-reconnects with backoff if the server drops

**Under the hood**

- `api/src/server/shell.ts`: the PTY bridge + `ShellSession` (one
  `Bun.spawn` per connection; stdin EOF and SIGTERM both tear the shell
  down — no orphans) and the Bun `websocket` handlers
- The WS upgrade is intercepted in the web mode's fetch wrapper
  (`cli/src/modes/web.ts`) before Hono — Bun's `server.upgrade()` is only
  reachable there; `GET /api/shell` is the capability probe the UI uses
- Terminal resize rides a 6-byte binary control packet (NUL+0xFF magic —
  a pair terminal input never starts with) through the bridge, which sets
  the pty size via `TIOCSWINSZ`; the kernel SIGWINCHs the running programs
- Fallbacks: no python3 on Linux → `script(1)` bridges the PTY; no bridge
  at all → bare pipes (the shell works, minus echo/colors/interrupt/resize)

**Coming next**

- Shell output scrollback persistence across reconnects

---

## Cross-cutting

- **Sync** — every feature streams through the same durable per-session
  event log; snapshot-then-stream clients (TUI, web, one-shot) resume from
  a cursor with zero replay duplication; pending permission asks and
  question blocks ride the snapshot too, so a surface opened mid-ask
  renders the dialog immediately
- **Themes** — one `config.theme` for every surface, switched live from the
  web's preview-card selector or the TUI's live-preview theme picker; 24
  built-ins plus user-defined themes as `~/.config/bai/themes/*.json` (see
  [Themes](#-themes--shipped))
- **Permissions** — one fail-closed engine for every tool, builtin or
  user-written; unknown tools can never execute, unmatched actions ask;
  asks carry computed diffs; rejections carry user feedback back to the
  model; an interrupted run cancels its pending asks (the run can never
  hang on a dialog nobody answers — esc/ctrl+c always get you out)
- **Surfaces are thin** — nothing in the TUI or web app owns state; work
  started on one device continues on another because the server is the only
  truth
- **Usage analytics** — every LLM call (agent runs, title generation,
  compaction) records a kind-tagged row with token counts (prompt /
  reasoning / completion, cache reads/writes) and a per-row rate snapshot;
  dollars are computed at fetch time so history stays correct when catalog
  prices change. Failed calls record the provider error, so the web
  **Analytics** page (rail item under Tools) can graph errors alongside
  volume: total spend, tokens, requests, cache hit rate, blended $/1M,
  per-model usage tables + charts, request volume, token breakdown,
  prompt-caching bars, and an error graph — filterable per agent, workspace,
  provider, and account with day/month/year granularity (D26; enforced by a
  source-scan test). Companion activity cards cover **skill** (`skills.view`),
  **MCP** interactions (server tools + resource/prompt helpers), and **image
  generation** (terminal image jobs — requests, images, spend, avg $/image,
  errors, duration, per-model + per-workflow totals) over the same window.
