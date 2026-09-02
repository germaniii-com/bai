import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { looksBinary, assertFreshForWrite, recordRead, recordWrite, resolveInRoots, notFoundError, withFileMutationQueue, type FsRoots } from "./fs-guard";
import type { Tool, ToolContext, ToolResult } from "./registry";

/**
 * fs.read — read a text file with line numbers, head-truncated with an
 * actionable continuation hint (pi's read tool semantics).
 */
const READ_LINE_CAP = 2000;
const READ_LINE_CHARS = 2000;
const READ_FILE_BYTES = 1_000_000;

export function fsReadTool(roots: FsRoots): Tool {
  return {
    name: "fs.read",
    origin: "builtin",
    description:
      "Read a text file with line numbers. Returns up to 2000 lines; use offset/limit to page through bigger files. Directory paths list their entries instead.",
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
        const entries = readdirSync(abs).sort().slice(0, 500);
        return {
          content: [`<path>${abs}</path>`, "<type>directory</type>", "<entries>", ...entries, "</entries>"].join("\n"),
          meta: { path: abs, kind: "directory" },
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
      const slice = allLines.slice(start - 1, start - 1 + maxLines).map((line) =>
        line.length > READ_LINE_CHARS ? `${line.slice(0, READ_LINE_CHARS)}… (line truncated to ${READ_LINE_CHARS} chars)` : line,
      );
      const numbered = slice.map((line, i) => `${start + i}: ${line}`).join("\n");
      const last = start + slice.length - 1;
      let suffix: string;
      if (start - 1 + slice.length < total) {
        suffix = `\n\n(Showing lines ${start}-${last} of ${total}. Use offset=${last + 1} to continue.)`;
      } else {
        suffix = `\n\n(End of file — total ${total} lines)`;
      }
      return {
        content: [`<path>${abs}</path>`, "<content>", numbered, "</content>"].join("\n") + suffix,
        meta: { path: abs, offset: start, lines: slice.length, total },
      };
    },
  };
}

/**
 * fs.write — create or overwrite a file. Refuses to overwrite a file that
 * was not read first, or that changed on disk after the last read.
 */
export function fsWriteTool(roots: FsRoots): Tool {
  return {
    name: "fs.write",
    origin: "builtin",
    description:
      "Write content to a file, creating it (and parent directories) if needed. Read the file first when overwriting an existing one. Refuses byte-identical writes.",
    schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path (absolute, or relative to the session working directory)" },
        content: { type: "string", description: "Full content to write (replaces the file)" },
      },
      required: ["path", "content"],
    },
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const { path: input, content } = args as { path: string; content: string };
      return withFileMutationQueue(path.resolve(input), () => {
        const abs = resolveInRoots(ctx, roots.roots(), input);
        const existed = exists(abs);
        assertFreshForWrite(abs, existed);
        if (existed && readFileSync(abs, "utf8") === content) {
          throw new Error("No changes to write: content is byte-identical to the existing file.");
        }
        mkdirSync(path.dirname(abs), { recursive: true });
        writeFileSync(abs, content);
        recordWrite(abs);
        return {
          content: `Wrote ${Buffer.byteLength(content)} bytes to ${abs}.`,
          meta: { path: abs, bytes: Buffer.byteLength(content), created: !existed },
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
