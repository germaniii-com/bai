import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { listWindow } from "../components/dialog";
import { deleteWord } from "../state/composer";
import { flattenSections, paletteSections, type CommandSpec } from "../state/commands";
import { useTheme } from "../theme";

/** Render lines (headers included) shown around the highlight. */
const WINDOW = 12;

/** One render line: a dim category header or a command row. */
type Entry = { kind: "header"; label: string } | { kind: "command"; cmd: CommandSpec };

/**
 * The supermenu (ctrl+p) — opencode's command palette over the App's command
 * registry (state/commands.ts): type-to-filter, dim category headers, and a
 * contextual "Suggested" section while the filter is empty. Key handling
 * mirrors the SelectDialog family exactly (↑/↓, ctrl+j/k — including
 * ctrl+j's legacy lone-"\n" spelling — backspace/ctrl+w filter editing,
 * batched "them\r" input); enter dispatches the highlighted command's id and
 * esc closes. Presentational: specs and dispatch live in the App, like the
 * composer hub.
 *
 * The sliding window walks ENTRIES, not commands — headers consume window
 * rows, so the box never exceeds the viewport (the App's fixed-height root
 * squeezes overflowing boxes, scrambling the render).
 */
export function CommandPalette({
  specs,
  onRun,
  onClose,
}: {
  specs: CommandSpec[];
  /** Receives the highlighted command's id (enter / batched enter). */
  onRun: (id: string) => void;
  /** esc — close without running anything. */
  onClose: () => void;
}) {
  const t = useTheme();
  const [filter, setFilter] = useState("");
  const [index, setIndex] = useState(0);

  const query = filter.toLowerCase();
  const sections = paletteSections(specs, query);
  const flat = flattenSections(sections);
  const clamped = Math.min(index, Math.max(0, flat.length - 1));

  // The render list: header entry before each section's commands. The
  // cursor navigates commands (flat) but windows over entries.
  const entries: Entry[] = sections.flatMap((s) => [
    ...(s.label !== null && s.commands.length > 0 ? [{ kind: "header" as const, label: s.label }] : []),
    ...s.commands.map((cmd) => ({ kind: "command" as const, cmd })),
  ]);
  const commandEntries: number[] = [];
  entries.forEach((e, i) => {
    if (e.kind === "command") commandEntries.push(i);
  });
  const cursorEntry = commandEntries[Math.min(clamped, commandEntries.length - 1)] ?? 0;

  useInput((ch, key) => {
    if (key.escape) return onClose();
    if (key.upArrow) return setIndex((i) => Math.max(0, i - 1));
    if (key.downArrow) return setIndex((i) => Math.min(flat.length - 1, i + 1));
    if (key.backspace || key.delete) {
      setFilter((f) => f.slice(0, -1));
      setIndex(0);
      return;
    }
    if (key.return) {
      const picked = flat[clamped];
      if (picked !== undefined) onRun(picked.id);
      return;
    }
    // ctrl+w: shell-style word delete in the filter, matching the composer.
    if (key.ctrl && ch === "w") {
      setFilter((f) => deleteWord(f));
      setIndex(0);
      return;
    }
    // ctrl+j/ctrl+k: down/up navigation (the chat's focus-traversal chords —
    // plain letters type into the filter here). ctrl+j's legacy spelling
    // (lone "\n", parsed as name:'enter' with ctrl=false) navigates too;
    // "\r" remains the run key.
    if (key.ctrl && ch === "j") return setIndex((i) => Math.min(flat.length - 1, i + 1));
    if (key.ctrl && ch === "k") return setIndex((i) => Math.max(0, i - 1));
    if (ch === "\n") return setIndex((i) => Math.min(flat.length - 1, i + 1));
    // The palette has no ctrl-chord actions: every other chord is inert
    // (the App's ctrl+c hatch stays live above this handler).
    if (key.ctrl) return;
    if (key.meta) return;
    if (ch !== undefined && ch.length > 0) {
      // Batched input ("them\r" in one chunk): an enter at the end means
      // "apply the typed chars, then run" — one render, two steps.
      const endsWithEnter = /[\r\n]$/.test(ch);
      const body = ch.replace(/[\r\n]/g, "").replace(/[\x00-\x1f\x7f]/g, "");
      if (body.length === 0 && !endsWithEnter) return;

      const newQuery = (query + body.toLowerCase()).trim();
      const nextFlat = flattenSections(paletteSections(specs, newQuery));
      if (endsWithEnter) {
        const pick = nextFlat[Math.min(clamped, Math.max(0, nextFlat.length - 1))];
        if (pick !== undefined) onRun(pick.id);
        return;
      }
      setFilter(newQuery);
      setIndex(0);
    }
  });

  // Sliding window of RENDER LINES around the highlight (SelectDialog's
  // listbox scroll).
  const { start, end } = listWindow(cursorEntry, entries.length, WINDOW);
  const windowed = entries.slice(start, end);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={t.border} borderBackgroundColor={t.background} paddingX={1}>
      <Text bold color={t.accent}>
        commands
      </Text>
      <Text color={t.dim}>
        {query.length > 0 ? `filter: ${query}` : "type to filter"}
        {query.length > 0 ? ` · ${flat.length}/${specs.length}` : ""}
      </Text>
      {flat.length === 0 && <Text color={t.dim}> (no matches)</Text>}
      {start > 0 && <Text color={t.dim}>  ↑ more</Text>}
      {windowed.map((entry, i) => {
        const absolute = start + i;
        if (entry.kind === "header") {
          return (
            <Text key={`h${absolute}`} color={t.dim}>
              {entry.label}
            </Text>
          );
        }
        return (
          <Text key={absolute} color={absolute === cursorEntry ? t.accent : t.text} wrap="truncate">
            {absolute === cursorEntry ? "❯ " : "  "}
            {entry.cmd.title}
          </Text>
        );
      })}
      {end < entries.length && <Text color={t.dim}>  ↓ more</Text>}
      <Text color={t.dim}>↑/↓ or ctrl+j/k navigate · enter run · esc back</Text>
    </Box>
  );
}
