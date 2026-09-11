import { readdirSync, readFileSync, statSync } from "node:fs";
import { parseMentions } from "@bai/shared";
import { capFor, mediaFromName } from "../attachments";
import { OUTPUT_LIMIT } from "../tools/registry";
import { looksBinary, resolveInRoots } from "../tools/fs-guard";
import { WINDOW_HEADROOM, budgetedLines, windowNumberedLines } from "../fs/window";

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
  /**
   * Present when the mention is provider-supported media (image or PDF):
   * bytes ride `data` (transient — promotion stores them as an attachment).
   */
  media?: { kind: "image" | "pdf"; mime: string };
  /** Raw bytes for a media mention (consumed at promotion; never persisted). */
  data?: Uint8Array;
}

export interface MentionExpansion {
  blocks: MentionBlock[];
}

/** Read caps mirror fs.read so attached context matches tool output budgets. */
const READ_FILE_BYTES = 1_000_000;
const READ_LINE_CAP = 2000;
const READ_LINE_CHARS = 2000;
const DIR_ENTRY_CAP = 500;
/** Same window budget as fs.read: attachments never get elided mid-file. */
const READ_BUDGET = OUTPUT_LIMIT - WINDOW_HEADROOM;

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
    let all: string[];
    try {
      all = readdirSync(abs).sort();
    } catch (err) {
      return { ...base, error: true, content: err instanceof Error ? err.message : String(err) };
    }
    const { kept, truncated } = budgetedLines(all.slice(0, DIR_ENTRY_CAP), READ_BUDGET);
    const note = truncated ? `\n(truncated at ${kept.length} entries — mention a subdirectory for the rest)` : "";
    return { path: displayPath, content: kept.join("\n") + note };
  }
  if (!stat.isFile()) return { ...base, error: true, content: `Not a file: ${abs}` };

  // Media mentions (images / PDF) attach as provider content instead of text.
  const media = mediaFromName(abs);
  if (media !== undefined) {
    const cap = capFor(media.kind);
    if (stat.size > cap) {
      return { ...base, error: true, content: `File too large to attach (${stat.size} bytes, cap ${cap}).` };
    }
    let buf: Buffer;
    try {
      buf = readFileSync(abs);
    } catch (err) {
      return { ...base, error: true, content: err instanceof Error ? err.message : String(err) };
    }
    return { path: displayPath, content: "", media, data: buf };
  }

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

  return {
    path: displayPath,
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
    content: renderTextContent(buf, from, to, displayPath),
  };
}

/**
 * Numbered line window for a text buffer — shared by `#mention` expansion and
 * text-file attachments at promotion. Mirrors fs.read's caps and budget, so an
 * attachment is always a contiguous, honest slice with a way to get the rest.
 *
 * `mentionPath` (the path as the user typed it) turns the continuation hint
 * into a copy-pasteable `#path:line` mention. Uploaded attachments are not
 * workspace paths, so they get a hint that says plainly more was not shown.
 */
export function renderTextContent(buf: Uint8Array, from?: number, to?: number, mentionPath?: string): string {
  const allLines = Buffer.from(buf).toString("utf8").split("\n");
  const total = allLines.length;
  const start = Math.max(1, Math.floor(from ?? 1));
  if (start > total && !(total === 0 && start === 1)) {
    return `Line ${start} is past the end of the file (${total} lines).`;
  }
  const requested = to !== undefined ? Math.max(1, to - start + 1) : READ_LINE_CAP;
  const maxLines = Math.min(READ_LINE_CAP, requested);
  const window = windowNumberedLines(allLines, {
    start,
    maxLines,
    budget: READ_BUDGET,
    lineCharCap: READ_LINE_CHARS,
  });
  if (window.last >= total && !window.lineTruncated) return window.text;
  const next = window.last + 1;
  const cap = window.stoppedByBudget ? " — capped to the tool output budget" : "";
  const hint =
    mentionPath !== undefined
      ? `Use #${mentionPath}:${next} to attach more.`
      : "The rest of this attachment was not included.";
  return `${window.text}\n(Showing lines ${window.first}-${window.last} of ${total}${cap}. ${hint})`;
}
