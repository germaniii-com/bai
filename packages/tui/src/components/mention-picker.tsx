import { Box, Text } from "ink";
import type { MentionEntry } from "../state/mention";
import { useTheme } from "../theme";

/**
 * The composer's `#file` mention picker — a compact list rendered directly
 * above the ComposerHub (never an overlay): the chat stays mounted and the
 * input keeps receiving keystrokes, so the query filters live. Presentational
 * only; navigation state lives in state/mention.ts and the chat view.
 */
export function MentionPicker({
  results,
  selected,
  loading,
  error,
  query,
}: {
  results: MentionEntry[];
  selected: number;
  loading: boolean;
  error?: string;
  query: string;
}) {
  const t = useTheme();
  const windowSize = 8;
  const start = Math.max(0, Math.min(selected - Math.floor(windowSize / 2), Math.max(0, results.length - windowSize)));
  const rows = results.slice(start, start + windowSize);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={t.border}
      borderBackgroundColor={t.background}
      paddingX={1}
    >
      {error !== undefined ? (
        <Text color={t.danger} wrap="truncate">
          # {error}
        </Text>
      ) : results.length === 0 ? (
        <Text color={t.dim} wrap="truncate">
          {loading ? `# searching ${query}…` : `# no files match ${query}`}
        </Text>
      ) : (
        rows.map((entry, i) => {
          const index = start + i;
          const active = index === selected;
          const slash = entry.path.lastIndexOf("/");
          const dir = slash >= 0 ? entry.path.slice(0, slash + 1) : "";
          const base = slash >= 0 ? entry.path.slice(slash + 1) : entry.path;
          return (
            <Text key={entry.path} wrap="truncate" color={active ? t.accent : t.text}>
              {active ? "❯ " : "  "}
              <Text color={active ? t.accent : t.dim}>{dir}</Text>
              <Text bold={active} color={active ? t.accent : t.text}>
                {base}
              </Text>
              {entry.type === "dir" ? <Text color={t.dim}>/</Text> : null}
            </Text>
          );
        })
      )}
      <Text color={t.dim} wrap="truncate">
        {"  "}↑/↓ select · enter/tab insert · esc close
      </Text>
    </Box>
  );
}
