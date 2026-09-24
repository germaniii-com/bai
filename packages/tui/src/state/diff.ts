/**
 * Tiny unified-diff summarizer for the permission prompts / diff bodies: the
 * changed filename plus `+N −M` counts. Pure, so the header math is
 * unit-testable and the two prompt views share one implementation.
 */
export interface DiffStat {
  /** The changed path (`+++ b/<file>` with the `b/` prefix stripped). */
  file?: string;
  added: number;
  removed: number;
}

export function diffStat(diff: string): DiffStat {
  let file: string | undefined;
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const raw = line.slice(4).trim().split("\t")[0] ?? "";
      if (raw.length > 0 && raw !== "/dev/null") file = raw.replace(/^[ab]\//, "");
    } else if (line.startsWith("--- ")) {
      // File header — never a change line.
      continue;
    } else if (line.startsWith("+")) {
      added++;
    } else if (line.startsWith("-")) {
      removed++;
    }
  }
  return { file, added, removed };
}
