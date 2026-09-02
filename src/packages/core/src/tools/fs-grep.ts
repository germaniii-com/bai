import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { Tool, ToolContext, ToolResult } from "./registry";
import { DEFAULT_IGNORED_DIRS, isIgnoredDir, looksBinary } from "./fs-guard";

/**
 * fs.grep — content search (opencode's grep semantics): regex pattern,
 * optional glob include filter, 100-match cap with a continuation hint.
 * Backed by the `rg` binary when present (fast, gitignore-aware); otherwise
 * a bounded pure-JS walk (correct, slower, no .gitignore awareness).
 */

const MATCH_CAP = 100;
const LINE_CHARS = 500;
/** Fallback walk caps — without rg, bound the blast radius. */
const MAX_FALLBACK_FILES = 5_000;
const MAX_FALLBACK_BYTES = 512 * 1024;

interface Match {
  file: string;
  line: number;
  text: string;
}

export function fsGrepTool(): Tool {
  return {
    name: "fs.grep",
    origin: "builtin",
    description:
      "Search file contents with a regular expression. Returns up to 100 matches as file:line: text. " +
      "Use include (a glob like *.ts) to filter file types. Case-sensitive; use inline (?i) for case-insensitive. " +
      "List or glob first when unsure where to look.",
    schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regular expression to search for" },
        path: { type: "string", description: "File or directory to search (default: the session working directory)" },
        include: { type: "string", description: 'Glob filter for file names, e.g. "*.ts"' },
        limit: { type: "number", description: "Maximum matches to return (default 100)" },
      },
      required: ["pattern"],
    },
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const { pattern, path: input, include, limit } = args as {
        pattern?: string;
        path?: string;
        include?: string;
        limit?: number;
      };
      if (typeof pattern !== "string" || pattern.length === 0) {
        throw new Error("pattern is required");
      }
      let regex: RegExp;
      try {
        regex = new RegExp(pattern);
      } catch (err) {
        throw new Error(`Invalid regular expression: ${err instanceof Error ? err.message : err}`);
      }
      const cap = Math.max(1, Math.min(MATCH_CAP, Math.floor(limit ?? MATCH_CAP)));

      const root = resolveRoot(ctx, input);
      if (root === undefined) throw new Error("No search path available.");
      const glob = compileGlob(include);

      const matches =
        rgAvailable() && root !== undefined
          ? runRipgrep(root, regex, include, cap + 1)
          : fallbackWalk(root, regex, glob, cap + 1);

      if (matches.length === 0) {
        return {
          content: `No matches for /${pattern}/${glob !== undefined ? ` (include: ${include})` : ""}.`,
          meta: { pattern, count: 0 },
        };
      }
      const truncated = matches.length > cap;
      const shown = matches.slice(0, cap);
      const lines = shown.map((m) => `${m.file}:${m.line}: ${m.text}`);
      let suffix = "";
      if (truncated) {
        suffix = `\n\n(Showing ${cap} of more matches — refine the pattern, narrow the path, or raise the limit.)`;
      }
      return {
        content: lines.join("\n") + suffix,
        meta: { pattern, count: shown.length, truncated },
      };
    },
  };
}

/** Resolve the search root against the session cwd (defaults to cwd itself). */
function resolveRoot(ctx: ToolContext, input?: string): string | undefined {
  const cwd = ctx.cwd;
  if (input === undefined || input.trim().length === 0) {
    if (cwd === undefined || cwd.length === 0) {
      throw new Error("No path given and the session has no working directory. Pass a path.");
    }
    return cwd;
  }
  const trimmed = input.trim();
  if (path.isAbsolute(trimmed)) return path.normalize(trimmed);
  if (cwd === undefined || cwd.length === 0) {
    throw new Error("Relative paths need a session working directory. Use an absolute path.");
  }
  return path.normalize(path.resolve(cwd, trimmed));
}

/** Minimal glob matcher: * → within-segment, ** → anything, ? → one char. */
export function compileGlob(pattern?: string): ((name: string) => boolean) | undefined {
  if (pattern === undefined || pattern.trim().length === 0) return undefined;
  const re = new RegExp(
    `^${pattern
      .trim()
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, "\0")
      .replace(/\*/g, "[^/]*")
      .replace(/\?/g, "[^/]")
      .replace(/\0/g, ".*")}$`,
  );
  return (name: string) => re.test(name);
}

