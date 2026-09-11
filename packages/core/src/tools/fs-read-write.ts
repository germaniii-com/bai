import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { looksBinary, assertFreshForWrite, recordRead, recordWrite, resolveInRoots, notFoundError, withFileMutationQueue, type FsRoots } from "./fs-guard";
import { OUTPUT_LIMIT, type Tool, type ToolContext, type ToolResult } from "./registry";
import { WINDOW_HEADROOM, budgetedLines, windowNumberedLines } from "../fs/window";

/**
 * fs.read — read a text file with line numbers, returned as a contiguous
 * window that always fits the tool output budget with an actionable
 * continuation hint (pi's read tool semantics). Because the window stays under
 * OUTPUT_LIMIT, the registry's last-resort head+tail truncation never fires on
 * a read: `offset` always resumes at the next unseen line.
 */
const READ_LINE_CAP = 2000;
const READ_LINE_CHARS = 2000;
const READ_FILE_BYTES = 1_000_000;
const READ_BUDGET = OUTPUT_LIMIT - WINDOW_HEADROOM;
/** Directory listings are capped by count and by the same character budget. */
const DIR_ENTRY_CAP = 500;

export function fsReadTool(roots: FsRoots): Tool {
  return {
    name: "fs.read",
    origin: "builtin",
    description:
      `Read a text file with line numbers. Returns as many whole lines as fit the ~${Math.round(OUTPUT_LIMIT / 1000)}k-char tool output budget (at most 2000); the reply always states the line range, and offset/limit page through bigger files. Directory paths list their entries instead.`,
    schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path (absolute, or relative to the session working directory)" },
        offset: { type: "number", description: "1-indexed line to start from (default 1)" },
        limit: { type: "number", description: "Maximum lines to return (default 2000)" },
      },
      required: ["path"],
    },
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const { path: input, offset, limit } = args as { path: string; offset?: number; limit?: number };
      const abs = resolveInRoots(ctx, roots.roots(), input);
      let stat;
      try {
        stat = statSync(abs);
      } catch {
        throw notFoundError(abs);
      }
      if (stat.isDirectory()) {
        const all = readdirSync(abs).sort();
        const capped = all.slice(0, DIR_ENTRY_CAP);
        const { kept, truncated: overBudget } = budgetedLines(capped, READ_BUDGET);
        // `truncated` covers both the count cap (entries never looked at) and
        // the character budget (entries that did not fit) — silently dropping
        // either is what makes an agent think it has seen the whole listing.
        const truncated = overBudget || capped.length < all.length;
        return {
          content: [
            `<path>${abs}</path>`,
            "<type>directory</type>",
            "<entries>",
            ...kept,
            "</entries>",
            ...(truncated ? [`(truncated at ${kept.length} entries — pass a subdirectory for the rest)`] : []),
          ].join("\n"),
          meta: { path: abs, kind: "directory", entries: kept.length, total: all.length, truncated },
        };
      }
      if (stat.size > READ_FILE_BYTES) {
        throw new Error(
          `File too large to read (${stat.size} bytes, cap ${READ_FILE_BYTES}). Use offset/limit via a different strategy or process it with a tool.`,
        );
      }
      const buf = readFileSync(abs);
      if (looksBinary(buf)) throw new Error(`Cannot read binary file: ${abs}`);
      recordRead(abs);

      const allLines = buf.toString("utf8").split("\n");
      const total = allLines.length;
      const start = Math.max(1, Math.floor(offset ?? 1));
      const maxLines = Math.max(1, Math.min(READ_LINE_CAP, Math.floor(limit ?? READ_LINE_CAP)));
      if (start > total && !(total === 0 && start === 1)) {
        throw new Error(`Offset ${start} is out of range for this file (${total} lines)`);
      }
      const window = windowNumberedLines(allLines, {
        start,
        maxLines,
        budget: READ_BUDGET,
        lineCharCap: READ_LINE_CHARS,
      });
      const last = window.last;
      let suffix: string;
      if (window.stoppedByBudget) {
        suffix =
          `\n\n(Showing lines ${window.first}-${last} of ${total} — window capped to the ` +
          `~${Math.round(OUTPUT_LIMIT / 1000)}k-char tool output budget. Use offset=${last + 1} to continue.)`;
      } else if (last < total) {
        suffix = `\n\n(Showing lines ${window.first}-${last} of ${total}. Use offset=${last + 1} to continue.)`;
      } else if (window.lineTruncated) {
        suffix = `\n\n(End of file — total ${total} lines; the last line was cut to fit the output budget)`;
      } else {
        suffix = `\n\n(End of file — total ${total} lines)`;
      }
      return {
        content: [`<path>${abs}</path>`, "<content>", window.text, "</content>"].join("\n") + suffix,
        meta: {
          path: abs,
          offset: window.first,
          lines: Math.max(0, last - window.first + 1),
          total,
          truncated: window.stoppedByBudget || window.lineTruncated,
          ...(window.stoppedByBudget ? { stoppedByBudget: true } : {}),
          ...(window.lineTruncated ? { lineTruncated: true } : {}),
          ...(window.lineCapped ? { lineCapped: true } : {}),
        },
      };
    },
  };
}

