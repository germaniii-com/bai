# @bai/api

The HTTP boundary, both sides: a **Hono** server (REST + SSE + MCP mount +
static hosting) and the **typed client** every surface consumes. The only
package that knows about the network.

## Server (`src/server`)

### API routes

```
GET    /api/health                      hello-world / liveness
GET    /api/session                     list (paged)
POST   /api/session                     create
GET    /api/session/:id
GET    /api/session/:id/message         history
POST   /api/session/:id/message         submit prompt (durable admit + wake)
POST   /api/session/:id/interrupt
GET    /api/session/:id/event?after=N   durable SSE stream (replay-then-live)
GET    /api/event                       global live SSE firehose
POST   /api/permission/:id/reply        first reply wins
GET|PUT /api/config                     effective config / mutate (writes back)
GET    /api/provider                    providers + models
POST   /api/job                         enqueue job (media generation)
GET    /api/job/:id
GET    /api/asset                       list; GET /api/asset/:id/content  (bytes)
/mcp                                    MCP stateless streamable HTTP (Phase 4)
```

- Served by `Bun.serve({ fetch: app.fetch })`; Hono's Web-standard handlers
  map 1:1 onto Bun.
- Request bodies validated with zod via `@hono/zod-validator`.
- Export `type AppType = typeof app` so surfaces get fully typed REST calls
  through `hc<AppType>()`. Pitfalls honored: never `c.notFound()` (breaks
  inference — use `c.json(..., 404)`); URL-encode path params client-side;
  keep route chaining shallow.
- SSE discipline (`hono/streaming`): flush per event, heartbeat ~15 s,
  `onAbort` cleanup; first frame is always `server.hello` (clients treat it as
  the snapshot-refresh trigger). Errors inside a started stream cannot reach
  `onError` — handle inline.

### Static hosting
- Serves `@bai/web/dist` with SPA fallback to `/`; `/api/*` and `/mcp` never
  fall through.
- `hasAssets()` guard renders a "build the web app" hint page instead of a
  blank 404.
- Cache headers: immutable for hashed `/assets/*`, `no-cache` for index.html.
- Dev mode: if `BAI_DEV_URL` is set, proxy non-API routes to the Vite dev
  server instead of the built assets.

### Auth & networking
- Bearer token middleware; loopback requests may bypass only when the
  listener is loopback-bound.
- Binds `127.0.0.1` by default (preferred port 9640, else ephemeral);
  `--host` widens binding and prints URL + pairing QR.
- Writes `~/.local/state/bai/server.json` `{url, pid, token}` for local
  discovery/reuse.

## Client (`src/client`)

Typed consumer used by `@bai/tui`, `@bai/cli` (one-shot), and `@bai/web`:

- REST methods generated from `hc<AppType>` — full type safety from the same
  route definitions, no codegen.
- SSE consumption for both streams (global firehose + durable session stream
  with cursor tracking and replay-then-live handling), implemented once with
  `fetch()` + `eventsource-parser` so browser and Bun share identical code.
  (Hono's RPC client has no native SSE support by design.)
- Bearer token header management.
- Two constructors:
  - `createClient(baseURL, token)` — networked (remote server, `--attach`)
  - `dialListener(port, token)` — local mode against the ephemeral loopback
    listener the same process started (uniform code path)

## Non-goals

- Domain logic (delegates everything to `@bai/core`); handlers stay thin:
  decode → call → encode.
- State management/reducers (owners: `tui`, web SPA). The client delivers
  facts; it holds no caches beyond the resume cursor.
- TLS termination (use a tunnel/reverse proxy when exposing publicly).

## Key types (planned)

```ts
export function createApp(deps: Deps): Hono<AppType>; // deps: core service, event bus/log, config store, web fs
export type AppType = ReturnType<typeof createApp>;

export interface BaiClient {
  sessions: TypedSessionRoutes;
  events(opts: { after?: number }): EventStream;
  replyPermission(id: string, r: Reply): Promise<void>;
}
```

## Notes

- Contract tests pin routing semantics: root→index, asset→direct,
  client-route→index, `/api/*` never shadowed.
- Integration tests spin a real server on an ephemeral port and use this
  client end-to-end — no mocks of the API surface.
- Graceful shutdown drains in-flight requests via `server.stop()` with a hard
  timeout fallback (known Bun WS-close hang).
- See [ARCHITECTURE.md §13](../../ARCHITECTURE.md#13-surfaces),
  [§14](../../ARCHITECTURE.md#14-security--networking).
