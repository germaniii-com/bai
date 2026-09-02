import { evaluatePermission } from "./engine";
import type { AskDetail, PermissionAction, Session } from "@bai/shared";
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
  // The agent asking the user questions / tracking todos IS the interaction —
  // gating it behind a permission ask would deadlock the conversation.
  question: "allow",
  todo: "allow",
  // plan.write is root-restricted to the plans dir inside the tool itself;
  // plan.exit's gate is the user answering its embedded question.
  "plan.write": "allow",
  "plan.exit": "allow",
};

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
}

export interface GateDeps {
  store: Store;
  bus: Bus;
  log: EventLog;
  clock: Clock;
  config(): { permissions: Record<string, PermissionAction> };
}

interface Resolver {
  (result: { approved: boolean; feedback?: string }): void;
}

export class PermissionGate {
  private resolvers = new Map<string, Resolver>();

  constructor(private deps: GateDeps) {}

  /**
   * Evaluate + possibly ask. Resolves `{allowed: true}` when the call may
   * proceed; a denial may carry `feedback` from the user's reject message.
   * `sessionId` scopes asks/approvals; approvals live in session meta.
   * `detail` (summary/diff) rides the `permission.asked` payload for
   * surface rendering.
   */
  async authorize(input: {
    tool: string;
    sessionId?: string;
    metadata?: Record<string, unknown>;
    detail?: AskDetail;
  }): Promise<AuthorizeResult> {
    const session = input.sessionId !== undefined ? this.deps.store.sessions.get(input.sessionId) : undefined;
    const layers = this.layers(session);
    const verdict = evaluatePermission(input.tool, layers);
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
    const result = await new Promise<{ approved: boolean; feedback?: string }>((resolve) => {
      this.resolvers.set(request.id, resolve);
    });
    return { allowed: result.approved, ...(result.feedback !== undefined ? { feedback: result.feedback } : {}) };
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
    const resolve = this.resolvers.get(id);
    const request = this.deps.store.permissions.get(id);
    this.resolvers.delete(id);
    if (resolve !== undefined) {
      resolve({
        approved: status === "approved",
        ...(status === "rejected" && message !== undefined && message.length > 0 ? { feedback: message } : {}),
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

  /** Ordered rule layers: defaults < config < session approvals. */
  private layers(session: Session | undefined): Array<Record<string, PermissionAction>> {
    const configLayer = this.deps.config().permissions ?? {};
    const approvals = (session?.meta as { approvals?: Record<string, PermissionAction> } | undefined)?.approvals ?? {};
    return [DEFAULT_PERMISSIONS, configLayer, approvals];
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
