import { Box, Text } from "ink";
import { memo, useMemo } from "react";
import { useTheme } from "../theme";
import {
  TOOL_EXPANDED_CHARS,
  TOOL_EXPANDED_LINES,
  TOOL_FULL_CHARS,
  TOOL_FULL_LINES,
  collapseToolOutput,
} from "../state/sync";

/**
 * Bounded tool-result body (opencode parity collapse).
 * - `preview`: first 10 lines / 2000 chars + omission footer. Mounts ≤10 rows.
 * - `full`: first 500 lines / 50k chars + omission footer. Bounds even the
 *   explicit "show everything" stage so a 10k-line dump can't mount 10k nodes.
 * Memoized on content+mode — stable older results skip re-render entirely.
 */
export const ToolOutputBody = memo(function ToolOutputBody({
  content,
  mode,
}: {
  content: string;
  mode: "preview" | "full";
}) {
  const t = useTheme();
  const view = useMemo(
    () =>
      mode === "preview"
        ? collapseToolOutput(content, TOOL_EXPANDED_LINES, TOOL_EXPANDED_CHARS)
        : collapseToolOutput(content, TOOL_FULL_LINES, TOOL_FULL_CHARS),
    [content, mode],
  );
  const lines = useMemo(() => view.preview.split("\n"), [view.preview]);
  return (
    <Box flexDirection="column" paddingLeft={2}>
      {lines.map((line, li) => (
        <Text key={li} color={t.dim} wrap="wrap">
          {line.length > 0 ? line : " "}
        </Text>
      ))}
      {view.truncated && (
        <Text color={t.dim} wrap="wrap">
          {mode === "preview"
            ? `… ${view.omittedLines > 0 ? `${view.omittedLines} more line${view.omittedLines === 1 ? "" : "s"}` : `${view.omittedChars} more chars`} · f for full`
            : `… truncated (${view.omittedLines} more lines in history)`}
        </Text>
      )}
    </Box>
  );
});
