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
| `GET` | `/api/help` | HTML documentation page (when Run as router is on) |
| `GET` | `/api/help/openapi.json` | OpenAPI 3.1 document (when Run as router is on) |

**Target selection:** `model` is bai's `provider/model` id; the saved account
is chosen with the `x-bai-account` header (falls back to the config default).

**Auth:** loopback requests bypass the bearer token; non-loopback listeners
require `Authorization: Bearer <token>` (same policy as `@bai/api`).

## Where it runs

- `bai --web` / `--host` — router **on by default** (gateway + `/api/help`)
  alongside the SPA and `/api/*`.
- `bai --router` — headless: gateway + `/api/help`, no web UI. Always on.
- `bai --web --router` — everything on one listener, one process.
- `bai` (TUI) / `bai --one-shot` — follows the same on/off setting on the
  ephemeral in-process listener.

## Enablement ("Run as router")

`config.router.enabled` (Settings → Model Providers → **Run as router**,
persisted to `~/.config/bai/config.json`) turns the gateway on/off:

- **Default on** — unset/`undefined` means enabled, so `bai --web` is a router
  out of the box.
- **Applies live** — `RouterDeps.enabled` is read per request, so toggling in
  Settings takes effect without a restart (a disabled router 404s
  `router_disabled`, as if its routes were uninstalled).
- **`--router` forces on** — the explicit flag wins over the setting.

## Exports

- `createRouterRoutes(deps)` — `/v1/*` only (mount into any bai server).
- `createRouterHelp(deps)` — `/api/help` + OpenAPI.
- `createRouterGateway(deps, { help })` — the composable extra-routes app.
- `createRouterApp(deps)` — standalone app (`createRouterGateway` + help).

`RouterDeps` = `{ router: ModelRouter; core: Service; jobs: JobQueue; store:
Store; version; token?; loopbackBind; enabled? }`.

## Non-goals

- Owning a store, job queue, or scheduler of its own.
- Anthropic-native `/v1/messages` (OpenAI wire only in v1).
- Video routing (text + image only).
