# @bai/shared

The leaf package: domain types, identifiers, and contracts shared by every
other package — imported **directly** by the server, the TUI, and the web SPA.
There are no generated or hand-maintained type mirrors anywhere else; this
package is the single source of truth for the wire vocabulary.

**Imports nothing.** If you are tempted to add an import here, the type
belongs somewhere else.

## Responsibilities

- Branded ID types with prefixes (`ses_…`, `msg_…`, `run_…`, `job_…`,
  `ast_…`, `perm_…`) and their generation/parsing.
- Core domain interfaces: `Session`, `Message`, `Part`, `Event`, `Job`,
  `Asset`, `PermissionRequest`, `ModelInfo`, and the `Config` shape.
- Event type constants and the wire envelope:
  `{ seq, type, ts, session_id?, payload }`.
- Enums as union types: workbench names (`chat|code|image|video`), part kinds,
  job/asset kinds, permission actions (`allow|ask|deny`), input states.
- Small pure helpers (clock interface for testability, JSON codec helpers).
- Zod schemas mirroring the wire types (validation + published JSON Schema).

## Non-goals

- Any I/O, DB, or HTTP code.
- Anything that would require importing another `@bai/*` package.
- Provider-specific types (belong in `@bai/core`'s provider submodule).

## Key types (planned)

```ts
export type SessionId = Brand<string, "SessionId">; // "ses_…"

export interface Event {
  seq: number;
  type: EventType;
  ts: string; // RFC3339 UTC
  sessionId?: SessionId;
  payload: unknown;
}

export type PermissionAction = "allow" | "ask" | "deny";
export type WorkbenchName = "chat" | "code" | "image" | "video";
```

## Consumers

Everything — including both UI surfaces, which is the structural win over the
Go design (where the web SPA needed hand-maintained TS mirrors of Go types).
See [ARCHITECTURE.md §5](../../ARCHITECTURE.md#5-repository-layout--dependency-rules).
