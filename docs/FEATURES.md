# bai — Features

What each part of bai does, honestly: what ships today, how it works under
the hood, and what's next. Statuses mirror
[ARCHITECTURE.md §16](ARCHITECTURE.md#16-roadmap).

Workbenches are bai's modalities — chat, code/workspace, image, video — each
registered against the same core contract (`core/src/workbench/types.ts`).
They all share one server, one event log, one store, and the same surfaces.
The web nav groups them accordingly: **Chat, Workspace, Image, Video** (the
workbenches) above the divider, **Agents, Tools** (the agent machinery)
below it — and the same split lives in the TUI's supermenu (`ctrl+p`).

---

## 💬 Chat — shipped

The conversation modality and bai's default session type.

**What you can do today**

- Multi-provider conversations: any OpenAI-compatible endpoint (OpenAI,
  OpenRouter, Groq, Ollama, LM Studio, DeepSeek, …) and Anthropic — selected
  per session (the TUI supermenu) or globally in config
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
- Headless mode: `bai --one-shot "prompt" --format json` streams NDJSON and
  exits when the run goes idle

**Under the hood**

- The provider layer is deliberately thin (`core/src/provider/`): adapters
  isolate vendor SDKs and translate one neutral `LlmRequest`/`StreamEvent`
  shape; the model catalog comes from models.dev ⊕ user config
- Everything streams through the same event system as every other feature —
  chat is just the first consumer of the sync machinery

**Coming next**

- Gemini native adapter · MCP-fetched models · attachment/file parts in chat

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
  - `plan` — planning mode: read-only exploration (`fs.read/list/glob/grep`),
    clarifying questions, todo tracking, and `plan.write` (plans land in
    `~/.config/bai/plans/<name>.md` — the only write surface it has).
    Finishes with `plan.exit`: asks the user; on approval the session
    switches to `build` **mid-run** and keeps going
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
    `todos.updated` events
  - `web.fetch` — URL → markdown/text/html (opencode's fetch: UA/Accept
    negotiation, Cloudflare-challenge retry, 5 MB cap)
  - `web.search` — pluggable providers; **DDGS keyless default**
    (DuckDuckGo, no API key) with automatic Exa fallback when
    `EXA_API_KEY` is set; pin via `tools.webSearch.provider` in config
  - `task` — **subagent spawning**: launches another agent in its own
    durable child session and returns its final message (see Agents below);
    batched `task` calls in one turn run concurrently
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

- MCP tools (`mcp/<server>/<tool>`) merged into the same registry

---

## 🖼️ Image generation — structured stub

The image modality exists end-to-end as plumbing today; the generation
adapter is the missing piece.

**What exists today**

- The workbench registers job types (`image.generate`), asset kinds, and
  HTTP routes against the core contract
- The job queue persists, tracks status/progress, and produces **assets**
  (stored under `~/.local/share/bai/assets/`, indexed in SQLite, served via
  `GET /api/asset/:id/content`)
- The event system is wired for `job.updated` / `asset.created` — galleries
  and the TUI/web views will light up the moment a real adapter lands

**What you'll see in the UI today**

- The rail marks Image as "soon" (the TUI placeholder and disabled web nav
  item are deliberate honesty, not missing polish)

**Coming next**

- fal.ai adapter first (config: `workbenches.image.adapter`), then a
  prompt→job→asset→gallery round trip on the phone

---

## 🎬 Video generation — structured stub

Identical shape to image, second in line.

**What exists today**

- Same structured plumbing: `video.generate` job kind, asset pipeline,
  gallery routes, event wiring — all proven by the shared queue and store
  contracts (bai's "structured stubs day one" principle, D9)

**Coming next**

- Adapter after image ships; longer job durations shape the queue UX
  (progress, cancellation, partial results) first

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
  source-scan test)