// --- ripgrep backend ---

let rgProbe: boolean | undefined;

function rgAvailable(): boolean {
  if (rgProbe !== undefined) return rgProbe;
  try {
    const proc = Bun.spawnSync(["rg", "--version"], { stdout: "ignore", stderr: "ignore" });
    rgProbe = proc.exitCode === 0;
  } catch {
    rgProbe = false;
  }
  return rgProbe;
}

function rgGlobArg(glob: ((name: string) => boolean) | undefined, raw?: string): string[] {
  // Pass the raw pattern through when provided (the compiled matcher can't
  // reconstruct it) — rg validates it.
  return raw !== undefined && raw.trim().length > 0 ? ["-g", raw.trim()] : [];
}

function runRipgrep(root: string, regex: RegExp, rawInclude: string | undefined, cap: number): Match[] {
  let target = root;
  try {
    statSync(root); // existence check — rg reports its own read errors
  } catch {
    throw new Error(`Path not found: ${root}`);
  }
  // Default excludes apply even outside git repos (a /tmp fixture or a
  // fresh checkout without .git would otherwise search node_modules etc.).
  const excludeArgs = [...DEFAULT_IGNORED_DIRS].map((dir) => ["-g", `!${dir}`]).flat();
  const argv = [
    "rg",
    "--no-heading",
    "--line-number",
    "--color",
    "never",
    "--max-columns",
    String(LINE_CHARS),
    "--max-count",
    String(Math.max(1, Math.floor(cap / 20))) /* per-file fairness */,
    ...excludeArgs,
    ...(rawInclude !== undefined && rawInclude.trim().length > 0 ? ["-g", rawInclude.trim()] : []),
    regex.source,
    target,
  ];
  const proc = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
  const stdout = new TextDecoder().decode(proc.stdout);
  const matches: Match[] = [];
  for (const line of stdout.split("\n")) {
    if (line.length === 0) continue;
    // rg --no-heading --line-number: file:line: text
    const idx1 = line.indexOf(":");
    const idx2 = line.indexOf(":", idx1 + 1);
    if (idx1 < 0 || idx2 < 0) continue;
    matches.push({
      file: line.slice(0, idx1),
      line: Number.parseInt(line.slice(idx1 + 1, idx2), 10) || 0,
      text: line.slice(idx2 + 1).trimStart().slice(0, LINE_CHARS),
    });
    if (matches.length >= cap) break;
  }
  return matches;
}

// --- pure-JS fallback backend ---

function fallbackWalk(root: string, regex: RegExp, glob: ((name: string) => boolean) | undefined, cap: number): Match[] {
  const stat = statSync(root);
  const files: string[] = [];
  if (stat.isFile()) {
    files.push(root);
  } else {
    let visited = 0;
    const walk = (dir: string): boolean => {
      // returns true when the caller should stop (caps reached)
      let entries: string[];
      try {
        entries = readdirSync(dir).sort();
      } catch {
        return false;
      }
      for (const entry of entries) {
        if (visited >= MAX_FALLBACK_FILES) return true;
        const abs = path.join(dir, entry);
        let s;
        try {
          s = statSync(abs);
        } catch {
          continue;
        }
        if (s.isDirectory()) {
          if (isIgnoredDir(entry) || DEFAULT_IGNORED_DIRS.has(entry)) continue;
          if (walk(abs)) return true;
          continue;
        }
        if (!s.isFile() || s.size > MAX_FALLBACK_BYTES) continue;
        if (glob !== undefined && !glob(entry)) continue;
        visited++;
        files.push(abs);
        if (files.length >= MAX_FALLBACK_FILES) return true;
      }
      return false;
    };
    walk(root);
  }

  const matches: Match[] = [];
  for (const file of files) {
    if (matches.length >= cap) break;
    let buf: Buffer;
    try {
      buf = readFileSync(file);
    } catch {
      continue;
    }
    if (looksBinary(buf)) continue;
    const lines = buf.toString("utf8").split("\n");
    for (let i = 0; i < lines.length && matches.length < cap; i++) {
      if (regex.test(lines[i] as string)) {
        matches.push({
          file,
          line: i + 1,
          text: (lines[i] as string).slice(0, LINE_CHARS),
        });
      }
    }
  }
  return matches;
}
