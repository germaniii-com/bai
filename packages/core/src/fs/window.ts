/**
 * Line-windowing helpers shared by fs.read / fs.grep / fs.list / fs.glob and
 * #mention/attachment rendering.
 *
 * Line-oriented readers must emit at most `budget` characters so the tool
 * registry's last-resort head+tail truncation (see tools/registry.ts) never
 * fires on them: that cut silently drops the middle of the output, which is
 * exactly the failure mode that makes an agent burn its tool budget
 * re-reading files it believes it has seen.
 *
 * Pure and dependency-free — callers pass the budget, so this module stays
 * free of an import cycle with the tool registry.
 */

/** Reserved for result wrappers (`<path>`/`<content>` tags) and suffix notes. */
export const WINDOW_HEADROOM = 512;

export interface WindowOptions {
  /** 1-indexed first line to include. */
  start: number;
  /** Upper bound on returned lines (the caller's `limit`). */
  maxLines: number;
  /** Character budget for the numbered block; never exceeded. */
  budget: number;
  /** Longest single line before it is cut with a note. */
  lineCharCap: number;
}

export interface WindowResult {
  /** Numbered lines joined by "\n" (length <= `budget`). */
  text: string;
  /** 1-indexed first returned line. */
  first: number;
  /** 1-indexed last returned line; `last < first` when nothing was returned. */
  last: number;
  /** Total lines available in the source. */
  total: number;
  /**
   * Another line exists but did not fit `budget` — the caller must tell the
   * model to continue from `last + 1`. False when the limit or EOF stopped
   * the window instead.
   */
  stoppedByBudget: boolean;
  /** The (single) returned line did not fit the budget and was cut. */
  lineTruncated: boolean;
  /** At least one line hit `lineCharCap` and carries an inline note. */
  lineCapped: boolean;
}

const BUDGET_ELLIPSIS = "… (line truncated to fit the output budget)";

export function windowNumberedLines(allLines: string[], opts: WindowOptions): WindowResult {
  const total = allLines.length;
  const maxLines = Math.max(1, Math.floor(opts.maxLines));
  const budget = Math.max(0, Math.floor(opts.budget));
  const lineCharCap = Math.max(1, Math.floor(opts.lineCharCap));
  const first = total === 0 ? 1 : Math.min(Math.max(1, Math.floor(opts.start)), total);

  const pieces: string[] = [];
  let used = 0;
  let i = first - 1;
  let lineTruncated = false;
  let lineCapped = false;
  let outOfBudget = false;

  for (; i < total && pieces.length < maxLines; i++) {
    const label = `${i + 1}: `;
    let line = allLines[i] ?? "";
    if (line.length > lineCharCap) {
      line = `${line.slice(0, lineCharCap)}… (line truncated to ${lineCharCap} chars)`;
      lineCapped = true;
    }
    const separator = pieces.length === 0 ? 0 : 1; // the "\n" joining this piece on
    const piece = `${label}${line}`;

    if (used + separator + piece.length <= budget) {
      pieces.push(piece);
      used += separator + piece.length;
      continue;
    }
    outOfBudget = true;
    // Always return the first line, cut to fit, so a caller never gets an
    // empty window just because one line is longer than the whole budget.
    if (pieces.length === 0) {
      const room = budget - label.length - BUDGET_ELLIPSIS.length;
      if (room > 0) {
        pieces.push(`${label}${line.slice(0, room)}${BUDGET_ELLIPSIS}`);
        lineTruncated = true;
        i++;
      }
    }
    break;
  }

  const consumedThrough = i; // index just past the last line taken
  return {
    text: pieces.join("\n"),
    first,
    last: first + pieces.length - 1,
    total,
    stoppedByBudget: outOfBudget && consumedThrough < total,
    lineTruncated,
    lineCapped,
  };
}

/**
 * Keep as many leading entries as fit `budget`. Listings go through this so a
 * tree full of long absolute paths cannot blow past the tool output budget
 * (which would get it elided mid-entry by the registry). Always keeps the
 * first entry, so a single over-budget line never yields an empty listing.
 */
export function budgetedLines(lines: string[], budget: number): { kept: string[]; truncated: boolean } {
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const cost = (kept.length === 0 ? 0 : 1) + line.length;
    if (used + cost > budget) {
      if (kept.length === 0) kept.push(line);
      break;
    }
    kept.push(line);
    used += cost;
  }
  return { kept, truncated: kept.length < lines.length };
}