/**
 * fs.write — create or overwrite a file, or append to one. Refuses to touch a
 * file that was not read first, or that changed on disk after the last read —
 * in append mode too, since appending to a stale file is as destructive as
 * overwriting it.
 *
 * Append exists so a large file never has to be one oversized tool call: the
 * model's output is capped (see `provider/output-limit.ts`), so a single
 * `fs.write` of a big file gets cut off mid-JSON. Chunking keeps every call
 * comfortably inside the ceiling.
 */
export function fsWriteTool(roots: FsRoots): Tool {
  return {
    name: "fs.write",
    origin: "builtin",
    description:
      "Write content to a file, creating it (and parent directories) if needed. Read the file first when overwriting an existing one. Refuses byte-identical writes. For files larger than ~300 lines, write the first chunk and append the rest with { append: true } across several calls — a single call is capped by the model's output limit, so one giant write can be cut off mid-argument.",
    schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path (absolute, or relative to the session working directory)" },
        content: { type: "string", description: "Content to write: replaces the file, or is appended to it with append: true" },
        append: {
          type: "boolean",
          description:
            "Append to the end of an existing file instead of replacing it (default false). The file must exist and have been read first; use this to build a large file in chunks.",
        },
      },
      required: ["path", "content"],
    },
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const { path: input, content, append } = args as { path: string; content: string; append?: boolean };
      return withFileMutationQueue(path.resolve(input), () => {
        const abs = resolveInRoots(ctx, roots.roots(), input);
        const existed = exists(abs);
        assertFreshForWrite(abs, existed);
        const bytes = Buffer.byteLength(content);

        if (append === true) {
          if (!existed) {
            throw new Error(`Cannot append: ${abs} does not exist. Use fs.write without append to create it.`);
          }
          // Byte-identical content is legitimate here (repeating a block), so
          // the replace-mode no-op guard deliberately does not apply.
          appendFileSync(abs, content);
          recordWrite(abs);
          const totalBytes = statSync(abs).size;
          return {
            content: `Appended ${bytes} bytes to ${abs} (now ${totalBytes} bytes).`,
            meta: { path: abs, bytes, totalBytes, appended: true, created: false },
          } satisfies ToolResult;
        }

        if (existed && readFileSync(abs, "utf8") === content) {
          throw new Error("No changes to write: content is byte-identical to the existing file.");
        }
        mkdirSync(path.dirname(abs), { recursive: true });
        writeFileSync(abs, content);
        recordWrite(abs);
        return {
          content: `Wrote ${bytes} bytes to ${abs}.`,
          meta: { path: abs, bytes, totalBytes: bytes, appended: false, created: !existed },
        } satisfies ToolResult;
      });
    },
  };
}

function exists(abs: string): boolean {
  try {
    return statSync(abs).isFile();
  } catch {
    return false;
  }
}
