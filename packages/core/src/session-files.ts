import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isPrefixed, isValidAgentName, type PlanFile, type SessionId } from "@bai/shared";

/**
 * Session-scoped files: the plan agent's markdown plans and the user's
 * `notes.md`, stored under `<dataDir>/sessions/<sessionId>/` so they are
 * portable between surfaces (web/TUI) and survive independently of the
 * SQLite session row. The checklist is NOT here — it stays in
 * `session.meta.todos` (the `todo` tool's store).
 *
 * Layout:
 *   <root>/<sessionId>/notes.md
 *   <root>/<sessionId>/plans/<name>.md
 *
 * Every write is atomic (temp file in the same directory + rename), and
 * every path component is guarded: the session id must be a real `ses_*`
 * id, plan names must pass `isValidAgentName`, and the resolved path must
 * stay under the session directory (escape check before any IO).
 */

/** Upper bound on a single note/plan body (matches the API zod caps). */
export const SESSION_FILE_MAX_BYTES = 200_000;

function assertSessionId(sessionId: string): asserts sessionId is SessionId {
  if (!isPrefixed(sessionId, "ses")) {
    throw new Error(`Invalid session id: ${sessionId}`);
  }
}

function assertPlanName(name: string): void {
  if (!isValidAgentName(name)) {
    throw new Error("Plan names start with a letter and may contain only letters, digits, '-' and '_' (max 64 chars).");
  }
}

/** `<root>/<sessionId>` — the session's artifact directory. */
export function sessionDir(root: string, sessionId: string): string {
  assertSessionId(sessionId);
  return path.join(root, sessionId);
}

/** `<root>/<sessionId>/plans`. */
export function sessionPlansDir(root: string, sessionId: string): string {
  return path.join(sessionDir(root, sessionId), "plans");
}

function planFilePath(root: string, sessionId: string, name: string): string {
  assertPlanName(name);
  const dir = sessionPlansDir(root, sessionId);
  const file = path.join(dir, `${name}.md`);
  // Root enforcement: resolve and prefix-check BEFORE any IO.
  const resolvedRoot = path.resolve(dir);
  const resolved = path.resolve(file);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`Plan path escapes the session directory: ${resolved}`);
  }
  return resolved;
}

function notesFilePath(root: string, sessionId: string): string {
  const dir = sessionDir(root, sessionId);
  const file = path.join(dir, "notes.md");
  const resolvedRoot = path.resolve(dir);
  const resolved = path.resolve(file);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`Notes path escapes the session directory: ${resolved}`);
  }
  return resolved;
}

/** Atomic write (temp file in the same dir + rename), mkdir on demand. */
function atomicWrite(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}

function planMeta(file: string, name: string): PlanFile {
  const stat = statSync(file);
  return { name, bytes: stat.size, updatedAt: new Date(stat.mtimeMs).toISOString() };
}

// --- plans ---

/** Every valid plan file for a session, sorted by name. Missing dir → []. */
export function listPlans(root: string, sessionId: string): PlanFile[] {
  const dir = sessionPlansDir(root, sessionId);
  if (!existsSync(dir)) return [];
  const plans: PlanFile[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".md")) continue;
    const name = entry.slice(0, -".md".length);
    if (!isValidAgentName(name)) continue;
    try {
      plans.push(planMeta(path.join(dir, entry), name));
    } catch {
      // A file that vanished between readdir and stat is skipped.
    }
  }
  return plans.sort((a, b) => a.name.localeCompare(b.name));
}

/** Read one plan's markdown; undefined when absent. */
export function readPlan(root: string, sessionId: string, name: string): string | undefined {
  const file = planFilePath(root, sessionId, name);
  if (!existsSync(file)) return undefined;
  return readFileSync(file, "utf8");
}

/** Create or replace one plan; returns its metadata. */
export function writePlan(root: string, sessionId: string, name: string, content: string): PlanFile {
  const file = planFilePath(root, sessionId, name);
  atomicWrite(file, content);
  return planMeta(file, name);
}

/** Remove one plan; false when absent. */
export function deletePlan(root: string, sessionId: string, name: string): boolean {
  const file = planFilePath(root, sessionId, name);
  if (!existsSync(file)) return false;
  rmSync(file);
  return true;
}

// --- notes ---

/** Read the session note; null when the file is absent. */
export function readNotes(root: string, sessionId: string): string | null {
  const file = notesFilePath(root, sessionId);
  if (!existsSync(file)) return null;
  return readFileSync(file, "utf8");
}

/** Create or replace the session note (empty content keeps an empty file). */
export function writeNotes(root: string, sessionId: string, content: string): void {
  atomicWrite(notesFilePath(root, sessionId), content);
}
