import { Box, Text } from "ink";
import type { Editor } from "../state/composer";
import type { HubStatusLayout } from "../state/hub";
import type { Mode } from "../app";

/**
 * The centralized composer hub — the single surface under the transcript:
 *
 *   ┌──────────────────────────────────────────────┐
 *   │ › input draft with cursor block              │
 *   │ chat · title        NORMAL · @agent · model  │  ← status row (chips)
 *   │ i input · ctrl+p providers · …               │  ← commands row
 *   └──────────────────────────────────────────────┘
 *
 * Row 1 is the draft (multi-line; ▌ marks the cursor). Row 2 is the status
 * row — contextual session/workspace label left; mode badge + agent + model
 * chips right-aligned. Row 3 is the commands row — the keybinding hints
 * (formerly the footer line), swapping with the mode. Chips are clickable:
 * the chat view's SGR mouse handler hit-tests the column ranges computed by
 * state/hub.ts and routes to the same dialogs the ctrl-chords open.
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
}) {
  const commands =
    mode === "input"
      ? "enter send · esc normal · ctrl+j/k newline · ctrl+w word"
      : `${runActive ? "esc stop · " : ""}i input · j/k scroll · enter/space thought · ctrl+j/k focus · ctrl+p providers · ctrl+l models · ctrl+a agents · ctrl+t thoughts · ctrl+s sessions · ctrl+g gallery · ctrl+o settings · ctrl+c quit`;
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={mode === "input" ? "green" : "gray"}
      paddingX={1}
    >
      {/* Row 1 — the draft. INPUT keeps the green border and › prompt; ▌
          marks the cursor (multi-line drafts render embedded newlines).
          NORMAL dims to `:` (vim ex-mode); busy/esc hints ride the line. */}
      <Text>
        <Text color="magenta">{mode === "input" ? "› " : ": "}</Text>
        <Text>
          {editor.text.slice(0, editor.cursor)}
          {mode === "input" && <Text dimColor>▌</Text>}
          {editor.text.slice(editor.cursor)}
        </Text>
        {busy && <Text dimColor> (working…)</Text>}
        {mode === "input" && <Text dimColor> · esc normal</Text>}
        {mode === "normal" && runActive && !escArmed && (
          <Text dimColor> · esc to stop</Text>
        )}
        {mode === "normal" && escArmed && (
          <Text color="yellow"> · esc again to stop</Text>
        )}
      </Text>
      {/* Row 2 — status row: contextual session/workspace label (click →
          session picker), then mode badge, agent chip (click → agent
          manager) and model chip (click → model picker). Segment order must
          match state/hub.ts's chip math exactly. */}
      <Text wrap="truncate">
        <Text dimColor>{layout.left}</Text>
        <Text>{" ".repeat(layout.gap)}</Text>
        <Text bold color={mode === "normal" ? "cyan" : "green"}>
          {layout.modeText}
        </Text>
        {layout.agentText.length > 0 && <Text dimColor> · </Text>}
        {layout.agentText.length > 0 && (
          <Text color="yellow">{layout.agentText}</Text>
        )}
        {layout.modelText.length > 0 && <Text dimColor> · </Text>}
        {layout.modelText.length > 0 && (
          <Text color="magenta">{layout.modelText}</Text>
        )}
      </Text>
      {/* Row 3 — commands: the old footer hint line, now part of the hub. */}
      <Text dimColor wrap="truncate">
        {commands}
      </Text>
    </Box>
  );
}
