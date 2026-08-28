import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { PickerOption } from "../state/providers";

/** Options rendered around the highlight when the list is longer than this. */
const WINDOW = 12;

export interface DialogAction {
  /** Single character triggering the action. Reserved keys (typing/backspace) win. */
  key: string;
  label: string;
  /** Receives the currently highlighted option's value. */
  onAction: (value: string) => void;
}

/**
 * Select dialog with type-to-filter (the live models.dev catalog has 200+
 * providers — scrolling alone doesn't scale) and a sliding window so the
 * highlight never leaves the viewport.
 */
export function SelectDialog({
  title,
  options,
  onPick,
  onClose,
  actions = [],
}: {
  title: string;
  options: PickerOption[];
  onPick: (value: string) => void;
  onClose: () => void;
  /** Extra single-key actions applied to the highlighted option. */
  actions?: DialogAction[];
}) {
  const [filter, setFilter] = useState("");
  const [index, setIndex] = useState(0);

  const query = filter.toLowerCase();
  const visible =
    query.length > 0
      ? options.filter((o) => o.label.toLowerCase().includes(query) || o.value.toLowerCase().includes(query))
      : options;
  const clamped = Math.min(index, Math.max(0, visible.length - 1));

  useInput((ch, key) => {
    if (key.escape) return onClose();
    if (key.upArrow) return setIndex((i) => Math.max(0, i - 1));
    if (key.downArrow) return setIndex((i) => Math.min(visible.length - 1, i + 1));
    if (key.backspace || key.delete) {
      setFilter((f) => f.slice(0, -1));
      setIndex(0);
      return;
    }
    if (key.return) {
      const picked = visible[clamped];
      if (picked !== undefined) onPick(picked.value);
      return;
    }
    if (key.ctrl || key.meta) return;
    if (ch !== undefined && ch.length > 0) {
      // Input can arrive batched ("stub\r" in one chunk): an enter at the end
      // means "apply the typed chars, then pick" — one render, two steps.
      const endsWithEnter = /[\r\n]$/.test(ch);
      const body = ch.replace(/[\r\n]/g, "").replace(/[\x00-\x1f\x7f]/g, "");
      if (body.length === 0 && !endsWithEnter) return;

      if (body.length === 1) {
        const action = actions.find((a) => a.key === body);
        if (action !== undefined && query.length === 0) {
          // Actions like "add" must fire even with an empty list — they get "".
          action.onAction(visible[clamped]?.value ?? "");
          return;
        }
      }

      const newQuery = (query + body.toLowerCase()).trim();
      const nextVisible =
        newQuery.length > 0
          ? options.filter(
              (o) => o.label.toLowerCase().includes(newQuery) || o.value.toLowerCase().includes(newQuery),
            )
          : options;
      if (endsWithEnter) {
        const pick = nextVisible[Math.min(clamped, Math.max(0, nextVisible.length - 1))];
        if (pick !== undefined) onPick(pick.value);
        return;
      }
      setFilter(newQuery);
      setIndex(0);
    }
  });

  // Sliding window around the highlight.
  const start = Math.max(0, Math.min(clamped - Math.floor(WINDOW / 2), visible.length - WINDOW));
  const windowed = visible.slice(Math.max(0, start), Math.max(0, start) + WINDOW);

  const hints = [
    "↑/↓ navigate",
    "enter select",
    ...actions.map((a) => `${a.key} ${a.label}`),
    "esc back",
  ];

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">
        {title}
      </Text>
      <Text dimColor>
        {filter.length > 0 ? `filter: ${filter}` : "type to filter"}
        {visible.length !== options.length ? ` · ${visible.length}/${options.length}` : ""}
      </Text>
      {visible.length === 0 && (
        <Text dimColor>{options.length === 0 ? " (none yet — a to add)" : " (no matches)"}</Text>
      )}
      {windowed.map((opt, i) => {
        const absolute = Math.max(0, start) + i;
        return (
          <Text key={opt.value} color={absolute === clamped ? "cyan" : undefined}>
            {absolute === clamped ? "❯ " : "  "}
            {opt.gutter !== undefined ? <Text color="green">{opt.gutter} </Text> : null}
            {opt.label}
            {opt.hint !== undefined && <Text dimColor> {opt.hint}</Text>}
          </Text>
        );
      })}
      <Text dimColor>{hints.join(" · ")}</Text>
    </Box>
  );
}

export function PromptDialog({
  title,
  placeholder,
  description,
  optional = false,
  onSubmit,
  onClose,
}: {
  title: string;
  placeholder?: string;
  description?: string;
  /** Empty submit is allowed and delivers "" (skippable fields). */
  optional?: boolean;
  onSubmit: (value: string) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState("");

  useInput((ch, key) => {
    if (key.escape) return onClose();
    if (key.return) {
      const value = text.trim();
      if (value.length > 0 || optional) onSubmit(value);
      return;
    }
    if (key.backspace || key.delete) {
      setText((t) => t.slice(0, -1));
      return;
    }
    if (key.ctrl || key.meta) return;
    if (ch !== undefined && ch.length > 0) {
      // Batched input ("abc\r" in one chunk): newlines are submit boundaries —
      // the accumulated text plus the completed segment goes out as the value.
      const segments = ch.split(/[\r\n]+/);
      const tail = (segments.pop() ?? "").replace(/[\x00-\x1f\x7f]/g, "");
      if (segments.length > 0) {
        const completed = (text + segments.join(" ")).replace(/[\x00-\x1f\x7f]/g, "").trim();
        if (completed.length > 0 || optional) onSubmit(completed);
        return;
      }
      if (tail.length > 0) setText((t) => t + tail);
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">
        {title}
      </Text>
      {description !== undefined && <Text dimColor>{description}</Text>}
      <Text>
        <Text dimColor={text.length === 0}>{text.length > 0 ? text : (placeholder ?? "")}</Text>
        <Text dimColor>▌</Text>
      </Text>
      <Text dimColor>enter confirm{optional ? " (empty = skip)" : ""} · esc cancel</Text>
    </Box>
  );
}
