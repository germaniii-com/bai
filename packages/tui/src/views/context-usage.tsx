import { Box, Text, useInput, useWindowSize } from "ink";
import type { ReactNode } from "react";
import type { SessionUsage } from "@bai/shared";
import {
  contextBreakdownRows,
  contextTokensUsed,
  formatCost,
  formatTokens,
} from "@bai/shared";
import { isMouseInput } from "../components/dialog";
import { PANEL_WIDTH } from "../components/dialog-overlay";
import { useTheme } from "../theme";

/** Label column width — the longest category label is "system prompt" (13). */
const LABEL_WIDTH = 14;
/** Token column width — right-aligned `~123.4k` plus a little slack. */
const TOKEN_WIDTH = 9;
/** Gap between the token column and the share bar. */
const BAR_GAP = 2;

/**
 * The TUI counterpart of the web's Context Usage modal (supermenu → "Context
 * Usage"): the active session's last-turn context composition. The header +
 * bar show the EXACT provider-reported context tokens (`used/window`, percent
 * full) plus the cumulative estimated session cost; the rows below are the
 * estimated per-category prompt composition (chars/4) from
 * `SessionUsage.breakdown` — system prompt, tools, skills, **mcp**, subagents,
 * conversation. The `mcp` row is highlighted: it is the MCP tool-schema
 * share of the prompt. Rendered as a floating overlay over the live chat
 * (the DialogOverlay shell), like the todos panel.
 */
export function ContextUsageDialog({
  usage,
  onClose,
  deferInput = false,
}: {
  usage: SessionUsage | null;
  /** esc — close the panel. */
  onClose: () => void;
  /** True while another App-level overlay dialog owns the keyboard. */
  deferInput?: boolean;
}) {
  const t = useTheme();
  const { columns } = useWindowSize();

  // The overlay panel is PANEL_WIDTH clamped to the terminal; the dialog's
  // own border + paddingX(1) eat 4 columns. The bars fill whatever remains so
  // the modal never shows a stunted track.
  const panelWidth = Math.min(PANEL_WIDTH, Math.max(20, (columns > 0 ? columns : 80) - 2));
  const innerWidth = Math.max(12, panelWidth - 4);
  const shareWidth = Math.max(6, innerWidth - LABEL_WIDTH - TOKEN_WIDTH - BAR_GAP);

  useInput(
    (ch, key) => {
      if (isMouseInput(ch)) return;
      if (key.escape) onClose();
    },
    { isActive: !deferInput },
  );

  // Opaque surface: as an overlay panel it must paint over the chat behind
  // it (Ink has no alpha).
  const shell = (children: ReactNode) => (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={t.border}
      borderBackgroundColor={t.background}
      backgroundColor={t.background}
      paddingX={1}
    >
      <Text bold color={t.accent}>
        context usage
      </Text>
      {children}
      <Text color={t.dim}>esc close</Text>
    </Box>
  );

  if (usage === null) {
    return shell(
      <Text color={t.dim}>context usage appears after the first model response</Text>,
    );
  }

  const used = contextTokensUsed(usage);
  const window = usage.contextWindow;
  const pct =
    window !== undefined && window > 0 ? Math.round((used / window) * 100) : undefined;
  const rows = contextBreakdownRows(usage.breakdown);
  const breakdownTotal = rows.reduce((sum, row) => sum + row.tokens, 0);
  const clampedPct = pct !== undefined ? Math.min(100, Math.max(0, pct)) : 0;
  const filled = Math.round((clampedPct / 100) * innerWidth);
  const barColor =
    pct !== undefined && pct > 90 ? t.danger : pct !== undefined && pct > 70 ? t.warning : t.success;
  const costUsd = usage.costUsd !== undefined && usage.costUsd > 0 ? usage.costUsd : undefined;

  return shell(
    <>
      <Text color={t.dim}>
        {pct !== undefined ? `${pct}% full` : "context usage"}
        {" · "}
        {window !== undefined
          ? `~${formatTokens(used)}/${formatTokens(window)} tokens`
          : `~${formatTokens(used)} tokens`}
      </Text>
      {/* Full-width fullness track: filled share in the tone color, the
          remainder dim — both spans are sized to the modal's inner width. */}
      {pct !== undefined && (
        <Text>
          <Text color={barColor}>{"█".repeat(filled)}</Text>
          <Text color={t.border}>{"░".repeat(Math.max(0, innerWidth - filled))}</Text>
        </Text>
      )}
      {rows.length > 0 ? (
        <>
          {rows.map((row) => {
            const share = breakdownTotal > 0 ? row.tokens / breakdownTotal : 0;
            const seg = Math.round(share * shareWidth);
            const isMcp = row.key === "mcp";
            return (
              <Text key={row.key} wrap="truncate">
                <Text color={isMcp ? t.secondary : t.text}>{row.label.padEnd(LABEL_WIDTH)}</Text>
                <Text color={t.dim}>{`~${formatTokens(row.tokens)}`.padStart(TOKEN_WIDTH)}</Text>
                <Text color={t.dim}>{" ".repeat(BAR_GAP)}</Text>
                <Text color={isMcp ? t.secondary : t.accent}>{"█".repeat(Math.max(0, seg))}</Text>
                <Text color={t.border}>{"░".repeat(Math.max(0, shareWidth - seg))}</Text>
              </Text>
            );
          })}
        </>
      ) : (
        <Text color={t.dim}>Per-category breakdown appears after the first model response.</Text>
      )}
      {costUsd !== undefined && (
        <Text color={t.secondary}>session cost (est.) {formatCost(costUsd)}</Text>
      )}
    </>,
  );
}
