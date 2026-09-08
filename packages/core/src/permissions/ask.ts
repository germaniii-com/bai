import { evaluatePermission } from "./engine";
import path from "node:path";
import type { AskDetail, AskOutcome, PermissionAction, Session } from "@bai/shared";
import type { Bus } from "../event/bus";
import type { EventLog } from "../event/log";
import type { Clock } from "@bai/shared";
import type { Store } from "../store/store";

/**
 * The interactive permission gate for tool calls (ARCHITECTURE.md §9):
 *
 *   defaults  <  config.permissions  <  session approvals ("always")
 *
 * last matching pattern wins; unmatched → "ask" (fail-closed). "allow" and
 * "deny" resolve immediately; "ask" persists a PermissionRequest row, emits
 * the durable `permission.asked` event to every surface, and awaits the
 * first reply (SQL `WHERE status='pending'` enforces first-reply-wins at the
 * row level; the gate resolves the awaiting tool call once).
 *
 * "always" approvals persist in `session.meta.approvals` — session-scoped
 * per the architecture, durable across restarts, never global.
 *
 * A rejection may carry user feedback (opencode's CorrectedError): the
 * denied tool result tells the model WHY the user refused, so it can adapt
 * instead of retrying blind.
 */

/** Tools that are safe to auto-allow (read-only fs + agent→user interactive tools). */
export const DEFAULT_PERMISSIONS: Record<string, PermissionAction> = {
  "fs.read": "allow",
  "fs.list": "allow",
  "fs.glob": "allow",
  // skills.view reads the user's own skill files (traversal-guarded inside
  // the tool) — read-only knowledge loading, same stance as fs.read.
  "skills.view": "allow",
  // Skill authoring (the learn flow): both tools are root-restricted to
  // ~/.config/bai/skills inside the tool (the plan.write stance) — a
  // knowledge-base learn writes dozens of chapter files and must not spam
  // permission asks.
  "skills.save": "allow",
  "skills.writeFile": "allow",
  // Surgical edits + deletion stay rooted inside the skills dir (symlink/
  // skills-root guards in the tool); deleting a bundled skill is sticky —
  // the sync manifest never reseeds it.
  "skills.patch": "allow",
  "skills.delete": "allow",
  // The agent asking the user questions / tracking todos IS the interaction —
  // gating it behind a permission ask would deadlock the conversation.
  question: "allow",
  todo: "allow",
  // plan.write is root-restricted to the plans dir inside the tool itself;
  // plan.exit's gate is the user answering its embedded question.
  "plan.write": "allow",
  "plan.exit": "allow",
};

/** fs tools whose path argument can be checked against the session cwd. */
const FS_TOOLS = new Set(["fs.read", "fs.list", "fs.glob", "fs.grep", "fs.write", "fs.edit"]);

/**
 * Whether the fs tool's target resolves INSIDE the session working
 * directory (the cwd-relative default: edits/writes there are silently
 * allowed; outside it they still ask). Relative paths resolve against cwd
 * exactly like the fs tools' rooting; fs.list/fs.glob without an explicit
 * path operate on the cwd itself.
 */
export function fsPathInsideCwd(tool: string, metadata: Record<string, unknown> | undefined, cwd: string): boolean {
  if (!FS_TOOLS.has(tool)) return false;
  const raw = metadata?.path;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return tool === "fs.list" || tool === "fs.glob";
  }
  const abs = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(cwd, raw);
  const rel = path.relative(cwd, abs);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export interface PermissionDecision {
  action: PermissionAction;
  rule?: string;
  /** True when the decision came from the interactive ask (not a static rule). */
  interactive?: boolean;
}

/** Result of a permission check — denial may carry the user's feedback. */
export interface AuthorizeResult {
  allowed: boolean;
  /** Rejection feedback typed by the user; undefined for bare denials. */
  feedback?: string;
  /**
   * True when the wait ended because the run was interrupted (not a user
   * verdict) — the caller treats it as a denial and its drain breaks on the
   * aborted signal anyway.
   */
  cancelled?: boolean;
  /**
   * The answered interactive ask, when one was raised (static allow/deny
   * never asks). The executor stamps it onto the tool_result part so the
   * transcript retains what was approved/refused — re-openable review,
   * surviving reloads like any history-backed part.
   */
  ask?: AskOutcome;
}

export interface GateDeps {
  store: Store;
  bus: Bus;
  log: EventLog;
  clock: Clock;
  config(): { permissions: Record<string, PermissionAction> };
}

/** An ask awaiting its first reply (or an interrupt). */
interface PendingAsk {
  resolve: (result: {
    approved: boolean;
    feedback?: string;
    cancelled?: boolean;
    /** The reply's scope ("always" persists the session approval). */
    scope?: "once" | "always";
  }) => void;
  /** Removes the abort listener once the wait ends any other way. */
  cleanup: () => void;
}

export class PermissionGate {
  private resolvers = new Map<string, PendingAsk>();

  constructor(private deps: GateDeps) {}

