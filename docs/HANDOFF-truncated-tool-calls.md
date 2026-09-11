# Handoff — truncated tool calls (self-healing)

**Status: partially implemented.** Whole-file changes are done ("Already landed").
The patches below are surgical edits inside large files (`run.ts`, `catalog.ts`,
`registry.ts`, `service.ts`). They were **not applied** and **not test-run**:
`fs.edit` and `bash` were stubbed in the session that wrote this, so every edit
would have meant reproducing a 1 500-line file from memory.

Live proof of the bug: writing *this* document was itself aborted with
"the model response was cut off by the token limit before the arguments
completed" — the first draft was too long for the 4096-token default.

---

## Already landed

| Change | File |
| --- | --- |
| `resolveMaxOutputTokens` ladder (`DEFAULT_MAX_OUTPUT_TOKENS`, `MIN_MAX_OUTPUT_TOKENS`) | `core/src/provider/output-limit.ts` *(new)* |
| Ladder unit tests | `core/test/output-limit.test.ts` *(new)* |
| `models.maxOutputTokens` (interface + zod schema — both needed) | `shared/src/config.ts` |
| `fs.write { append: true }` + chunking guidance | `core/src/tools/fs-read-write.ts` |
| Append/chunked-write tests | `core/test/tools-fs-append.test.ts` *(new)* |
| Append-aware permission preview | `core/src/tools/ask-detail.ts` |
| Docs | `docs/TOOL-OUTPUT-BUDGETS.md` |

`ask-detail.ts` is **not** optional polish: without its append branch the
permission dialog shows an append as an "overwrite" with a whole-file diff.

---

## Correction: no adapter change is needed

Both adapters already honour an override —

- `adapters/openai.ts:219` — `max_tokens: typeof req.params?.max_tokens === "number" ? req.params.max_tokens : 4096`
- `adapters/anthropic.ts:126-131` — same, `DEFAULT_MAX_TOKENS = 4096` (line 6)

The bug is that **nothing ever sets `params.max_tokens`**. That makes the fix one
expression at the single request-construction site, `run.ts:369`.

---

## Patch 1 — pass the ceiling (the actual fix)

**1a. `run.ts:369`** — find:

```ts
...(run.reasoning && toolDefs.length === 0 ? { params: { thinking: { type: "enabled", budget_tokens: 2048 } } } : {}),
```

replace with:

```ts
params: {
  max_tokens: run.maxOutputTokens,
  ...(run.reasoning && toolDefs.length === 0 ? { thinking: { type: "enabled", budget_tokens: 2048 } } : {}),
},
```

**1b. `run.ts:125`** — `RunContext`, beside `contextWindow`:

```ts
/** Effective output-token ceiling for this turn (provider/output-limit.ts). */
maxOutputTokens: number;
```

**1c. `run.ts:666`** — destructure `outputLimit`, then add to the returned object
after `contextWindow,`:

```ts
maxOutputTokens: resolveMaxOutputTokens({
  configValue: this.deps.maxOutputTokens?.(),
  modelLimit: outputLimit,
  contextWindow,
}),
```

plus the import: `import { resolveMaxOutputTokens } from "./provider/output-limit";`

**1d. `run.ts:61-95`** — `RunCoordinatorDeps`, beside `defaultModel`/`titleModel`:

```ts
/** Configured output-token ceiling (config models.maxOutputTokens), when set. */
maxOutputTokens?(): number | undefined;
```

Optional, so minimal test setups keep compiling.

**1e. `service.ts:149`** — wire it where the other config-backed deps are wired:

```ts
maxOutputTokens: () => config.models.maxOutputTokens,
```

---

## Patch 2 — expose the catalog's output limit (recommended)

Without it the ladder still works (config → default), but the vendor cap is
unknown, so an override above the model's real limit reaches the provider.

- `core/src/provider/catalog.ts`: `limit` (line 66) gains `output?: number`;
  `CatalogModel` (line 29) gains `outputLimit?: number`; `normalizeModelsDev`
  (line ~232, where `contextWindow` is spread) gains
  `...(typeof m.limit?.output === "number" ? { outputLimit: m.limit.output } : {}),`
- `core/src/provider/registry.ts`: `ResolvedModel` (line 27) gains
  `outputLimit?: number`, spread in the two places that already spread
  `contextWindow` (lines 118, 390).

---

## Patch 3 — repair + retry on a `length` stop (the self-healing)

Today `run.ts:474-482` fails **every** call in the batch with one fixed sentence
(line 479) and then `break`s the drain. So the model never retries — and the
**partial arguments stay in the transcript, where replaying them is a provider
400** (`openai.ts:62` re-emits them raw; `anthropic.ts:234` `JSON.parse`s them).

**3a. Repair before any replay.** Invariant: *every persisted `tool_call` part
holds valid JSON arguments before it is ever replayed.* Add to `RunCoordinator`:

```ts
private repairTruncatedArgs(calls: ParsedCall[]): void {
  for (const call of calls) {
    let ok = false;
    try {
      JSON.parse(call.args);
      ok = call.args.trim().length > 0;
    } catch {
      ok = false;
    }
    if (!ok) this.deps.store.parts.updatePayload(call.partId, { args: '{"_truncated":true}' });
  }
}
```

`parts.updatePayload` is already used for delta accumulation (`run.ts:1034`).
Apply it in the `length` branch *and* in the existing malformed-JSON path
(`run.ts:1111-1120`), which today tells the model the JSON was malformed but
leaves the invalid string on the part — the same latent replay 400. If a call's
`name` is also empty, drop that part and skip its result rather than persisting an
orphan (an orphaned tool result is rejected too).

**3b. Actionable error, then bounded retry.** Replace the sentence at line 479
with a message naming the tool and the ceiling, e.g.:

```ts
const msg =
  `Tool call aborted: your output hit the ${run.maxOutputTokens}-token limit mid-` +
  `\`${call.name}\`, so its arguments were cut off and NOT executed (a partial ` +
  `call must never run). Retry smaller: for a large file, fs.write the first ` +
  `chunk and append the rest with { append: true }; else narrow the scope.`;
this.persistToolResult(sessionId, assistant.id, call, msg, true);
```

Still fail the whole batch on `length`, but report per-call detail. Then replace
the `break`: keep `let truncationRetries = 0` before the step loop; on a `length`
stop increment it, and while `<= 2` emit the existing `run.retry` event with
`{ attempt, maxAttempts: 2, error }` (already emitted for provider retries at
`run.ts:378`) and `continue`; reset on any step that does not end with `length`;
after two, persist the final error, emit one explanatory notice, then `break`.

---

## Tests owed

`packages/core/test/run-truncation.test.ts` — drive `RunCoordinator` with a fake
provider stream ending in `stopReason: "length"` and truncated args, asserting:
(1) another provider turn happens (retry, not break); (2) every replayed
`tool_call` has **parseable** args (the 400 regression); (3) every call id has
exactly one result (no orphans); (4) the run stops after two, with `run.retry`
emitted; (5) the malformed-JSON path is repaired too.

## Verification owed

Nothing below was run. In `bai-ts/`:

```
bun test packages/core/test/output-limit.test.ts packages/core/test/tools-fs-append.test.ts
bun test
```

Then: (a) ask for a ~1 500-line file → chunked appends, no `denied/failed`;
(b) set `models.maxOutputTokens: 512`, request a large `fs.write` → actionable
error → `run.retry` → smaller retry → clean stop after two; (c) small writes
still succeed first try and `run.usage` is unaffected.
