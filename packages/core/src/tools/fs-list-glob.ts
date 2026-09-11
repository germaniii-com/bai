import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { Glob } from "bun";
import { isIgnoredDir, resolveInRoots, type FsRoots } from "./fs-guard";
import { OUTPUT_LIMIT, type Tool, type ToolContext, type ToolResult } from "./registry";
import { WINDOW_HEADROOM, budgetedLines } from "../fs/window";

/**
 * fs.list — recursive tree listing below a directory (hidden dirs and
 * common build output ignored), capped by count and by the tool output budget
 * with an actionable note.
 */
const LIST_ENTRY_CAP = 500;
const LIST_BUDGET = OUTPUT_LIMIT - WINDOW_HEADROOM;

export function fsListTool(roots: FsRoots): Tool {
  return {
    name: "fs.list",
    origin: "builtin",
    description:
      "List files and directories under a path as an indented tree. Hidden directories and build output (node_modules, dist, …) are skipped. Capped at 500 entries — list a subdirectory for the rest. Use fs.glob for pattern search.",
    schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path (absolute, or relative to the session working directory; default: session cwd)" },
      },
      required: [],
    },
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const input = (args as { path?: string }).path;
      const abs = resolveInRoots(ctx, roots.roots(), input ?? ".");
      const stat = statSync(abs); // throws with a raw ENOENT message when missing
      if (!stat.isDirectory()) throw new Error(`Not a directory: ${abs}`);

      const lines: string[] = [];
      const hitCap = walk(abs, "", 0, lines, LIST_ENTRY_CAP);
      const { kept, truncated: overBudget } = budgetedLines(lines, LIST_BUDGET);
      const truncated = hitCap || overBudget;
      const header =
        lines.length === 0
          ? `(empty) ${abs}`
          : `${abs} (${kept.length} entries${truncated ? " — truncated, list a subdirectory for the rest" : ""})`;
      return {
        content: [header, ...kept].join("\n"),
        meta: { path: abs, entries: kept.length, truncated },
      };
    },
  };
}

function walk(abs: string, prefix: string, depth: number, out: string[], cap: number): boolean {
  if (out.length >= cap) return true;
  let entries: string[] = [];
  try {
    entries = readdirSync(abs).sort();
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (out.length >= cap) return true;
    const childAbs = path.join(abs, entry);
    let isDir = false;
    try {
      isDir = statSync(childAbs).isDirectory();
    } catch {
      continue; // vanished or unreadable
    }
    if (isDir && isIgnoredDir(entry)) continue;
    out.push(`${prefix}${entry}${isDir ? "/" : ""}`);
    if (isDir && depth < 8) {
      if (walk(childAbs, `${prefix}  `, depth + 1, out, cap)) return true;
    }
  }
  return out.length >= cap;
}

/**
 * fs.glob — pattern match below a directory (Bun.Glob), capped at 100
 * results with a refine-pattern hint (truncation as pagination).
 */
const GLOB_RESULT_CAP = 100;
const GLOB_BUDGET = OUTPUT_LIMIT - WINDOW_HEADROOM;

export function fsGlobTool(roots: FsRoots): Tool {
  return {
    name: "fs.glob",
    origin: "builtin",
    description:
      "Find files matching a glob pattern (e.g. 'src/**/*.ts', '*.json'). Hidden dirs and build output are skipped. Returns at most 100 paths.",
    schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern, e.g. '**/*.ts' or 'src/*.json'" },
        path: { type: "string", description: "Directory to search (default: session cwd)" },
      },
      required: ["pattern"],
    },
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const { pattern, path: input } = args as { pattern: string; path?: string };
      const base = resolveInRoots(ctx, roots.roots(), input ?? ".");
      if (!statSync(base).isDirectory()) throw new Error(`glob path must be a directory: ${base}`);

      const glob = new Glob(pattern);
      const files: string[] = [];
      for (const rel of glob.scanSync({ cwd: base, dot: false, onlyFiles: true })) {
        const top = rel.split("/")[0] ?? rel;
        if (rel.includes("/") && isIgnoredDir(top)) continue;
        files.push(path.join(base, rel));
        if (files.length >= GLOB_RESULT_CAP) break;
      }
      files.sort();
      if (files.length === 0) {
        return { content: `No files found for pattern: ${pattern}`, meta: { pattern, base, count: 0, truncated: false } };
      }
      const { kept, truncated: overBudget } = budgetedLines(files, GLOB_BUDGET);
      const truncated = files.length >= GLOB_RESULT_CAP || overBudget;
      const lines = truncated
        ? [...kept, "", `(truncated at ${kept.length} matches — refine the pattern or path for more.)`]
        : kept;
      return {
        content: lines.join("\n"),
        meta: { pattern, base, count: kept.length, truncated },
      };
    },
  };
}
