/**
 * Shared Lucide icon helpers for the web UI (icon pack: lucide-react).
 *
 * One place for the status/disclosure semantics so both ToolNodes
 * implementations (chat pane + subagent stream) render identical glyphs.
 * The TUI keeps its own terminal text glyphs — never share icon components
 * across surfaces.
 */
import {
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  LoaderCircle,
  TriangleAlert,
  X,
} from "lucide-react";

/** Icon size for glyphs that sit inline with 12–13px text rows. */
const GLYPH_SIZE = 12;

/**
 * Status glyph for tool-call rows: needs-approval (TriangleAlert) /
 * running (Circle) / error (X) / done (Check) — previously unicode text
 * chars (⚠ ◦ ✗ ✓) colored via the .tool-glyph-* classes.
 */
export function ToolStatusIcon({
  status,
  asking = false,
}: {
  status: string;
  /** Pending ask on a tracked task child — overrides the status glyph. */
  asking?: boolean;
}) {
  const Icon = asking
    ? TriangleAlert
    : status === "running"
      ? Circle
      : status === "error"
        ? X
        : Check;
  return (
    <span className={`tool-glyph tool-glyph-${status}`}>
      <Icon size={GLYPH_SIZE} aria-hidden="true" />
    </span>
  );
}

/** Head-of-stream status for a live child transcript: alert / spinner / check. */
export function SubagentStatusIcon({
  asking,
  active,
}: {
  asking: boolean;
  active: boolean;
}) {
  if (asking) return <TriangleAlert size={GLYPH_SIZE} aria-hidden="true" />;
  if (active) {
    return <LoaderCircle size={GLYPH_SIZE} className="icon-spin" aria-hidden="true" />;
  }
  return <Check size={GLYPH_SIZE} aria-hidden="true" />;
}

/**
 * Warning triangle for a built-in tool/agent shadowed by a user file
 * override. The `data-tooltip` text rides the global TooltipLayer on
 * hover/focus (tooltip.tsx) — no local tooltip state needed.
 */
export function OverrideWarning({ kind }: { kind: "tool" | "agent" }) {
  return (
    <span
      className="override-warning"
      data-tooltip={`This ${kind} has been overridden, reset changes if it does not work as intended`}
      role="img"
      aria-label={`This ${kind} has been overridden`}
    >
      <TriangleAlert size={GLYPH_SIZE} aria-hidden="true" />
    </span>
  );
}

/** Disclosure chevron for collapsible thought sections (▾/▸ previously). */
export function Chevron({ open }: { open: boolean }) {
  return open ? (
    <ChevronDown size={GLYPH_SIZE} aria-hidden="true" />
  ) : (
    <ChevronRight size={GLYPH_SIZE} aria-hidden="true" />
  );
}
