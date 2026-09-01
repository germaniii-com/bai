import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { Session } from "@bai/shared";

/** Session picker: arrows to navigate, enter to open, n to start a new one. */
export function SessionsView({
  sessions,
  onPick,
  onNew,
}: {
  sessions: Session[];
  onPick: (session: Session) => void;
  /** "n": draft state — no session exists until the first message is sent. */
  onNew: () => void;
}) {
  const [index, setIndex] = useState(0);

  useInput((ch, key) => {
    // j/k are vim aliases for the arrow keys (NORMAL-mode consistency).
    if (key.upArrow || ch === "k") setIndex((i) => Math.max(0, i - 1));
    else if (key.downArrow || ch === "j")
      setIndex((i) => Math.min(sessions.length - 1, i + 1));
    else if (key.return) {
      const picked = sessions[index];
      if (picked !== undefined) onPick(picked);
    } else if (ch === "n") {
      onNew();
    }
  });

  return (
    <Box flexDirection="column">
      <Text bold>Sessions</Text>
      {sessions.length === 0 && <Text dimColor>No sessions yet — press n to start one.</Text>}
      {sessions.map((s, i) => (
        <Text key={s.id} color={i === index ? "cyan" : undefined}>
          {i === index ? "❯ " : "  "}
          {s.title.length > 0 ? s.title : "(untitled)"}{" "}
          <Text dimColor>
            {s.workbench} · {s.id}
          </Text>
        </Text>
      ))}
      <Text dimColor>↑/↓ or j/k navigate · enter open · n new · esc back</Text>
    </Box>
  );
}
