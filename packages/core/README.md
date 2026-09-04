# @bai/core

The domain heart: sessions, runs, tools, permissions. Owns _what it means_ to
prompt bai; knows nothing about terminals, browsers, or HTTP.

Supporting modules from the Go design (`config`, `store`, `event`, `provider`,
`mcp`, `workbench/*`) live as submodules under `src/` rather than as separate
top-level packages — see [Submodules](#submodules) below.

## Responsibilities

### Sessions
- Create/list/rename/archive sessions; scope to a workbench and working dir.
- Durable input admission: every prompt becomes an inbox row before any model
  call (crash-safe by construction).
- Message/part assembly from provider stream events.
- Two-phase revert & fork (opencode parity): `revertSession` hides a user
  message and everything after it — rolling files back via the shadow-repo
  snapshots (`src/snapshot.ts`) — until restored or committed by the next
  prompt; `forkSession` copies the history before a message into a new
  session with fresh ids.

### Run coordinator
- One drain per session (process-global `Map` keyed by session ID); different
  sessions run concurrently.
- Drain loop: promote eligible inputs → provider turn (via `provider`) →
  execute tool calls → append results → repeat until idle or interrupted.
  Mutating batches (`bash`, `fs.write/fs.edit`, `task`) record a `patch`
  part (shadow-repo tree + changed files) for revert's file rollback.
- Pending reverts commit at prompt admission: the hidden tail is
  hard-deleted (emitting `message.removed`) before the new user message.
- Steering semantics: mid-run prompts promote at the next safe boundary;
  `queue` inputs wait for idle. Interrupt cancels the drain's
  `AbortController`; unpromoted inputs stay queued.

### Tool registry
- Merges builtin tools + workbench tools + MCP tools (`mcp/<server>/<tool>`).
- Uniform `Tool` contract: JSON Schema, execute, output bounding (truncate
  head+tail past the limit; spill full text to a managed temp file referenced
  in the result part).

### Permission engine
- Rule evaluation per tool call: last matching pattern wins; unmatched → `ask`.
- Sources merged: defaults < global config < project config < session-scoped
  approvals ("always").
- Interactive asks broadcast `permission.asked`; **first reply wins**;
  rejection cascades to sibling pending requests in the same run.

## Submodules

| Submodule       | Role                                                                 |
| --------------- | -------------------------------------------------------------------- |
| `src/store/`    | `bun:sqlite` persistence: schema, migrations, typed accessors. The only SQL in the repo. WAL mode, single connection, explicit transactions. |
| `src/event/`    | **Bus** (in-process pub/sub feeding the SSE firehose; slow-consumer drop+stale policy) + **Log** (durable per-session rows, monotonic seq allocated in the same transaction as the state change, replay-after-cursor). |
| `src/config/`   | Layered configuration: defaults → global file → project file (walk-up) → `BAI_*` env → flags. Deep merge, zod validation, atomic write-back, jsonc tolerated on read. |
| `src/provider/` | LLM access behind one small interface; adapters for openai v7 / @anthropic-ai/sdk / @google/genai + an OpenAI-compatible catch-all; models.dev catalog via `@opencode-ai/models` with offline snapshot fallback. Vendor types never leak past adapter files. |
| `src/mcp/`      | MCP client manager (@modelcontextprotocol/client v2): stdio + streamable HTTP transports, reconnect/backoff, namespaced tool merge. Server-side exposure wiring is mounted by `@bai/api`. |
| `src/workbench/`| Modality seam + registry; subpackages `chat`, `code`, `image`, `video` implement the Workbench contract. |

## Non-goals

- Any transport concern (HTTP/SSE → `@bai/api`; TUI rendering → `@bai/tui`).
- Provider wire details beyond adapter boundaries (→ `provider` submodule).
- Media generation logic (→ workbenches).

## Key types (planned)

```ts
export interface Tool {
  name(): string;
  schema(): JsonSchema;
  execute(args: unknown, ctx: ToolContext): Promise<ToolResult>;
}

export interface Workbench {
  name(): WorkbenchName;
  label(): string;
  tools(): Promise<Tool[]>;
  jobTypes(): JobType[];
  assetKinds(): AssetKind[];
}

export class Service {
  createSession(opts: CreateSessionOpts): Promise<Session>;
  submit(ses: SessionId, prompt: Prompt): Promise<void>; // durable admit + wake
  interrupt(ses: SessionId): void;
}
```

## Notes

- Emits everything through `event` (bus + durable log); never notifies
  surfaces directly.
- Workbench packages implement the contracts defined here and are registered
  by the composition root (`@bai/cli`) — `core` never imports them.
- See [ARCHITECTURE.md §9](../../ARCHITECTURE.md#9-agent-execution).
