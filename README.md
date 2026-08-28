# bai (TypeScript)

> **One runtime. Every surface. Every modality.**

`bai` is an all-in-one AI workspace as a single Bun executable:

- 💬 **Chat** — multi-provider conversations (OpenAI, Anthropic, Gemini, any
  OpenAI-compatible endpoint)
- 🧑‍💻 **Code** — a terminal-grade coding agent with tools, diffs, and
  fail-closed permissions
- 🖼️ **Image / 🎬 Video workbenches** — generation jobs, asset galleries
  (structured from day one; adapters land in Phase 5)
- 🖥️ **Surfaces** — Ink TUI, web app for desktop _and_ mobile (browser/PWA),
  native desktop shell later

Start a session in the terminal, continue it from your phone. Configure from
either channel. Extensible through MCP (as client and as server).

This is the TypeScript implementation of the bai design; the Go sibling lives
in [`../bai/`](../bai/). See [ARCHITECTURE.md](ARCHITECTURE.md) for the full
design, decision log, and roadmap.

```bash
bai                      # TUI (default)
bai --code               # same, explicit
bai --web --open         # serve API + web UI on loopback, open browser
bai --host               # bind beyond loopback; prints URL + pairing QR for phone
bai --one-shot "summarize this repo" --format json   # headless NDJSON run
```

## Status

🚧 Scaffold phase — docs and workspace config only; implementation follows the
phased roadmap ([ARCHITECTURE.md §16](ARCHITECTURE.md#16-roadmap)).

## Repository layout

```
bai-ts/
├── ARCHITECTURE.md          ← start here
├── src/packages/
│   ├── shared/              domain types & contracts (leaf)        @bai/shared
│   ├── core/                sessions, runs, tools, permissions     @bai/core
│   │   └── src/               store · event · config · provider · mcp · workbench/*
│   ├── api/                 Hono server + typed client             @bai/api
│   ├── cli/                 entrypoint wiring & mode dispatch      @bai/cli
│   ├── tui/                 Ink terminal surface                   @bai/tui
│   ├── web/                 React + Vite SPA / PWA                 @bai/web
│   └── desktop/             native shell (stub until Phase 6)      @bai/desktop
```

Every package directory carries its own README explaining responsibilities,
boundaries, and planned key types.

## Development

```sh
make build        # single executable → dist/bai (SPA embedded/staged)
make run          # build and start the TUI
make test         # bun test across workspaces
make vet          # tsc --noEmit per package
make tidy         # bun install
make web-build    # vite build → src/packages/web/dist
make release      # cross-compile all 8 targets → dist/
make clean        # remove dist/
```

Or without make: `bun install` · `bun test` · `bun run typecheck` · `bun run compile`.

Requires Bun >= 1.3.14 (1.4+ recommended — its `--compile` embeds the SPA
directly into the binary; on 1.3.x `make build` stages it to `dist/web`
beside the binary instead).

## License

MIT — see [LICENSE.md](LICENSE.md).
