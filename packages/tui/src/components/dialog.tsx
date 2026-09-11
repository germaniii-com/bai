import { Box, Text, useInput } from "ink";
import { useEffect, useRef, useState } from "react";
import type { PickerOption } from "../state/providers";
import { deleteWord } from "../state/composer";
import { useTheme } from "../theme";

/** Options rendered around the highlight when the list is longer than this. */
const WINDOW = 12;
/**
 * Sliding list window `[start, end)` keeping `index` in view — the listbox
 * scroll every picker dialog uses (the highlight never leaves the viewport;
 * short lists render in full). Pure so the math is unit-testable.
 */
export function listWindow(index: number, count: number, size: number): { start: number; end: number } {
  const clampedSize = Math.max(1, Math.min(size, count));
  const start = Math.max(0, Math.min(index - Math.floor(clampedSize / 2), count - clampedSize));
  return { start, end: start + clampedSize };
}

/**
 * Mouse SGR sequences (`[<0;10;5M` — ink's parser strips the ESC prefix;
 * wheel events share the shape with button codes 64/65) must never reach the
 * dialogs' batched-typing branches: the control-char strip there would leave
 * the coordinates to type into the filter. The chat view parses the same
 * shape for its own hit-testing; dialogs just drop it.
 */
export function isMouseInput(ch: string | undefined): boolean {
  return ch !== undefined && /^\x1b?\[<\d+;\d+;\d+[Mm]$/.test(ch);
}

export interface DialogAction {
  /**
   * Ctrl chord triggering the action (e.g. "n" = ctrl+n, "a" = ctrl+a).
   * Plain letters always type into the filter. Reserved ctrl chords
   * (w word-delete, j/k navigation) win over same-letter actions.
   */
  key: string;
  label: string;
  /** Receives the currently highlighted option's value. */
  onAction: (value: string) => void;
}

/**
 * Select dialog with type-to-filter (the live models.dev catalog has 200+
 * providers — scrolling alone doesn't scale) and a sliding window so the
 * highlight never leaves the viewport. `onHighlight` reports the highlighted
 * option's value on every cursor/filter change — the theme picker's
 * live-preview hook (opencode's onMove pattern).
 */
export function SelectDialog({
  title,
  options,
  onPick,
  onClose,
  actions = [],
  initialIndex = 0,
  emptyHint = "none yet — ctrl+a to add",
  onHighlight,
  windowSize = WINDOW,
  deferInput = false,
}: {
  title: string;
  options: PickerOption[];
  onPick: (value: string) => void;
  onClose: () => void;
  /** Extra single-key actions applied to the highlighted option. */
  actions?: DialogAction[];
  /** Cursor seed (e.g. the active session's row). */
  initialIndex?: number;
  /** Empty-list hint when there are no options at all (no matches says so). */
  emptyHint?: string;
  /** Live-preview callback: fires whenever the highlighted value changes. */
  onHighlight?: (value: string) => void;
  /** Sliding-window size — the overlay shell caps it to the terminal height. */
  windowSize?: number;
  /** True while an App-level overlay dialog owns the keyboard (Ink delivers
   *  input to every mounted handler — this one must go silent). */
  deferInput?: boolean;
}) {
  const t = useTheme();
  const [filter, setFilter] = useState("");
  const [index, setIndex] = useState(initialIndex);

  const query = filter.toLowerCase();
  const visible =
    query.length > 0
      ? options.filter((o) => o.label.toLowerCase().includes(query) || o.value.toLowerCase().includes(query))
      : options;
  const clamped = Math.min(index, Math.max(0, visible.length - 1));

  // Live preview: report the highlighted value whenever it moves (navigation
  // or filtering). Ref-held callback — the caller's handler is stable enough
  // not to matter, and re-firing on its identity would loop previews.
  const highlightedValue = visible[clamped]?.value;
  const onHighlightRef = useRef(onHighlight);
  onHighlightRef.current = onHighlight;
  useEffect(() => {
    if (highlightedValue !== undefined) onHighlightRef.current?.(highlightedValue);
  }, [highlightedValue]);

  useInput(
    (ch, key) => {
      if (isMouseInput(ch)) return; // clicks/wheel never type into the filter
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
    // ctrl+w: shell-style word delete in the filter, matching the composer.
    if (key.ctrl && ch === "w") {
      setFilter((f) => deleteWord(f));
      setIndex(0);
      return;
    }
    // ctrl+j/ctrl+k: down/up navigation (the chat's focus-traversal chords —
    // plain j/k type into the filter here). ctrl+j's legacy spelling (lone
    // "\n", parsed as name:'enter' with ctrl=false) navigates too; "\r"
    // remains the pick key.
    if (key.ctrl && ch === "j") return setIndex((i) => Math.min(visible.length - 1, i + 1));
    if (key.ctrl && ch === "k") return setIndex((i) => Math.max(0, i - 1));
    if (ch === "\n") return setIndex((i) => Math.min(visible.length - 1, i + 1));
    // Ctrl-chord actions (ctrl+n new, ctrl+a add, ctrl+d delete…) fire
    // regardless of the filter — plain letters always type into it. Legacy
    // ctrl bytes (0x01 = ctrl+a, 0x0E = ctrl+n…) arrive as ch+ctrl, so every
    // terminal spelling works.
    if (key.ctrl) {
      const action = actions.find((a) => a.key === ch);
      if (action !== undefined) {
        action.onAction(visible[clamped]?.value ?? "");
      }
      return;
    }
    if (key.meta) return;
    if (ch !== undefined && ch.length > 0) {
      // Input can arrive batched ("stub\r" in one chunk): an enter at the end
      // means "apply the typed chars, then pick" — one render, two steps.
      const endsWithEnter = /[\r\n]$/.test(ch);
      const body = ch.replace(/[\r\n]/g, "").replace(/[\x00-\x1f\x7f]/g, "");
      if (body.length === 0 && !endsWithEnter) return;

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
  },
    // Deferred while an App-level overlay owns the keyboard (hub-slot
    // dialogs stay mounted behind it — Ink would deliver every key twice).
    { isActive: !deferInput },
  );

  // Sliding window around the highlight.
  const { start, end } = listWindow(clamped, visible.length, windowSize);
  const windowed = visible.slice(start, end);

  const hints = [
    "↑/↓ or ctrl+j/k navigate",
    "enter select",
    ...actions.map((a) => `ctrl+${a.key} ${a.label}`),
    "esc back",
  ];

  return (
    // Opaque surface: as an overlay panel the dialog must paint over the
    // chat behind it (Ink has no alpha — an unpainted interior would let
    // the transcript bleed through).
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={t.border}
      borderBackgroundColor={t.background}
      backgroundColor={t.background}
      paddingX={1}
    >
      <Text bold color={t.accent}>
        {title}
      </Text>
      <Text color={t.dim}>
        {filter.length > 0 ? `filter: ${filter}` : "type to filter"}
        {visible.length !== options.length ? ` · ${visible.length}/${options.length}` : ""}
      </Text>
      {visible.length === 0 && (
        <Text color={t.dim}>{options.length === 0 ? ` (${emptyHint})` : " (no matches)"}</Text>
      )}
      {start > 0 && <Text color={t.dim}>  ↑ {start} more</Text>}
      {windowed.map((opt, i) => {
        const absolute = start + i;
        return (
          <Text key={opt.value} color={absolute === clamped ? t.accent : t.text} wrap="truncate">
            {absolute === clamped ? "❯ " : "  "}
            {opt.gutter !== undefined ? <Text color={t.success}>{opt.gutter} </Text> : null}
            {opt.label}
            {opt.caps !== undefined && <Text color={t.secondary}> {opt.caps}</Text>}
            {opt.badge !== undefined && <Text color={t.warning}> {opt.badge}</Text>}
            {opt.hint !== undefined && <Text color={t.dim}> {opt.hint}</Text>}
          </Text>
        );
      })}
      {end < visible.length && (
        <Text color={t.dim}>  ↓ {visible.length - end} more</Text>
      )}
      <Text color={t.dim}>{hints.join(" · ")}</Text>
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
  deferInput = false,
}: {
  title: string;
  placeholder?: string;
  description?: string;
  /** Empty submit is allowed and delivers "" (skippable fields). */
  optional?: boolean;
  onSubmit: (value: string) => void;
  onClose: () => void;
  /** True while an App-level overlay dialog owns the keyboard. */
  deferInput?: boolean;
}) {
  const t = useTheme();
  const [text, setText] = useState("");

  useInput(
    (ch, key) => {
      if (isMouseInput(ch)) return; // clicks never type into the text
      if (key.escape) return onClose();
      if (key.return) {
        const value = text.trim();
      if (value.length > 0 || optional) onSubmit(value);
      return;
    }
    if (key.backspace || key.delete) {
      setText((prev) => prev.slice(0, -1));
      return;
    }
    // ctrl+w: shell-style word delete, matching the composer.
    if (key.ctrl && ch === "w") {
      setText((prev) => deleteWord(prev));
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
  },
    { isActive: !deferInput },
  );

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={t.border}
      borderBackgroundColor={t.background}
      backgroundColor={t.background}
      paddingX={1}
    >
      <Text bold color={t.accent}>
        {title}
      </Text>
      {description !== undefined && <Text color={t.dim}>{description}</Text>}
      <Text>
        <Text color={text.length === 0 ? t.dim : t.text}>{text.length > 0 ? text : (placeholder ?? "")}</Text>
        <Text color={t.dim}>▌</Text>
      </Text>
      <Text color={t.dim}>enter confirm{optional ? " (empty = skip)" : ""} · esc cancel</Text>
    </Box>
  );
}
