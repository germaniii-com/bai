# Tool output budgets

How bai keeps tool results readable, honest, and pageable — and how it keeps the
model's own output from being cut off mid-tool-call. Both halves of the same
failure class: an agent that cannot tell *the middle* of a result from *the end*
will re-read files it believes it has seen and burn its tool budget doing it.

## The invariant

1. **Every builtin tool result fits `OUTPUT_LIMIT`** (`packages/core/src/tools/registry.ts`,
   32 000 chars).
2. **Line-oriented readers page contiguously.** `fs.read`, `fs.list`, `fs.glob`,
   `fs.grep`, and `#mention` / text-attachment rendering cap *themselves* through
   `packages/core/src/fs/window.ts`, and every capped result names its range and
   the exact next step (`Use offset=N to continue`, `#path:N to attach more`, or
   "refine the pattern or path").
3. **`ToolRegistry.bound()` is a last resort, not the normal path.** It only runs
   for tools that ignore the budget (e.g. a `bash` command that spews megabytes).
   It cuts head and tail **on line boundaries** (never mid-line, never with
   mangled line numbers), spills the full text to a managed temp file, and labels
   the gap explicitly as the **middle** of the output — not the end — together
   with the spill path and a paging hint. The spilled file is itself readable in
   full with `fs.read offset/limit`.
4. **The model's output ceiling is real and configurable** — see below.

## Where each piece lives

| Concern | Location |
| --- | --- |
| Line-window / byte-budget primitives | `src/fs/window.ts` (`windowNumberedLines`, `budgetedLines`, `WINDOW_HEADROOM`) |
| Budget, spill-to-disk, head+tail net | `src/tools/registry.ts` (`OUTPUT_LIMIT`, `bound`, `headCut`, `tailCut`) |
| File reads/writes, directory listings, chunked append | `src/tools/fs-read-write.ts` |
| Tree listings, globbed paths | `src/tools/fs-list-glob.ts` |
| Content search | `src/tools/fs-grep.ts` |
| `#mention` + attachment text | `src/run/mentions.ts` (`renderTextContent`) |
| Output-token ceiling | `src/provider/output-limit.ts` (`resolveMaxOutputTokens`) |

## Result metadata

Line-oriented tools report what happened in `meta`, so surfaces and tests can
assert it without parsing prose:

- `truncated` — anything was left out (count cap, char budget, or line cut).
- `stoppedByBudget` — the character budget, not `limit`/EOF, ended the window;
  `offset = last + 1` resumes cleanly.
- `lineTruncated` / `lineCapped` — a single line exceeded the budget and was
  cut inline.
- `appended` / `totalBytes` — `fs.write` in append mode.
- `spilledTo`, `elidedChars` — set by `bound()` on a last-resort cut.

## Why contiguous windows instead of head+tail

Head+tail looks generous but is actively misleading for a file read: it keeps
the real end of the file (including any "end of file" marker), so the model
cannot tell that the middle is missing, and the fragments it does get are unusable
because they start and end mid-line. A contiguous window costs 2-3 calls for a
large file and is *complete* across those calls — the model can page deterministically
instead of guessing what it missed.

## Output limits — the other direction

The budget above bounds what tools *return*. The model's own generation is bounded
too, and getting that ceiling wrong is just as destructive: `fs.write` carries the
whole file in its **arguments**, so a ceiling that is too low truncates the call
mid-JSON and the run dies with "the model response was cut off by the token limit
before the arguments completed".

### The ceiling ladder

`resolveMaxOutputTokens` (`src/provider/output-limit.ts`):

```
config.models.maxOutputTokens  →  catalog limit.output  →  16 384
                    ↓ always clamped to the vendor cap, and to <= 50% of the context window
```

- Both adapters fall back to **4096** `max_tokens` (~16 KB of output) when the
  request carries no `params.max_tokens` — too small for any large file write.
  The value is passed as `params.max_tokens`, which both adapters already honour,
  so the fix lives at the request-construction site in `run.ts`, not in the
  adapters.
- A published catalog output limit is a hard vendor cap: an override may lower it
  but never raise it past the cap.
- Setting `models.maxOutputTokens` low (e.g. `512`) is the supported way to
  *force* smaller chunked writes — and the way to reproduce and test the
  truncation path.

### Write in chunks, not in one shot

`fs.write` accepts `{ append: true }`, which appends instead of replacing — with
the same read-before-write guard, since appending to a stale file is as
destructive as overwriting it. Meta carries `appended` and `totalBytes`.

For a file larger than ~300 lines: `fs.write` the first chunk, then append the
rest across several calls. This keeps every call comfortably inside the ceiling
and is the structural fix for the truncation failure — the model never needs one
oversized call.

### When a call is still truncated

A `length` stop means arguments may be silently truncated, so the call must not
execute. Rather than ending the run — which leaves the user to re-prompt — the
coordinator repairs the partial call in the transcript so the history stays
valid, hands the model an actionable error naming the tool and the ceiling, and
retries in-run at most twice before stopping cleanly. See
`HANDOFF-truncated-tool-calls.md` for the outstanding patch.

## Verifying a change here

- `bun test packages/core/test/fs-window.test.ts` — helper boundaries.
- `bun test packages/core/test/tools-fs-budget.test.ts` — reads/listings never
  elided, pages tile the file with no gaps or duplicates.
- `bun test packages/core/test/registry-bound.test.ts` — the last-resort cut is
  line-aligned, labelled as the middle, and the spill pages back in full.
- `bun test packages/core/test/output-limit.test.ts` — the ceiling ladder.
- `bun test packages/core/test/tools-fs-append.test.ts` — chunked writes and the
  append guard.
