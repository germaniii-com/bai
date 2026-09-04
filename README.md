<div align="center">

```
██████╗  █████╗  ██╗
██╔══██╗ ██╔══██╗ ██║
██████╔╝ ███████║ ██║
██╔══██╗ ██╔══██║ ██║
██████╔╝ ██║  ██║ ██║
╚═════╝  ╚═╝  ╚═╝ ╚═╝
```

# bai — _beyond automated interaction_

**One runtime. Every surface. Every modality.**

_bai_ friend. And **B**eyond **A**utomated **I**nteraction — an AI
workspace that works _with_ you, not at you: start a session in the terminal,
continue it from your phone, teach it new agents from either side.

</div>

`bai` is an all-in-one AI workspace as a single Bun executable:

- 💬 **Chat** — multi-provider conversations (OpenAI-compatible endpoints and
  Anthropic today; Gemini planned) with streaming, reasoning panels, and
  session titles
- 🧑‍💻 **Workspace / Code** — file-defined **agents** (hot-reloaded, no
  restarts) driving real tool loops: `fs.read/list/glob/write/edit`,
  fail-closed interactive permissions, token discipline, and compaction
- 🖼️ **Image / 🎬 Video workbenches** — structured today (job queue, asset
  store, galleries); real adapters land next
- 🖥️ **Surfaces** — Ink TUI, web app for desktop _and_ mobile (browser/PWA),
  native desktop shell later
- 🔌 **Extensible** — custom tools as TypeScript files (hot-imported), MCP as
  client and server (planned)

See [FEATURES.md](FEATURES.md) for what each workbench does today, and
[ARCHITECTURE.md](ARCHITECTURE.md) for the full design, code map, decision
log, and roadmap.

```bash
bai                      # TUI (default)
bai --code               # same, explicit
bai --web --open         # serve API + web UI on loopback, open browser
bai --host               # bind beyond loopback; pairing token for phone
bai --one-shot "summarize this repo" --format json   # headless NDJSON run
```

## Status

Implemented through the code-workbench phase — **chat, sync, agents, file
tools + bash/grep, interactive permissions, token discipline + compaction,
and per-message revert/fork/copy with shadow-repo file rollback all ship
today** (483 tests, 6 packages). Pending: MCP dual role, real image/video
adapters, desktop shell. Details in
[ARCHITECTURE.md §16](ARCHITECTURE.md#16-roadmap).

## Inspiration

bai's design borrows deliberately from the best agent codebases studied
during its build — keeping what works and fixing what doesn't:

- [**opencode**](https://github.com/sst/opencode) — the server-first
  architecture (thin surfaces over one stateful core), the durable
  event-log + cursor-replay sync model, and the markdown-file agent
  convention. bai additionally **hot-reloads** agents and tools
  (opencode requires a restart) and keeps its agent definitions out of
  `opencode.json`-style config blobs.
- [**pi**](https://github.com/badlogic/pi-mono) — the minimal two-level
  agent loop, truncation-with-continuation-hints on every tool output,
  per-turn system-prompt/toolset refreshes, the fail-on-truncated-arguments
  guard, and the structured compaction summary (verbatim tail, never
  orphaning a tool result).
- [**hermes-agent**](https://github.com/NousResearch/hermes-agent) — the
  token-economy ideas: deterministic no-LLM pruning of old tool results,
  identical-result stubbing, spill-to-disk with recovery pointers, and the
  insight that context reclamation should never thrash the provider prompt
  cache.
- [**opencode (Go predecessor)**](https://github.com/sst/opencode) — the
  53-line read-before-edit staleness guard, exact-match edit semantics with
  distinct not-found/ambiguous errors, blocking permission service with
  path-scoped grants, and compaction via a simple summary pointer.

The full research notes live in
`~/thoughts/research/2026-09-02_bai-ts-agents-dynamic-tools.md`.

## Repository layout

```
bai-ts/
├── ARCHITECTURE.md            ← design, code map, decisions, roadmap
├── FEATURES.md                ← what each workbench does today
├── packages/
│   ├── shared/                domain types & contracts (leaf)        @bai/shared
│   ├── core/                  sessions, runs, agents, tools, perms   @bai/core
│   │   └── src/                 store · event · config · provider · agent/
│   │                            tools/ · context/ · permissions/ · workbench/
│   │                            run.ts (the agentic loop)
│   │                            snapshot.ts + revert.ts (revert/fork file rollback)
│   ├── api/                   Hono server + typed client             @bai/api
│   ├── cli/                   entrypoint wiring & mode dispatch      @bai/cli
│   ├── tui/                   Ink terminal surface                   @bai/tui
│   ├── web/                   React + Vite SPA / PWA                 @bai/web
│   └── desktop/               native shell (stub)                    @bai/desktop
```

Every package directory carries its own README explaining responsibilities,
boundaries, and planned key types. User-owned files live outside the repo:
`~/.config/bai/config.json`, `~/.config/bai/agents/*.md`,
`~/.config/bai/tools/*.ts`, `~/.local/share/bai/` (DB, assets, tmp).

## Development

```sh
make build        # single executable → dist/bai (SPA embedded/staged)
make run          # build and start the TUI
make test         # bun test across workspaces
make vet          # tsc --noEmit per package
make tidy         # bun install
make web-build    # vite build → packages/web/dist
make release      # cross-compile all 8 targets → dist/
make clean        # remove dist/
```

Or without make: `bun install` · `bun test` · `bun run typecheck` · `bun run compile`.

Requires Bun >= 1.3.14 (1.4+ recommended — its `--compile` embeds the SPA
directly into the binary; on 1.3.x `make build` stages it to `dist/web`
beside the binary instead).

## License

MIT — see [LICENSE.md](LICENSE.md).
