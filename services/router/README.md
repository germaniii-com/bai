# @bai/router

The OpenAI-compatible inference gateway. A **separate service** (its own
workspace under `services/`) that routes requests to bai's saved providers,
accounts and models over the `@bai/provider` SDK.

It is composed **in-process** into the one bai server — never a second
stateful process. Two independent core boots would double-run media jobs and
automations (both `JobQueue.start` and `AutomationScheduler.start` reconcile
store state), and clobber the shared `server.json`.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/chat/completions` | OpenAI-compatible chat; `stream:true` for SSE |
| `GET` | `/v1/models` | Routable model catalog (`provider/model` ids) |
| `POST` | `/v1/images/generations` | Image generation; returns base64 images |
| `GET` | `/api/help` | HTML documentation page (router mode only) |
| `GET` | `/api/help/openapi.json` | OpenAPI 3.1 document (router mode only) |

**Target selection:** `model` is bai's `provider/model` id; the saved account
is chosen with the `x-bai-account` header (falls back to the config default).

**Auth:** loopback requests bypass the bearer token; non-loopback listeners
require `Authorization: Bearer <token>` (same policy as `@bai/api`).

## Where it runs

- `bai --router` — headless: `/v1/*` + `/api/help`, no web UI.
- `bai --web` / `--host` — `/v1/*` mounted alongside the SPA and `/api/*`
  (no `/api/help`).
- `bai --web --router` — everything on one listener, one process.
- `bai` (TUI) / `bai --one-shot` — `/v1/*` is mounted on the ephemeral
  in-process listener too.

## Exports

- `createRouterRoutes(deps)` — `/v1/*` only (mount into any bai server).
- `createRouterHelp(deps)` — `/api/help` + OpenAPI.
- `createRouterGateway(deps, { help })` — the composable extra-routes app.
- `createRouterApp(deps)` — standalone app (`createRouterGateway` + help).

`RouterDeps` = `{ router: ModelRouter; core: Service; jobs: JobQueue; store:
Store; version; token?; loopbackBind }`.

## Non-goals

- Owning a store, job queue, or scheduler of its own.
- Anthropic-native `/v1/messages` (OpenAI wire only in v1).
- Video routing (text + image only).
