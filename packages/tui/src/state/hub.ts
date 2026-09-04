import type { Session } from "@bai/shared";

/**
 * The composer hub's STATUS ROW — the centralized strip under the input
 * (the composer is the single source of context in the TUI: no header).
 *
 * Layout: contextual session/workspace label on the LEFT, the mode badge +
 * agent chip + model chip RIGHT-ALIGNED on the right. The agent/model/sessions
 * chips are clickable via the TUI's SGR mouse support: `layoutHubStatus`
 * computes each chip's half-open column range so the chat view's mouse
 * handler can hit-test without measuring rendered output (pure column math,
 * unit-tested here). Rendering must follow the exact segment order this
 * module defines: left, `gap` spaces, mode, " · ", agent, " · ", model.
 */

/** Truncate to `max` columns, appending an ellipsis when cut. */
export function truncate(text: string, max: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function basename(path: string): string {
  const parts = path.split("/").filter((s) => s.length > 0);
  return parts[parts.length - 1] ?? path;
}

/**
 * The contextual left label: draft state (no session) → "new session"; a
 * workspace (code) session → its folder basename; a chat session →
 * workbench + title. Mirrors the old header's context line, now owned by
 * the composer.
 */
export function hubContextLabel(session: Session | null): string {
  if (session === null) return "new session";
  const cwd = typeof session.cwd === "string" ? session.cwd : "";
  if (cwd.length > 0) return basename(cwd);
  const title = session.title.length > 0 ? session.title : "(untitled)";
  return `${session.workbench} · ${title}`;
}

/** What a chip click routes to (the chat view maps these to dialogs). */
export type HubChipKind = "sessions" | "agent" | "model";

/** Half-open column range of a clickable chip within the status row. */
export interface HubChip {
  kind: HubChipKind;
  start: number;
  end: number;
}

export interface HubStatusLayout {
  /** Truncated left label (the sessions chip — empty when there is no room). */
  left: string;
  /** Spaces between the left label and the right-aligned group. */
  gap: number;
  /** "NORMAL" | "INPUT" — plain badge, not clickable. */
  modeText: string;
  /** "@build" style agent chip — "" when dropped on cramped terminals. */
  agentText: string;
  /** Model id chip — "" when dropped on cramped terminals. */
  modelText: string;
  /** Clickable column ranges, left-to-right, all within [0, width]. */
  chips: HubChip[];
}

const SEP = " · ";

/**
 * Compute the status row for `width` inner columns. The right group never
 * wraps and always survives in reduced form: the model chip truncates
 * (then drops) first, then the agent chip; the mode badge is last to go.
 * The left label absorbs whatever width remains (min 2-col gap).
 */
export function layoutHubStatus(opts: {
  width: number;
  session: Session | null;
  mode: "normal" | "input";
  agent: string;
  model: string;
}): HubStatusLayout {
  const { width, session, mode, agent, model } = opts;
  const leftFull = hubContextLabel(session);
  const modeText = mode === "normal" ? "NORMAL" : "INPUT";
  let agentText = agent.length > 0 ? `@${agent}` : "";
  let modelText = model;

  const rightLength = (a: string, m: string): number =>
    modeText.length +
    (a.length > 0 ? SEP.length + a.length : 0) +
    (m.length > 0 ? SEP.length + m.length : 0);
  const fits = (a: string, m: string): boolean => rightLength(a, m) <= width;

  // Shrink pass 1: the model chip truncates to the remaining room (min 4
  // columns), else drops entirely.
  if (modelText.length > 0 && !fits(agentText, modelText)) {
    const room =
      width - modeText.length - (agentText.length > 0 ? SEP.length + agentText.length : 0) - SEP.length;
    modelText = room >= 4 ? truncate(modelText, room) : "";
  }
  // Shrink pass 2: the agent chip truncates (min 3) around whatever model
  // survived, else drops.
  if (agentText.length > 0 && !fits(agentText, modelText)) {
    const room =
      width - modeText.length - SEP.length - (modelText.length > 0 ? SEP.length + modelText.length : 0);
    agentText = room >= 3 ? truncate(agentText, room) : "";
  }

  const rightLen = rightLength(agentText, modelText);
  const left = truncate(leftFull, Math.max(0, width - rightLen - 2));
  const gap = Math.max(0, width - left.length - rightLen);

  const chips: HubChip[] = [];
  if (left.length > 0) chips.push({ kind: "sessions", start: 0, end: left.length });
  let cursor = left.length + gap;
  if (cursor + modeText.length <= width) cursor += modeText.length;
  if (agentText.length > 0 && cursor + SEP.length + agentText.length <= width) {
    chips.push({
      kind: "agent",
      start: cursor + SEP.length,
      end: cursor + SEP.length + agentText.length,
    });
    cursor += SEP.length + agentText.length;
  }
  if (modelText.length > 0 && cursor + SEP.length + modelText.length <= width) {
    chips.push({
      kind: "model",
      start: cursor + SEP.length,
      end: cursor + SEP.length + modelText.length,
    });
  }
  return { left, gap, modeText, agentText, modelText, chips };
}
