# @bai/web

The browser surface: React 19.2 + Vite 8 + TypeScript SPA, built to `dist/`
and served by `@bai/api` (SPA fallback, cache headers). Serves desktop
browsers **and** phones (PWA) from the same bundle.

## Responsibilities

- Views: sessions sidebar, chat, workspace (folder-path workspaces with
  per-workspace sessions + file tree), code (diffs), image gallery,
  video gallery, jobs queue, settings (config editor), pairing screen.
- Two-level navigation: a master icon rail (Chat, Workspace, Image Gen /
  Video Gen as phase placeholders, Settings pinned bottom) plus a
  contextual nested panel per section (sessions for chat, workspaces +
  their sessions for the workspace view, General + providers for
  settings). Workspace sessions are `workbench: "code"` sessions rooted
  at the workspace folder path (`cwd`); the workspace list lives in
  config (`workspaces`) and syncs live via `config.updated`.
- Sync engine mirroring the TUI's semantics:
  1. REST bootstrap snapshot on connect (typed via `hc<AppType>`)
  2. global SSE firehose applied through pure per-entity reducers
  3. per-session durable stream with cursor (`after=N`) when a session is open
  4. `server.hello` first frame → full refresh (universal healing)
- Types imported **directly** from `@bai/shared` — no mirrors, no codegen.
- PWA manifest + icons so phones can install bai to the home screen
  (`vite-plugin-pwa`).

## Conventions

- State: small stores + reducers over events (no heavyweight state library
  unless Phase 1 proves the need).
- React Compiler enabled from day one — no manual `useMemo`/`useCallback`
  ceremony.
- Styling: utility-first CSS; responsive-first layouts (phone is a primary
  target, not an afterthought).
- SSE consumption via `@bai/api`'s client (`fetch()` +
  `eventsource-parser`) — identical semantics to the TUI; bearer-token auth
  rules out native `EventSource`.

## Development workflow

```sh
bun run dev -- --filter @bai/web   # vite dev server on :5173
# /api and /mcp proxy to a running bai (BAI_DEV_URL or http://127.0.0.1:9640)
bun run build -- --filter @bai/web # vite build → dist/ (served by @bai/api)
```

Alternative server-side dev mode: run bai with `BAI_DEV_URL=http://localhost:5173`
so non-API routes proxy to Vite HMR instead of serving `dist/`.

## Non-goals

- Any direct core/store/provider access — API only.
- `/api/*` and `/mcp` never fall through to the SPA router.

See [ARCHITECTURE.md §13.2](../../ARCHITECTURE.md#132-web-baiweb-served-by-baiai).
