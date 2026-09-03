import { createPatch } from "diff";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { AskDetail } from "@bai/shared";

/**
 * Ask-detail enrichers: per-tool functions that turn raw tool args into a
 * renderable {@link AskDetail} (summary + unified diff) before the permission
 * gate emits `permission.asked`. This keeps the central fail-closed gate AND
 * gives surfaces opencode-style diff previews — the tool itself never runs
 * before approval, so the enricher recomputes the would-be change from the
 * args instead.
 *
 * Enrichers are best-effort: any failure yields no detail, never an ask
 * failure (a broken preview must not block the permission flow).
 */

/** Unified diffs above this size are head+tail elided for the ask payload. */
const DIFF_LIMIT = 8_000;

type Enricher = (args: Record<string, unknown>, cwd?: string) => AskDetail;

const registry = new Map<string, Enricher>();

/** Compute the ask detail for a tool call, or undefined when none applies. */
export function askDetailFor(tool: string, args: unknown, cwd?: string): AskDetail | undefined {
  const enrich = registry.get(tool);
  if (enrich === undefined) return undefined;
  if (args === null || typeof args !== "object") return undefined;
  try {
    return enrich(args as Record<string, unknown>, cwd);
  } catch {
    return undefined;
  }
}

/** Display path: relative to the session cwd when inside it, else absolute. */
function displayPath(abs: string, cwd?: string): string {
  if (cwd !== undefined && cwd.length > 0) {
    const rel = path.relative(cwd, abs);
    if (rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel)) return rel;
  }
  return abs;
}

/** Resolve a tool path arg against the session cwd (no workspace roots here — best effort only). */
function resolveArgPath(input: unknown, cwd?: string): string | undefined {
  if (typeof input !== "string" || input.trim().length === 0) return undefined;
  const trimmed = input.trim();
  if (path.isAbsolute(trimmed)) return path.normalize(trimmed);
  if (cwd === undefined || cwd.length === 0) return undefined;
  return path.normalize(path.resolve(cwd, trimmed));
}

/** Cheap binary sniff (mirrors fs-guard's looksBinary) so diffs stay textual. */
function isTextFile(abs: string): boolean {
  try {
    const buf = readFileSync(abs);
    return !buf.subarray(0, 8192).includes(0);
  } catch {
    return false;
  }
}

function elide(text: string): string {
  if (text.length <= DIFF_LIMIT) return text;
  const head = text.slice(0, DIFF_LIMIT / 2);
  const tail = text.slice(-DIFF_LIMIT / 2);
  return `${head}\n[… ${text.length - DIFF_LIMIT} characters elided …]\n${tail}`;
}

/** fs.write — diff of the existing file (if any) against the incoming content. */
registry.set("fs.write", (args, cwd) => {
  const abs = resolveArgPath(args.path, cwd);
  if (abs === undefined) return {};
  const rel = displayPath(abs, cwd);
  let oldContent: string | undefined;
  let existed = false;
  try {
    const stat = statSync(abs);
    if (stat.isFile()) {
      existed = true;
      if (isTextFile(abs)) oldContent = readFileSync(abs, "utf8");
    }
  } catch {
    // File doesn't exist yet — creating.
  }
  const newContent = typeof args.content === "string" ? args.content : "";
  const summary = existed
    ? `overwrite ${rel} (${Buffer.byteLength(newContent)} bytes)`
    : `create ${rel} (${Buffer.byteLength(newContent)} bytes)`;
  // Binary targets get a summary only — a textual diff of bytes is noise.
  const diff = oldContent !== undefined ? elide(createPatch(rel, oldContent, newContent)) : undefined;
  return { path: abs, summary, ...(diff !== undefined ? { diff } : {}) };
});

/** fs.edit — apply the would-be replacement in memory, then diff. */
registry.set("fs.edit", (args, cwd) => {
  const abs = resolveArgPath(args.path, cwd);
  if (abs === undefined) return {};
  const rel = displayPath(abs, cwd);
  let original: string;
  try {
    if (!isTextFile(abs)) return { path: abs, summary: `edit ${rel}` };
    original = readFileSync(abs, "utf8");
  } catch {
    return { path: abs, summary: `edit ${rel} (file not readable)` };
  }
  const { oldString, newString, replaceAll } = args as {
    oldString?: unknown;
    newString?: unknown;
    replaceAll?: unknown;
  };
  if (typeof oldString !== "string" || typeof newString !== "string") {
    return { path: abs, summary: `edit ${rel}` };
  }
  const ending = original.includes("\r\n") ? "\r\n" : "\n";
  const normalize = (text: string) => {
    const unified = text.replaceAll("\r\n", "\n");
    return ending === "\n" ? unified : unified.replaceAll("\n", "\r\n");
  };
  const oldText = normalize(oldString);
  const newText = normalize(newString);
  let updated: string | undefined;
  if (replaceAll === true) {
    updated = original.split(oldText).join(newText);
  } else {
    const idx = original.indexOf(oldText);
    if (idx >= 0 && original.indexOf(oldText, idx + oldText.length) === -1) {
      updated = original.slice(0, idx) + newText + original.slice(idx + oldText.length);
    }
  }
  const summary = `edit ${rel}`;
  // oldString missing/ambiguous → the tool itself will error after approval;
  // a summary-only ask still lets the user see what was attempted.
  const diff = updated !== undefined && updated !== original ? elide(createPatch(rel, original, updated)) : undefined;
  return { path: abs, summary, ...(diff !== undefined ? { diff } : {}) };
});

/** task — a human-readable summary of the subagent spawn being requested. */
registry.set("task", (args) => {
  const description = typeof args.description === "string" ? args.description.trim() : "";
  const agent = typeof args.subagent_type === "string" ? args.subagent_type : "?";
  return { summary: `spawn subagent "${description}" (agent: ${agent})` };
});