  /**
   * Evaluate + possibly ask. Resolves `{allowed: true}` when the call may
   * proceed; a denial may carry `feedback` from the user's reject message.
   * `sessionId` scopes asks/approvals; approvals live in session meta.
   * `detail` (summary/diff) rides the `permission.asked` payload for
   * surface rendering. `signal` is the drain's AbortSignal: an interrupted
   * run must never park on an unanswered ask (QuestionService's abort
   * handling is the precedent) — the row flips to rejected, every surface
   * is told via `permission.replied`, and the wait resolves cancelled.
   * `cwd` enables the cwd-relative default: an fs tool targeting a path
   * inside the session's working directory is allowed by default (config
   * rules and session approvals still win — they sit above the default
   * layer), anything outside keeps asking.
   */
  async authorize(input: {
    tool: string;
    sessionId?: string;
    metadata?: Record<string, unknown>;
    detail?: AskDetail;
    signal?: AbortSignal;
    cwd?: string;
  }): Promise<AuthorizeResult> {
    const session = input.sessionId !== undefined ? this.deps.store.sessions.get(input.sessionId) : undefined;
    const verdict = evaluatePermission(input.tool, this.layers(session, input));
    if (verdict.action === "allow") return { allowed: true };
    if (verdict.action === "deny") return { allowed: false };

    // Static rules say "ask" — raise the interactive request.
    const request = this.deps.store.permissions.insert({
      sessionId: (input.sessionId ?? undefined) as never,
      tool: input.tool,
      argsDigest: digest(input.metadata ?? {}),
      ...(input.detail !== undefined ? { detail: input.detail } : {}),
      now: this.deps.clock.iso(),
    });
    this.emitDurable(input.sessionId, "permission.asked", { request });
    const result = await new Promise<{
      approved: boolean;
      feedback?: string;
      cancelled?: boolean;
      scope?: "once" | "always";
    }>((resolve) => {
      // One latch for both endings (user verdict vs interrupt): whichever
      // lands first wins, the loser is a no-op. The pre-aborted branch runs
      // onAbort before the entry is registered, so liveness can't key on
      // the resolvers map.
      let settled = false;
      const finish = (value: { approved: boolean; feedback?: string; cancelled?: boolean }) => {
        if (settled) return;
        settled = true;
        this.resolvers.delete(request.id);
        input.signal?.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const onAbort = () => {
        if (settled) return;
        this.deps.store.permissions.reply(request.id, "rejected");
        this.emitDurable(input.sessionId, "permission.replied", {
          requestId: request.id,
          status: "rejected",
        });
        finish({ approved: false, cancelled: true });
      };
      if (input.signal !== undefined) {
        if (input.signal.aborted) {
          onAbort();
          return;
        }
        input.signal.addEventListener("abort", onAbort, { once: true });
      }
      this.resolvers.set(request.id, {
        resolve: (value) => finish(value),
        cleanup: () => input.signal?.removeEventListener("abort", onAbort),
      });
    });
    // An interactive ask was raised and answered — hand the outcome back so
    // the executor can retain it on the tool_result (transcript review).
    // An interrupt resolves cancelled: the row was flipped to rejected.
    const ask: AskOutcome = {
      status: result.approved ? "approved" : "rejected",
      scope: result.scope ?? "once",
      ...(result.feedback !== undefined && result.feedback.length > 0 ? { message: result.feedback } : {}),
      ...(input.detail !== undefined ? { detail: input.detail } : {}),
    };
    return {
      allowed: result.approved,
      ...(result.feedback !== undefined ? { feedback: result.feedback } : {}),
      ...(result.cancelled === true ? { cancelled: true } : {}),
      ask,
    };
  }

  /**
   * Reply to a pending ask. `always` records a session approval (meta) so
   * the same tool is auto-allowed for the rest of the session; a rejection
   * may carry `message` — the user's feedback to the model. Returns the
   * updated row (first reply wins; later replies are no-ops).
   */
  reply(
    id: string,
    status: "approved" | "rejected",
    scope: "once" | "always",
    message?: string,
  ): { sessionId?: string; tool: string } | undefined {
    const entry = this.resolvers.get(id);
    const request = this.deps.store.permissions.get(id);
    this.resolvers.delete(id);
    entry?.cleanup();
    if (entry !== undefined) {
      entry.resolve({
        approved: status === "approved",
        ...(status === "rejected" && message !== undefined && message.length > 0 ? { feedback: message } : {}),
        scope,
      });
    }
    if (request === undefined) return undefined;
    if (status === "approved" && scope === "always" && request.sessionId !== undefined) {
      const session = this.deps.store.sessions.get(request.sessionId);
      if (session !== undefined) {
        const meta = { ...(session.meta as Record<string, unknown>) };
        const approvals = { ...((meta.approvals as Record<string, PermissionAction> | undefined) ?? {}) };
        approvals[request.tool] = "allow";
        meta.approvals = approvals;
        this.deps.store.sessions.update(request.sessionId, { meta, now: this.deps.clock.iso() });
      }
    }
    return { sessionId: request.sessionId ?? undefined, tool: request.tool };
  }

  /**
   * Ordered rule layers: defaults < config < session approvals. The default
   * layer is arg-aware: an fs tool targeting the session cwd defaults to
   * allow (fail-closed everywhere else). Config entries and approvals
   * override it — last matching pattern wins.
   */
  private layers(
    session: Session | undefined,
    input: { tool: string; metadata?: Record<string, unknown>; cwd?: string },
  ): Array<Record<string, PermissionAction>> {
    const defaults: Record<string, PermissionAction> = { ...DEFAULT_PERMISSIONS };
    if (input.cwd !== undefined && fsPathInsideCwd(input.tool, input.metadata, input.cwd)) {
      defaults[input.tool] = "allow";
    }
    const configLayer = this.deps.config().permissions ?? {};
    const approvals = (session?.meta as { approvals?: Record<string, PermissionAction> } | undefined)?.approvals ?? {};
    return [defaults, configLayer, approvals];
  }

  private emitDurable(sessionId: string | undefined, type: Parameters<EventLog["append"]>[1], payload: unknown): void {
    const evt = this.deps.log.append(sessionId ?? "permissions", type, payload, this.deps.clock.iso());
    this.deps.bus.publish(evt);
  }
}

function digest(metadata: Record<string, unknown>): string {
  const json = JSON.stringify(metadata);
  // FNV-1a — short, stable, enough to correlate an ask with its call.
  let hash = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    hash ^= json.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}
