/**
 * `#file` mention grammar — shared by both composers (token detection +
 * insertion) and by core's prompt expansion (resolving mentions into read
 * context). Pure string logic, so every surface and the server agree on
 * exactly what a mention means.
 *
 * Grammar:
 *   #src/foo.ts          whole file
 *   #src/foo.ts:10       from line 10 to EOF
 *   #src/foo.ts:10-20    lines 10–20 inclusive
 *   #src/foo.ts:10-      same as :10
 *
 * The trigger is `#` at the start of the text or after whitespace; the token
 * runs until whitespace. A range is recognized only when everything after
 * the LAST `:` is `\d+` or `\d+-\d*` (so `#a:b` is a path, `#a:1-2` is a range).
 */

export interface MentionRange {
  /** 1-indexed first line. */
  from: number;
  /** 1-indexed last line (inclusive); omitted → to EOF. */
  to?: number;
}

export interface Mention {
  /** The full token as typed, e.g. "#src/foo.ts:10-20". */
  raw: string;
  /** Path portion (range stripped). */
  path: string;
  from?: number;
  to?: number;
}

export interface MentionTrigger {
  /** Code-unit offset of the `#`. */
  start: number;
  /** Text after `#` up to the cursor, e.g. "src/foo.ts:10-". */
  raw: string;
}

const RANGE_RE = /^(\d+)(?:-(\d*))?$/;

/**
 * Detect the mention token containing `cursor`, if any. `#` must start the
 * text or follow whitespace, and no whitespace may sit between it and the
 * cursor. Returns the trigger offset + raw query, or null.
 */
export function mentionTrigger(text: string, cursor: number): MentionTrigger | null {
  const before = text.slice(0, Math.max(0, Math.min(cursor, text.length)));
  const match = /(?:^|\s)#([^\s#]*)$/.exec(before);
  if (match === null) return null;
  const raw = match[1] ?? "";
  return { start: before.length - raw.length - 1, raw };
}

/**
 * Split a raw mention query into its path and optional line range. `#a:1-3`
 * → `{ path: "a", from: 1, to: 3 }`; `#a:5` → `{ path: "a", from: 5 }`;
 * `#a:b` → `{ path: "a:b" }` (non-numeric suffix is part of the path).
 */
export function splitMentionQuery(raw: string): { pathQuery: string; range?: MentionRange } {
  const colon = raw.lastIndexOf(":");
  if (colon < 0) return { pathQuery: raw };
  const suffix = raw.slice(colon + 1);
  const match = RANGE_RE.exec(suffix);
  if (match === null) return { pathQuery: raw };
  const from = Math.max(1, Number(match[1]));
  const toRaw = match[2];
  const to = toRaw !== undefined && toRaw.length > 0 ? Number(toRaw) : undefined;
  return {
    pathQuery: raw.slice(0, colon),
    range: to !== undefined && to >= from ? { from, to } : { from },
  };
}

/** Format a range back into mention syntax (`:10` / `:10-20`), or "". */
export function formatMentionRange(range: MentionRange | undefined): string {
  if (range === undefined) return "";
  return range.to !== undefined ? `:${range.from}-${range.to}` : `:${range.from}`;
}

/**
 * Replace the trigger token ending at `cursor` with the chosen entry (plus
 * its range when it is a file). Directories get a trailing "/" and no range.
 * A single trailing space is added unless whitespace already follows.
 */
export function applyMention(
  text: string,
  cursor: number,
  trigger: MentionTrigger,
  entry: { path: string; type: "file" | "dir" },
  range?: MentionRange,
): { text: string; cursor: number } {
  const end = Math.max(trigger.start, Math.min(cursor, text.length));
  const suffix = text.slice(end);
  if (entry.type === "dir") {
    // Drilling in: `#dir/` with no trailing space so the query keeps
    // filtering inside the directory (the picker stays open).
    const token = `#${entry.path}/`;
    return { text: text.slice(0, trigger.start) + token + suffix, cursor: trigger.start + token.length };
  }
  const token = `#${entry.path}${formatMentionRange(range)}`;
  const needsSpace = suffix.length === 0 || !/^\s/.test(suffix);
  const insertion = needsSpace ? `${token} ` : token;
  const next = text.slice(0, trigger.start) + insertion + suffix;
  return { text: next, cursor: trigger.start + insertion.length };
}

/** Every mention token in `text`, left to right (server-side expansion). */
export function parseMentions(text: string): Mention[] {
  const out: Mention[] = [];
  const re = /(?:^|\s)#([^\s#]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    // Trim sentence punctuation that commonly follows a mention
    // ("see #src/foo.ts." → "src/foo.ts").
    const raw = (match[1] ?? "").replace(/[.,;!?)\]}'"]+$/, "");
    if (raw.length === 0) continue;
    const { pathQuery, range } = splitMentionQuery(raw);
    if (pathQuery.length === 0) continue;
    out.push({ raw: `#${raw}`, path: pathQuery, ...(range !== undefined ? { from: range.from } : {}), ...(range?.to !== undefined ? { to: range.to } : {}) });
  }
  return out;
}

