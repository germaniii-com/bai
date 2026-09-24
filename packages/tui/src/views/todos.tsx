import { Text, useInput } from "ink";
import type { TodoItem } from "@bai/shared";
import { isMouseInput, listWindow } from "../components/dialog";
import { HintRow, Panel } from "../components/ui";
import { useTheme } from "../theme";

/** Render rows shown around the top of a long list. */
const WINDOW = 12;

/**
 * The todo panel (ctrl+t, or the supermenu's "Show todos"): the active
 * session's agent-maintained task list (`session.meta.todos`, kept live by
 * the durable `todos.updated` event). Read-only — the agent owns the list;
 * this surface only shows progress. Rendered as a floating overlay over the
 * live chat (the DialogOverlay shell), like the palette and pickers.
 */
export function TodosDialog({
  todos,
  onClose,
  windowSize = WINDOW,
  deferInput = false,
}: {
  todos: TodoItem[];
  /** esc — close the panel. */
  onClose: () => void;
  /** Sliding-window size — the overlay shell caps it to the terminal height. */
  windowSize?: number;
  /** True while another App-level overlay dialog owns the keyboard. */
  deferInput?: boolean;
}) {
  const t = useTheme();

  useInput(
    (ch, key) => {
      if (isMouseInput(ch)) return;
      if (key.escape) onClose();
    },
    { isActive: !deferInput },
  );

  const counts = {
    completed: todos.filter((item) => item.status === "completed").length,
    inProgress: todos.filter((item) => item.status === "in_progress").length,
    pending: todos.filter((item) => item.status === "pending").length,
    cancelled: todos.filter((item) => item.status === "cancelled").length,
  };
  const summary =
    todos.length === 0
      ? "no todos yet — the agent writes them for multi-step work"
      : `${counts.completed} completed · ${counts.inProgress} in progress · ${counts.pending} pending` +
        (counts.cancelled > 0 ? ` · ${counts.cancelled} cancelled` : "");

  const { start, end } = listWindow(0, todos.length, windowSize);
  const windowed = todos.slice(start, end);

  return (
    <Panel title="todos" titleTone="accent" hint="esc close">
      <Text color={t.dim}>{summary}</Text>
      {start > 0 && <HintRow>{"  ↑ more"}</HintRow>}
      {windowed.map((item, i) => {
        const glyph =
          item.status === "completed"
            ? "✓"
            : item.status === "in_progress"
              ? "◐"
              : item.status === "cancelled"
                ? "✗"
                : "○";
        const glyphColor =
          item.status === "completed"
            ? t.success
            : item.status === "in_progress"
              ? t.accent
              : item.status === "cancelled"
                ? t.dim
                : t.dim;
        const struck = item.status === "completed" || item.status === "cancelled";
        return (
          <Text key={`${start + i}-${item.content}`} color={struck ? t.dim : t.text} wrap="truncate">
            <Text color={glyphColor}>{glyph} </Text>
            {item.content}
            {item.priority === "high" && <Text color={t.warning}> · high</Text>}
          </Text>
        );
      })}
      {end < todos.length && <HintRow>{"  ↓ more"}</HintRow>}
    </Panel>
  );
}
