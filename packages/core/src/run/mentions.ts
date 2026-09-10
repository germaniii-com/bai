import { readdirSync, readFileSync, statSync } from "node:fs";
import { parseMentions } from "@bai/shared";
import { looksBinary, resolveInRoots } from "../tools/fs-guard";

/**
 * Resolve `#file[:from-to]` mentions in a user turn into attached read
 * context. The visible prompt keeps the `#path` token; each mention becomes a
 * `file` part (`RunCoordinator.appendPromotedInputs`) whose `content` is the
 * numbered line slice (or a directory listing), and `renderOutbound` renders
 * those parts as `<file>` blocks beside the user text.
 *
 * This is the one place bai goes beyond opencode2 (which leaves the path as
 * inert text): it makes the optional line range deterministic. Resolution is
 * root-scoped via `resolveInRoots` — a mention outside the session cwd /
 * registered workspaces fails closed into an error block, never a read.
 */

export interface MentionBlock {
  /** Path as typed (workspace-relative or absolute). */
  path: string;
  /** 1-indexed first line, when a range was given. */
  from?: number;
  /** 1-indexed last line (inclusive), when a range was given. */
  to?: number;
  /** Numbered lines (file) or entry list (directory). */
  content: string;
  /** True when resolution/read failed — `content` carries the message. */
  error?: boolean;
}

export interface MentionExpansion {
  blocks: MentionBlock[];
}

/** Read caps mirror fs.read so attached context matches tool output budgets. */
const READ_FILE_BYTES = 1_000_000;
const READ_LINE_CAP = 2000;
const READ_LINE_CHARS = 2000;
const DIR_ENTRY_CAP = 500;

/**
 * Expand every mention in `text`. Never throws: a mention that cannot be
 * resolved becomes an error block so the model still learns why.
 */
export function expandMentions(text: string, cwd: string | undefined, roots: string[]): MentionExpansion {
  const mentions = parseMentions(text);
  if (mentions.length === 0) return { blocks: [] };
  const blocks: MentionBlock[] = [];
  for (const mention of mentions) {
    const base: MentionBlock = {
      path: mention.path,
      ...(mention.from !== undefined ? { from: mention.from } : {}),
      ...(mention.to !== undefined ? { to: mention.to } : {}),
      content: "",
    };
    try {
      const abs = resolveInRoots(cwd !== undefined ? { cwd } : {}, roots, mention.path);
      blocks.push(readBlock(abs, mention.path, mention.from, mention.to, base));
    } catch (err) {
      blocks.push({ ...base, error: true, content: err instanceof Error ? err.message : String(err) });
    }
  }
  return { blocks };
}

function readBlock(
  abs: string,
  displayPath: string,
  from: number | undefined,
  to: number | undefined,
  base: MentionBlock,
): MentionBlock {
  let stat;
  try {
    stat = statSync(abs);
  } catch {
    return { ...base, error: true, content: `File not found: ${abs}` };
  }
  if (stat.isDirectory()) {
    let entries: string[];
    try {
      entries = readdirSync(abs).sort().slice(0, DIR_ENTRY_CAP);
    } catch (err) {
      return { ...base, error: true, content: err instanceof Error ? err.message : String(err) };
    }
    return { path: displayPath, content: entries.join("\n") };
  }
  if (!stat.isFile()) return { ...base, error: true, content: `Not a file: ${abs}` };
  if (stat.size > READ_FILE_BYTES) {
    return { ...base, error: true, content: `File too large to attach (${stat.size} bytes, cap ${READ_FILE_BYTES}).` };
  }
  let buf: Buffer;
  try {
    buf = readFileSync(abs);
  } catch (err) {
    return { ...base, error: true, content: err instanceof Error ? err.message : String(err) };
  }
  if (looksBinary(buf)) return { ...base, error: true, content: `Cannot attach a binary file: ${abs}` };

  const allLines = buf.toString("utf8").split("\n");
  const total = allLines.length;
  const start = Math.max(1, Math.floor(from ?? 1));
  if (start > total && !(total === 0 && start === 1)) {
    return { ...base, error: true, content: `Line ${start} is past the end of ${abs} (${total} lines).` };
  }
  const requested = to !== undefined ? Math.max(1, to - start + 1) : READ_LINE_CAP;
  const maxLines = Math.min(READ_LINE_CAP, requested);
  const slice = allLines
    .slice(start - 1, start - 1 + maxLines)
    .map((line) => (line.length > READ_LINE_CHARS ? `${line.slice(0, READ_LINE_CHARS)}… (line truncated)` : line));
  const numbered = slice.map((line, i) => `${start + i}: ${line}`).join("\n");
  const last = start + slice.length - 1;
  const suffix = last < total ? `\n(Showing lines ${start}-${last} of ${total}.)` : "";
  return {
    path: displayPath,
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
    content: numbered + suffix,
  };
}
