import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertFreshForWrite, recordRead, recordWrite, resolveInRoots, withFileMutationQueue, type FsRoots } from "./fs-guard";
import type { Tool, ToolContext, ToolResult } from "./registry";

/**
 * fs.edit — exact-string replacement with strict uniqueness (opencode2's
 * edit semantics): the oldString must match exactly once unless replaceAll
 * is set, with distinct errors for "not found" vs "multiple matches".
 * Line endings are normalized to the file's dominant ending.
 */
export function fsEditTool(roots: FsRoots): Tool {
  return {
    name: "fs.edit",
    origin: "builtin",
    description:
      "Replace an exact string in a file. oldString must match the file's exact current content including whitespace/indentation, and must appear exactly once unless replaceAll is true. Include surrounding lines to disambiguate.",
    schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path (absolute, or relative to the session working directory)" },
        oldString: { type: "string", description: "Exact text to replace" },
        newString: { type: "string", description: "Replacement text (must differ from oldString)" },
        replaceAll: { type: "boolean", description: "Replace every occurrence (default false)" },
      },
      required: ["path", "oldString", "newString"],
    },
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const { path: input, oldString, newString, replaceAll } = args as {
        path: string;
        oldString: string;
        newString: string;
        replaceAll?: boolean;
      };
      return withFileMutationQueue(path.resolve(input), () => {
        if (oldString === newString) {
          throw new Error("No changes to apply: oldString and newString are identical.");
        }
        if (oldString.length === 0) {
          throw new Error(
            "oldString cannot be empty. Use fs.write to create a new file or replace a file's full content.",
          );
        }
        const abs = resolveInRoots(ctx, roots.roots(), input);
        assertFreshForWrite(abs, true);

        const original = readFileSync(abs, "utf8");
        recordRead(abs); // reading here counts for the staleness table too
        const ending = original.includes("\r\n") ? "\r\n" : "\n";
        const oldText = normalizeEndings(oldString, ending);
        const newText = normalizeEndings(newString, ending);

        const occurrences = countOccurrences(original, oldText);
        if (occurrences === 0) {
          throw new Error(
            "Could not find oldString in the file. It must match exactly, including whitespace, indentation, and line endings.",
          );
        }
        if (occurrences > 1 && replaceAll !== true) {
          throw new Error(
            `Found ${occurrences} matches for oldString. Provide more surrounding context to make the match unique, or set replaceAll: true.`,
          );
        }
        const replacements = replaceAll === true ? occurrences : 1;
        const updated = replaceAll === true ? original.split(oldText).join(newText) : original.replace(oldText, newText);
        if (updated === original) {
          throw new Error("No changes made: the replacement produced identical content.");
        }
        mkdirSync(path.dirname(abs), { recursive: true });
        writeFileSync(abs, updated);
        recordWrite(abs);
        return {
          content: `Edited ${abs} (${replacements} replacement${replacements === 1 ? "" : "s"}).`,
          meta: { path: abs, replacements },
        } satisfies ToolResult;
      });
    },
  };
}

function normalizeEndings(text: string, ending: "\r\n" | "\n"): string {
  const unified = text.replaceAll("\r\n", "\n");
  return ending === "\n" ? unified : unified.replaceAll("\n", "\r\n");
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = 0;
  while ((index = haystack.indexOf(needle, index)) !== -1) {
    count++;
    index += needle.length;
  }
  return count;
}
