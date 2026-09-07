import type { Event } from "@bai/shared";

/**
 * Live file-change detection for the workspace file viewer (pure reducer,
 * mirrors state-subagents.ts): consumes GLOBAL firehose events and reports
 * which absolute paths the agent just created/modified/deleted inside the
 * viewed workspace. The App feeds the returned paths to the change-dot
 * state and the viewer/tree refresh trigger.
 *
 * Two signals, deduped by the caller:
 *
 * - `patch` parts (git workspaces): after each mutating tool batch the
 *   snapshot emits the changed-file list — covers bash writes too. Paths
 *   are relative to the OWNING SESSION's cwd (subagents inherit it).
 * - `fs.write` / `fs.edit` tool results (any workspace): the tool_call
 *   part's streamed args carry `path`. The result payload has no tool
 *   name, so calls are tracked from the announcement (callId → name)
 *   through arg deltas (partId → callId) until the result lands.
 *
 * Paths resolve against the owning session's cwd (looked up by the caller
 * from the known session lists; the viewed root is the fallback), then
 * filter to paths inside the viewed workspace root. Browser bundle — no
 * node:path; small local helpers only.
 */

export interface FileWatchState {
  /** Streaming tool calls: `${sessionId}:${callId}` → { name, args }. */
  calls: Map<string, { name: string; args: string }>;
  /** Streaming part ids → callId (arg deltas carry partId, not callId). */
  parts: Map<string, string>;
}

export const emptyFileWatch: FileWatchState = { calls: new Map(), parts: new Map() };

export interface FileWatchContext {
  /** The viewed workspace root — only changes inside it are reported. */
  root: string | null;
  /** Session id → cwd (known session lists; subagents inherit the parent's). */
  sessionCwd: (sessionId: string) => string | undefined;
}

/** Tools whose successful execution mutates a file at args.path. */
const MUTATING_FS_TOOLS = new Set(["fs.write", "fs.edit"]);

/**
 * Consume one firehose event; returns the absolute workspace paths it
 * changed (empty for most events). Mutates `state` (it is held in a ref,
 * not React state) and stays deterministic per event.
 */
export function applyFileWatch(state: FileWatchState, evt: Event, ctx: FileWatchContext): string[] {
  if (ctx.root === null) return [];
  const sessionId = evt.sessionId;
  if (sessionId === undefined) return [];
  const key = (callId: string): string => `${sessionId}:${callId}`;

  switch (evt.type) {
    case "message.part.updated": {
      const { partId, kind, payload } = evt.payload;
      if (kind === "tool_call") {
        const p = payload as { callId?: unknown; name?: unknown; args?: unknown };
        if (typeof p.callId !== "string") return [];
        state.parts.set(`${sessionId}:${partId}`, p.callId);
        state.calls.set(key(p.callId), {
          name: typeof p.name === "string" ? p.name : "unknown",
          args: typeof p.args === "string" ? p.args : "",
        });
        return [];
      }
      if (kind === "tool_result") {
        const p = payload as { callId?: unknown; isError?: unknown };
        if (typeof p.callId !== "string") return [];
        const call = state.calls.get(key(p.callId));
        state.calls.delete(key(p.callId));
        if (call === undefined || p.isError === true) return [];
        if (!MUTATING_FS_TOOLS.has(call.name)) return [];
        const raw = argPath(call.args);
        return raw === undefined ? [] : filterChanged(ctx, sessionId, raw);
      }
      if (kind === "patch") {
        const p = payload as { files?: unknown };
        if (!Array.isArray(p.files)) return [];
        return p.files.flatMap((f: unknown) => (typeof f === "string" ? filterChanged(ctx, sessionId, f) : []));
      }
      return [];
    }
    case "message.part.delta": {
      const { partId, delta } = evt.payload;
      if (delta.length === 0) return [];
      const callId = state.parts.get(`${sessionId}:${partId}`);
      if (callId === undefined) return [];
      const call = state.calls.get(key(callId));
      if (call !== undefined) call.args += delta;
      return [];
    }
    case "run.finished": {
      // Hygiene: announced calls that never produced a result (aborted runs)
      // would otherwise linger for the session's lifetime.
      const prefix = `${sessionId}:`;
      for (const k of [...state.calls.keys()]) if (k.startsWith(prefix)) state.calls.delete(k);
      for (const k of [...state.parts.keys()]) if (k.startsWith(prefix)) state.parts.delete(k);
      return [];
    }
    default:
      return [];
  }
}

/** The `path` field of a tool's args JSON (undefined when unparseable). */
function argPath(args: string): string | undefined {
  try {
    const parsed = JSON.parse(args) as { path?: unknown };
    return typeof parsed.path === "string" && parsed.path.trim().length > 0 ? parsed.path.trim() : undefined;
  } catch {
    return undefined; // args may still be streaming — nothing to act on yet
  }
}

/** Resolve `raw` against the session's cwd (root as fallback); keep only
 * paths inside the viewed root. Returns the normalized absolute path. */
function filterChanged(ctx: FileWatchContext, sessionId: string, raw: string): string[] {
  const root = ctx.root;
  if (root === null) return [];
  const base = ctx.sessionCwd(sessionId) ?? root;
  const abs = resolveFrom(base, raw);
  return insideRoot(root, abs) ? [abs] : [];
}

// --- browser-safe path helpers (no node:path in the web bundle) -------------

function isAbs(p: string): boolean {
  return p.startsWith("/");
}

/** Lexical normalize: collapse `//`, drop `.` segments, apply `..`. */
function normalize(p: string): string {
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (part.length === 0 || part === ".") continue;
    if (part === "..") {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return `/${out.join("/")}`;
}

function resolveFrom(base: string, p: string): string {
  return isAbs(p) ? normalize(p) : normalize(`${base}/${p}`);
}

function insideRoot(root: string, abs: string): boolean {
  const r = normalize(root);
  return abs === r || abs.startsWith(r.endsWith("/") ? r : `${r}/`);
}
