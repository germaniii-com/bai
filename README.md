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

- 💬 **Chat** — multi-provider conversations (OpenAI-compatible, Anthropic
  Messages, and the OpenAI Responses API serving ChatGPT/Codex) with
  streaming, reasoning panels, and session titles
- 🔐 **Providers** — multi-account API keys plus **OAuth/subscription logins**
  (ChatGPT/Codex, Anthropic Claude Pro/Max, GitHub Copilot, xAI Grok, Qwen,
  Nous Portal, MiniMax, Vertex), a curated catalog overlay, config-defined
  **custom providers**, and hot-reloaded **provider files**
  (`~/.config/bai/providers/*.json`) declaring `text`/`image`/`video`
  capabilities — from web Settings or the TUI wizard
- 🧑‍💻 **Workspace / Code** — file-defined **agents** (hot-reloaded, no
  restarts) driving real tool loops: `fs.read/list/glob/write/edit`,
  fail-closed interactive permissions, token discipline, and compaction
- 🖼️ **Image workbench** — a single-page text-to-image / image-to-image
  workspace over **many providers** (OpenRouter, OpenAI, Google Gemini/Gemini
  Nano Banana, xAI, Together, DeepInfra, Recraft, Black Forest Labs, fal.ai,
  Replicate, Stability, Ideogram, MiniMax) with capability-driven params,
  reusable tagged history, per-image delete, and job retry/cancel; 🎬 video is
  still a structured stub
- 🖥️ **Surfaces** — Ink TUI, web app for desktop _and_ mobile (browser/PWA),
  native desktop shell later
- 🔌 **Extensible** — custom tools as TypeScript files (hot-imported), MCP
  both ways: bai consumes external MCP servers **and** serves its own tools,
  skills, and sessions at `/mcp` (plus a `bai mcp` stdio bridge)

See [FEATURES.md](FEATURES.md) for what each workbench does today, and
[ARCHITECTURE.md](ARCHITECTURE.md) for the full design, code map, decision
log, and roadmap.

```bash
bai                      # TUI (default)
bai --code               # same, explicit
bai --web --open         # serve API + web UI + router gateway on loopback, open browser
bai --host               # bind beyond loopback; pairing token for phone
bai --router             # headless OpenAI-compatible gateway + /api/help
bai --web --router       # web UI + gateway + /api/help, one process
bai --web --mcp          # web UI + bai as an MCP server at /mcp
bai mcp                  # stdio MCP bridge to a running bai (Claude Desktop…)
bai --one-shot "summarize this repo" --format json   # headless NDJSON run
```

## Status

Implemented through the media-workbench phase — **chat, sync, agents, file
tools + bash/grep, interactive permissions, token discipline + compaction,
per-message revert/fork/copy with shadow-repo file rollback, provider
OAuth/subscription logins, the multi-provider image workbench (13 adapters
+ hardened job runtime + tag gallery), the extracted `@bai/provider` +
`@bai/router` OpenAI-compatible gateway, and **MCP both ways** (external
servers as plugins + bai's own tools/skills/sessions at `/mcp` with the
`bai mcp` stdio bridge) all ship today** (9 packages/services). Pending: the
video adapter, desktop shell. Details in
[ARCHITECTURE.md §16](docs/ARCHITECTURE.md#16-roadmap).

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
│   ├── provider/              adapters, catalog, credentials, OAuth  @bai/provider
│   │   └── src/router.ts        the router SDK (`ModelRouter`)
│   ├── core/                  sessions, runs, agents, tools, perms   @bai/core
│   │   └── src/                 store · event · config · agent/
│   │                            tools/ · context/ · permissions/ · workbench/
│   │                            run.ts (the agentic loop)
│   │                            snapshot.ts + revert.ts (revert/fork file rollback)
│   ├── api/                   Hono server + typed client             @bai/api
│   ├── cli/                   entrypoint wiring & mode dispatch      @bai/cli
│   ├── tui/                   Ink terminal surface                   @bai/tui
│   ├── web/                   React + Vite SPA / PWA                 @bai/web
│   └── desktop/               native shell (stub)                    @bai/desktop
└── services/
    ├── router/                OpenAI-compatible gateway + /api/help  @bai/router
    └── mcp/                   bai as an MCP server (/mcp + stdio bridge) @bai/mcp
```

Every package directory carries its own README explaining responsibilities,
boundaries, and planned key types. User-owned files live outside the repo:
`~/.config/bai/config.json`, `~/.config/bai/agents/*.md`,
`~/.config/bai/tools/*.ts`, `~/.config/bai/providers/*.json`,
`~/.local/share/bai/` (DB, assets, tmp).

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

Requires Bun >= 1.3.14 — **Bun 1.4.0+ recommended**, for two reasons. Its
`--compile` embeds the SPA directly into the binary (on 1.3.x `make build`
stages it to `dist/web` beside the binary instead). And its fetch-abort
socket teardown ([oven-sh/bun#32578](https://github.com/oven-sh/bun/issues/32578))
means **stopping a run truly cancels the upstream provider request** — on
1.3.x the stop is still instant, but the connection lingers server-side
until the model finishes, so the provider may bill tokens generated after
your stop.

## Releases

Releases are built by [`.github/workflows/release.yml`](.github/workflows/release.yml)
on every `v*` tag (or via **Actions → Release → Run workflow**). The workflow
cross-compiles all eight Bun targets, embeds the web SPA + bundled skills into
each binary (Bun ≥ 1.4 `compile.assets`), smoke-tests the native linux-x64
build, and publishes one OCI artifact per platform to GitHub Container Registry
via [ORAS](https://oras.land) — no GitHub Release assets.

```sh
git tag v0.2.0
git push origin v0.2.0
```

Pull a binary with ORAS (packages default to **private**; flip visibility in the
package settings for anonymous pulls):

```sh
# linux-x64, linux-arm64, linux-x64-musl, linux-arm64-musl,
# darwin-arm64, darwin-x64, windows-x64, windows-arm64
oras pull ghcr.io/germaniii-com/bai/linux-x64:latest -o ./bai
chmod +x ./bai/bai
./bai/bai --web --open
```

Windows users pull `ghcr.io/germaniii-com/bai/windows-x64:latest` and run
`bai.exe`. To publish a build without pushing (smoke test only), run the
workflow manually with the `push` input disabled.

## License

MIT — see [LICENSE.md](LICENSE.md).