// --- leaf display (opencode's file chips show the basename) ----------------

/** The basename of a workspace-relative path ("src/foo.ts" → "foo.ts"). */
export function mentionLeaf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(slash + 1) : path;
}

/**
 * The shortest trailing path suffix that is not already `taken` — so the
 * composer can show `#button.tsx` normally, `#components/button.tsx` when a
 * second file shares the basename, etc. Falls back to the full path.
 */
export function mentionDisplayToken(path: string, taken: Iterable<string> = []): string {
  const parts = path.split("/").filter((s) => s.length > 0);
  const used = new Set(taken);
  for (let i = 1; i <= parts.length; i++) {
    const candidate = parts.slice(parts.length - i).join("/");
    if (!used.has(candidate)) return candidate;
  }
  return path;
}

/**
 * Rewrite leaf display tokens back to their full workspace-relative paths
 * (ranges preserved) just before submit. Tokens without a mapping are left
 * untouched, so typed `#path:range` mentions still work.
 */
export function expandMentionPaths(text: string, paths: Record<string, string>): string {
  if (!text.includes("#") || Object.keys(paths).length === 0) return text;
  return text.replace(/(^|\s)#([^\s#]+)/g, (whole, lead: string, raw: string) => {
    const { pathQuery, range } = splitMentionQuery(raw);
    const target = paths[pathQuery];
    if (target === undefined) return whole;
    return `${lead}#${target}${formatMentionRange(range)}`;
  });
}

/** One run of plain text or a mention, for transcript rendering. */
export interface MentionSegment {
  type: "text" | "mention";
  /** Plain text for text runs; the `#token` for mentions. */
  text: string;
  /** Workspace-relative path (mentions only). */
  path?: string;
  from?: number;
  to?: number;
}

/**
 * Split a stored message body into text and mention segments so surfaces can
 * render mentions as chips (leaf label) with the full path kept for tooltips
 * and click-to-open. Stored bodies carry the expanded full path, so the leaf
 * is derived at render time. Trailing sentence punctuation stays in the text
 * run.
 */
export function splitMentions(text: string): MentionSegment[] {
  const out: MentionSegment[] = [];
  const re = /(^|\s)#([^\s#]+)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const lead = match[1] ?? "";
    const rawFull = match[2] ?? "";
    const tokenStart = match.index + lead.length;
    const trimmed = rawFull.replace(/[.,;!?)\]}'"]+$/, "");
    if (trimmed.length === 0) continue;
    const { pathQuery, range } = splitMentionQuery(trimmed);
    if (pathQuery.length === 0) continue;
    if (tokenStart > last) out.push({ type: "text", text: text.slice(last, tokenStart) });
    out.push({
      type: "mention",
      text: `#${trimmed}`,
      path: pathQuery,
      ...(range !== undefined ? { from: range.from } : {}),
      ...(range?.to !== undefined ? { to: range.to } : {}),
    });
    last = tokenStart + 1 + trimmed.length;
  }
  if (last < text.length) out.push({ type: "text", text: text.slice(last) });
  return out;
}

/**
 * Inverse of `expandMentionPaths`: collapse full-path mention tokens in a
 * stored/seeded draft back to their shortest unique leaf, returning the
 * display text plus the token→path map the composer needs to re-expand at
 * submit. Only multi-segment file paths are collapsed (a bare `#foo` is
 * already a leaf, and an explicit `#dir/` reference is left alone). Used when
 * seeding the composer after revert / fork / edit-queued, so those flows keep
 * the leaf display instead of resurrecting the full path.
 */
export function collapseMentions(
  text: string,
  taken: Iterable<string> = [],
): { text: string; paths: Record<string, string> } {
  const paths: Record<string, string> = {};
  const used = new Set(taken);
  const out = text.replace(/(^|\s)#([^\s#]+)/g, (whole, lead: string, raw: string) => {
    const trimmed = raw.replace(/[.,;!?)\]}'"]+$/, "");
    const { pathQuery, range } = splitMentionQuery(trimmed);
    if (!pathQuery.includes("/") || pathQuery.endsWith("/")) return whole;
    const token = mentionDisplayToken(pathQuery, used);
    used.add(token);
    paths[token] = pathQuery;
    const trailing = raw.slice(trimmed.length);
    return `${lead}#${token}${formatMentionRange(range)}${trailing}`;
  });
  return { text: out, paths };
}
