# Tool output budgets

How bai keeps tool results readable, honest, and pageable. This is the contract
behind the "read came back truncated" class of bug: an agent that cannot tell
*the middle* of a result from *the end* will re-read files it believes it has
seen and burn its tool budget doing it.

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

## Where each piece lives

| Concern | Location |
| --- | --- |
| Line-window / byte-budget primitives | `src/fs/window.ts` (`windowNumberedLines`, `budgetedLines`, `WINDOW_HEADROOM`) |
| Budget, spill-to-disk, head+tail net | `src/tools/registry.ts` (`OUTPUT_LIMIT`, `bound`, `headCut`, `tailCut`) |
| File reads, directory listings | `src/tools/fs-read-write.ts` |
| Tree listings, globbed paths | `src/tools/fs-list-glob.ts` |
| Content search | `src/tools/fs-grep.ts` |
| `#mention` + attachment text | `src/run/mentions.ts` (`renderTextContent`) |

## Result metadata

Line-oriented tools report what happened in `meta`, so surfaces and tests can
assert it without parsing prose:

- `truncated` — anything was left out (count cap, char budget, or line cut).
- `stoppedByBudget` — the character budget, not `limit`/EOF, ended the window;
  `offset = last + 1` resumes cleanly.
- `lineTruncated` / `lineCapped` — a single line exceeded the budget and was
  cut inline.
- `spilledTo`, `elidedChars` — set by `bound()` on a last-resort cut.

## Why contiguous windows instead of head+tail

Head+tail looks generous but is actively misleading for a file read: it keeps
the real end of the file (including any "end of file" marker), so the model
cannot tell that the middle is missing, and the fragments it does get are unusable
because they start and end mid-line. A contiguous window costs 2-3 calls for a
large file and is *complete* across those calls — the model can page deterministically
instead of guessing what it missed.

## Verifying a change here

- `bun test packages/core/test/fs-window.test.ts` — helper boundaries.
- `bun test packages/core/test/tools-fs-budget.test.ts` — reads/listings never
  elided, pages tile the file with no gaps or duplicates.
- `bun test packages/core/test/registry-bound.test.ts` — the last-resort cut is
  line-aligned, labelled as the middle, and the spill pages back in full.
