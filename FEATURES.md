# bai — Features

What each part of bai does, honestly: what ships today, how it works under
the hood, and what's next. Statuses mirror
[ARCHITECTURE.md §16](ARCHITECTURE.md#16-roadmap).

Workbenches are bai's modalities — chat, code/workspace, image, video — each
registered against the same core contract (`core/src/workbench/types.ts`).
They all share one server, one event log, one store, and the same surfaces.
The web nav groups them accordingly: **Chat, Workspace, Image, Video** (the
workbenches) above the divider, **Agents, Tools** (the agent machinery)
below it — and the same split lives in the TUI under `ctrl+a`.

---

## 💬 Chat — shipped

The conversation modality and bai's default session type.

**What you can do today**

- Multi-provider conversations: any OpenAI-compatible endpoint (OpenAI,
  OpenRouter, Groq, Ollama, LM Studio, DeepSeek, …) and Anthropic — selected
  per session (`ctrl+p` in the TUI) or globally in config
- Streaming responses with reasoning panels (thinking parts render behind a
  click-to-reveal node in both TUI and web)
- Sessions are durable: close the terminal, answer on the phone — the
  durable event log + seq cursors guarantee gap-free resume
- Auto-generated session titles (small-model refine on the first prompt; a
  concurrent rename always wins)
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
  - `fs.write` / `fs.edit` — exact-match edits with uniqueness errors,
    read-before-edit staleness guard (never clobbers a file changed on
    disk), per-path mutation queue
- **Fail-closed interactive permissions**: reads are allowed by default;
  writes/edits raise `permission.asked` to every connected surface — approve
  or deny from the TUI or the phone, first reply wins, "always" persists for
  the session
- **Token discipline** keeps long agentic sessions affordable: identical
  tool results collapse to stubs, old results prune to one-liners (the full
  transcript stays recoverable), and context auto-compacts at ~75% of the
  model's window with a structured summary

**Under the hood**

- The agentic loop lives in `core/src/run.ts` (`RunCoordinator.drainOnce`);
  the full code map is [ARCHITECTURE.md §5.1](ARCHITECTURE.md#51-code-map--where-the-important-things-live)
- History → provider messages: `core/src/run/history.ts`; the permission
  gate: `core/src/permissions/ask.ts`; discipline + compaction:
  `core/src/context/`

**Coming next**

- `bash` tool (Bun's native PTY), grep/search tools, diff viewer with
  revert, subagent spawning (`task` tool)

---

## 🤖 Agents — shipped

First-class citizens with their own nav section (web), chat-header picker
(web), and switcher dialog (`ctrl+a`, TUI): the personas that drive the
workspace.

**What you can do today**

- Markdown-defined agents: YAML frontmatter (`description`, optional model
  override, tool allow-list) + the system prompt as the body, stored in
  `~/.config/bai/agents/*.md` — name = filename stem
- **Hot-reloaded**: drop a file on disk, save from the web form, or edit via
  `$EDITOR` in the TUI — it's live everywhere in ~150 ms, no restart (the
  thing opencode makes you restart for)
- Create, edit, delete, and "use in session" from the web Agents section,
  switch or set the default from the chat-header picker (web) or the TUI
  switcher (`ctrl+a`); the built-in `build` agent always exists and can't be
  shadowed
- Optional per-agent model override; sessions fall back gracefully if a
  selected agent is deleted before the next prompt
- Default agent (`agents.default` in config): applying an agent with no
  session open — TUI switcher or web picker — persists it for every session
  that selects none; resolution order is session choice → config default →
  built-in `build`

**Under the hood**

- `core/src/agent/registry.ts` scans + `fs.watch`-es the directory
  (debounced rescan → live `agents.updated` event); schema in
  `shared/src/agents.ts`

**Coming next**

- Per-agent permission overrides beyond the tool allow-list · agent
  variables (temperature, top-p) · subagent spawning

---

## 🔧 Tools — shipped

The tool system, with its own nav section (web) and manager dialog (TUI):
built-in file tools plus user-written TypeScript tools.

**What you can do today**

- Built-ins: `fs.read`, `fs.list`, `fs.glob`, `fs.write`, `fs.edit` —
  described in Workspace above
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
  surfaces live

**Coming next**

- `bash` and grep tools as built-ins · MCP tools (`mcp/<server>/<tool>`)
  merged into the same registry

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

## Cross-cutting

- **Sync** — every feature streams through the same durable per-session
  event log; snapshot-then-stream clients (TUI, web, one-shot) resume from
  a cursor with zero replay duplication
- **Permissions** — one fail-closed engine for every tool, builtin or
  user-written; unknown tools can never execute, unmatched actions ask
- **Surfaces are thin** — nothing in the TUI or web app owns state; work
  started on one device continues on another because the server is the only
  truth
