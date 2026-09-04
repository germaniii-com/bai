import type { Event, Session } from "@bai/shared";
import { argsDigest } from "./state";

/**
 * Live subagent tracking for the web chat pane (TUI parity — the port of
 * the TUI's state/subagents.ts): the children of the ACTIVE session
 * (meta.parent) and their current activity, derived entirely from the
 * global firehose — the bus is topic-less, so child-session events ride it
 * without any extra HTTP streams. Pure reducers; App just feeds events and
 * renders, and the task tool nodes resolve their child via
 * `findChildForTask` (live status) and expand into a live transcript.
 */

/** How much of the child's latest streamed text the badge line keeps. */
const TEXT_TAIL_CHARS = 160;

/** One tracked subagent of the active session and its live activity. */
export interface SubagentActivity {
  sessionId: string;
  agent: string;
  title: string;
  running: boolean;
  /** Last tool status line, e.g. "✓ fs.read src/x.ts". */
  tool?: string;
  /** Bounded tail of the child's latest streamed text. */
  textTail?: string;
  /** A permission ask from this child is awaiting a reply. */
  needsApproval: boolean;
  /**
   * partId → kind, learned from message.part.updated. Text parts never
   * announce themselves (only thinking/tool_call/tool_result do), so an
   * UNSEEN part id streaming deltas is treated as text — that inverse is
   * what keeps tool-args JSON fragments out of the text tail.
   */
  partKinds: Record<string, string>;
}

export interface SubagentState {
  children: Map<string, SubagentActivity>;
}

export const emptySubagentState: SubagentState = { children: new Map() };

function isChildOf(session: Session, parentId: string): boolean {
  return session.meta.parent === parentId;
}

function activityFor(session: Session): SubagentActivity {
  const agent = typeof session.meta.agent === "string" ? session.meta.agent : "agent";
  return { sessionId: session.id, agent, title: session.title, running: false, needsApproval: false, partKinds: {} };
}

/**
 * Rebuild the child set from the session lists (parent switch, list
 * refresh), preserving whatever live activity is already tracked. Children
 * of other parents are dropped.
 */
export function trackSubagents(prev: SubagentState, sessions: Session[], parentId: string | undefined): SubagentState {
  const children = new Map<string, SubagentActivity>();
  if (parentId !== undefined) {
    for (const session of sessions) {
      if (!isChildOf(session, parentId)) continue;
      const existing = prev.children.get(session.id);
      children.set(session.id, existing ?? activityFor(session));
    }
  }
  return { children };
}

/**
 * Apply one firehose event. Only events belonging to a tracked child (or a
 * `session.created` that introduces one) change state; everything else is
 * passed through untouched.
 */
export function applySubagentEvent(state: SubagentState, evt: Event, activeId: string | undefined): SubagentState {
  if (activeId === undefined) return state;

  if (evt.type === "session.created") {
    const session = (evt.payload as { session?: Session }).session;
    if (session === undefined || !isChildOf(session, activeId) || state.children.has(session.id)) return state;
    const children = new Map(state.children);
    children.set(session.id, activityFor(session));
    return { children };
  }

  const id = evt.sessionId;
  if (id === undefined) return state;
  const current = state.children.get(id);
  if (current === undefined) return state;

  let next: SubagentActivity | undefined;
  switch (evt.type) {
    case "run.started":
      next = { ...current, running: true };
      break;
    case "run.finished":
      next = { ...current, running: false };
      break;
    case "permission.asked":
      next = { ...current, needsApproval: true };
      break;
    case "permission.replied":
      next = { ...current, needsApproval: false };
      break;
    case "message.created":
      // A new message starts a fresh tail and a fresh part-id namespace.
      next = { ...current, textTail: undefined, partKinds: {} };
      break;
    case "message.part.updated": {
      const { partId, kind, payload } = evt.payload as {
        partId: string;
        kind: string;
        payload: Record<string, unknown>;
      };
      const partKinds = { ...current.partKinds, [partId]: kind };
      if (kind === "tool_call") {
        const name = typeof payload.name === "string" ? payload.name : "tool";
        const digest = argsDigest(name, typeof payload.args === "string" ? payload.args : "");
        next = { ...current, partKinds, tool: `◦ ${name}${digest.length > 0 ? ` ${digest}` : ""}` };
      } else if (kind === "tool_result") {
        // The result payload has no tool name — reuse the one the call
        // announcement established.
        const priorName = current.tool?.replace(/^[◦✓✗] /, "").replace(/ .*$/, "") ?? "tool";
        next = { ...current, partKinds, tool: `${payload.isError === true ? "✗" : "✓"} ${priorName}` };
      } else if (kind === "text") {
        const text = typeof payload.text === "string" ? payload.text : "";
        next = {
          ...current,
          partKinds,
          ...(text.length > 0 ? { textTail: text.slice(-TEXT_TAIL_CHARS) } : {}),
        };
      } else {
        next = { ...current, partKinds };
      }
      break;
    }
    case "message.part.delta": {
      const { partId, delta } = evt.payload as { partId?: unknown; delta?: unknown };
      if (typeof partId !== "string" || typeof delta !== "string" || delta.length === 0) break;
      // Only live text streams into the tail; tool-args deltas are noise.
      if ((current.partKinds[partId] ?? "text") !== "text" || !current.running) break;
      next = { ...current, textTail: ((current.textTail ?? "") + delta).slice(-TEXT_TAIL_CHARS) };
      break;
    }
    default:
      break;
  }

  if (next === undefined) return state;
  const children = new Map(state.children);
  children.set(id, next);
  return { children };
}

/**
 * Rows: asks first (they block the run), then running, then finished —
 * stable by session id within a tier.
 */
export function subagentRows(state: SubagentState): SubagentActivity[] {
  const rank = (a: SubagentActivity): number => (a.needsApproval ? 0 : a.running ? 1 : 2);
  return [...state.children.values()].sort(
    (a, b) => rank(a) - rank(b) || a.sessionId.localeCompare(b.sessionId),
  );
}

/**
 * Match a task node to its tracked child: the result payload's session link
 * when the result landed, else the child whose title the task tool built
 * from the same description + agent (`"<desc> (@<agent> subagent)")` — that
 * is how running tasks (no result yet) resolve exactly, so clicks and live
 * status target the right child even mid-flight.
 */
export function findChildForTask(
  children: Map<string, SubagentActivity>,
  rawArgs: string,
  resultSessionId: string | undefined,
): SubagentActivity | undefined {
  if (resultSessionId !== undefined) {
    const byId = children.get(resultSessionId);
    if (byId !== undefined) return byId;
  }
  try {
    const parsed = JSON.parse(rawArgs) as { description?: unknown; subagent_type?: unknown };
    if (typeof parsed.description === "string" && typeof parsed.subagent_type === "string") {
      const title = `${parsed.description.trim()} (@${parsed.subagent_type} subagent)`;
      for (const child of children.values()) {
        if (child.title === title) return child;
      }
    }
  } catch {
    // Args may still be streaming (partial JSON) — no match then.
  }
  return undefined;
}
