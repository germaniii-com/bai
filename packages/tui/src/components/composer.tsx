import { Box, Text } from "ink";
import type { Editor } from "../state/composer";
import type { HubStatusLayout } from "../state/hub";
import type { Mode } from "../app";
import type { ContextTrackerView } from "@bai/shared";
import { useTheme } from "../theme";

/**
 * The centralized composer hub — the single surface under the transcript:
 *
 *   ┌──────────────────────────────────────────────┐
 *   │ › input draft with cursor block              │
 *   │ chat · title        NORMAL · @agent · model  │  ← status row (chips)
 *   │ i input · ctrl+p commands · …                │  ← commands row
 *   └──────────────────────────────────────────────┘
 *
 * Row 1 is the draft (multi-line; ▌ marks the cursor). Row 2 is the status
 * row — contextual session/workspace label left; mode badge + agent + model
 * chips right-aligned. Row 3 is the commands row — the keybinding hints
 * (formerly the footer line), swapping with the mode. Chips are clickable:
 * the chat view's SGR mouse handler hit-tests the column ranges computed by
 * state/hub.ts and routes to the same dialogs the supermenu's commands open.
 *
 * Presentational: all state and layout math live in the chat view; this
 * component only renders. While a permission/question ask is pending the
 * prompt REPLACES the whole hub (opencode's placement) — the hub is the slot.
 */
export function ComposerHub({
  editor,
  mode,
  busy,
  escArmed,
  runActive,
  layout,
  queuedCount = 0,
  context,
}: {
  editor: Editor;
  mode: Mode;
  busy: boolean;
  /** Double-esc interrupt arming (NORMAL mode hint). */
  escArmed: boolean;
  /** True while the coordinator is draining the session. */
  runActive: boolean;
  /** Status-row layout (state/hub.ts) — chips render in this exact order. */
  layout: HubStatusLayout;
  /** Pending queued messages (message-queue feature) — the commands-row indicator. */
  queuedCount?: number;
  /** Context tracker readout (shared/display.ts contextTracker) — leads the
   *  commands row: `45.2k/200k (23%) · hints…`, tone-colored (pi's thresholds). */
  context?: ContextTrackerView;
}) {
  const t = useTheme();
  const queuedHint = queuedCount > 0 ? `⏳ ${queuedCount} queued · ` : "";
  const commands =
    mode === "input"
      ? `${queuedHint}enter send · esc normal · ctrl+j/k newline · ctrl+w word`
      : `${queuedHint}${runActive ? "esc stop · " : ""}i input · j/k scroll · enter/space thought · ctrl+j/k focus · ctrl+p commands · ctrl+c quit`;
  const contextColor = context === undefined ? undefined : context.tone === "danger" ? t.danger : context.tone === "warning" ? t.warning : t.dim;
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={mode === "input" ? t.success : t.border}
      borderBackgroundColor={t.background}
      paddingX={1}
    >
      {/* Row 1 — the draft. INPUT keeps the green border and › prompt; ▌
          marks the cursor (multi-line drafts render embedded newlines).
          NORMAL dims to `:` (vim ex-mode); busy/esc hints ride the line. */}
      <Text>
        <Text color={t.secondary}>{mode === "input" ? "› " : ": "}</Text>
        <Text color={t.text}>
          {editor.text.slice(0, editor.cursor)}
          {mode === "input" && <Text color={t.dim}>▌</Text>}
          {editor.text.slice(editor.cursor)}
        </Text>
        {busy && <Text color={t.dim}> (working…)</Text>}
        {mode === "input" && <Text color={t.dim}> · esc normal</Text>}
        {mode === "normal" && runActive && !escArmed && (
          <Text color={t.dim}> · esc to stop</Text>
        )}
        {mode === "normal" && escArmed && (
          <Text color={t.warning}> · esc again to stop</Text>
        )}
      </Text>
      {/* Row 2 — status row: contextual session/workspace label (click →
          session picker), then mode badge, agent chip (click → agent
          manager) and model chip (click → model picker). Segment order must
          match state/hub.ts's chip math exactly. */}
      <Text wrap="truncate">
        <Text color={t.dim}>{layout.left}</Text>
        <Text>{" ".repeat(layout.gap)}</Text>
        <Text bold color={mode === "normal" ? t.accent : t.success}>
          {layout.modeText}
        </Text>
        {layout.agentText.length > 0 && <Text color={t.dim}> · </Text>}
        {layout.agentText.length > 0 && (
          <Text color={t.warning}>{layout.agentText}</Text>
        )}
        {layout.modelText.length > 0 && <Text color={t.dim}> · </Text>}
        {layout.modelText.length > 0 && (
          <Text color={t.secondary}>{layout.modelText}</Text>
        )}
      </Text>
      {/* Row 3 — commands: the old footer hint line, now part of the hub.
          The context tracker LEADS the row (`45.2k/200k (23%) · hints…`),
          tone-colored, in BOTH modes — so narrow terminals truncate the
          hint tail, never the tracker (wrap="truncate" cuts the end). */}
      <Text color={t.dim} wrap="truncate">
        {context !== undefined && contextColor !== undefined && (
          <>
            <Text color={contextColor}>{context.label}</Text>
            <Text> · </Text>
          </>
        )}
        {commands}
      </Text>
    </Box>
  );
}
