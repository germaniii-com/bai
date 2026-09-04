import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { BaiClient } from "@bai/api/client";
import type { QuestionRequest } from "@bai/shared";
import { deleteWord } from "../state/composer";
import { typedChar, type AskUiState } from "../state/asks";

/**
 * Inline question prompt — the answer half of the `question` tool
 * (opencode's above-the-editor placement): a normal layout child in the
 * chat view, taking the composer's slot while pending. One question at a
 * time; ↑/↓ highlight, space/enter picks (space toggles in multiple mode),
 * c types a custom answer. Answers submit after the last question. esc
 * arms, then dismisses the whole block (the model sees "The user dismissed
 * this question").
 *
 * All progress lives in the App-hoisted `ui` state (state/asks.ts) so the
 * prompt survives unmounts (ctrl-chord dialogs, view switches). ctrl/meta
 * chords pass through to the app's global handler.
 */
export function QuestionPrompt({
  client,
  request,
  ui,
  onUi,
  queued = 0,
  onDone,
}: {
  client: BaiClient;
  request: QuestionRequest;
  /** App-hoisted prompt state (answers, cursor, custom buffer, esc arm). */
  ui: AskUiState;
  /** Update the hoisted state (App applies it; survives unmount). */
  onUi: (update: (prev: AskUiState) => AskUiState) => void;
  /** Asks waiting behind this one (queue indicator). */
  queued?: number;
  onDone: () => void;
}) {
  // Request-scoped busy latch (see permission-prompt.tsx): keyed by the
  // request id so a next question block — which can mount as a prop swap,
  // not an unmount — never inherits this block's latch; a failed
  // reply/dismiss clears it (re-arm → retry) instead of dead-keying keys.
  const [busyId, setBusyId] = useState<string | null>(null);
  const busy = busyId === (request.id as string);

  const total = request.questions.length;
  const q = request.questions[ui.qIndex];
  if (q === undefined) return null;
  const selected = ui.answers[ui.qIndex] ?? [];

  const submit = (answers: string[][]) => {
    if (busy) return;
    const id = request.id as string;
    setBusyId(id);
    void client
      .replyQuestion(id, answers)
      .catch(() => setBusyId((current) => (current === id ? null : current)))
      .finally(() => onDone());
  };

  const dismiss = () => {
    if (busy) return;
    const id = request.id as string;
    setBusyId(id);
    void client
      .rejectQuestion(id)
      .catch(() => setBusyId((current) => (current === id ? null : current)))
      .finally(() => onDone());
  };

  /** Store the current answer set for this question and advance/submit. */
  const advance = (labels: string[]) => {
    const next = ui.answers.map((a, i) => (i === ui.qIndex ? labels : a));
    const isLast = ui.qIndex + 1 >= total;
    onUi(() => ({
      ...ui,
      answers: next,
      highlight: 0,
      custom: null,
      dismissArmed: false,
      qIndex: isLast ? ui.qIndex : ui.qIndex + 1,
    }));
    if (isLast) submit(next);
  };

  useInput((ch, key) => {
    if (busy) return;
    if (ui.custom !== null) {
      // Custom-answer input mode.
      if (key.escape) {
        onUi((prev) => ({ ...prev, custom: null }));
        return;
      }
      if (key.return) {
        const value = ui.custom.trim();
        if (value.length > 0) advance([value]);
        return;
      }
      if (key.backspace || key.delete) {
        onUi((prev) => ({ ...prev, custom: (prev.custom ?? "").slice(0, -1) }));
        return;
      }
      if (key.ctrl && ch === "w") {
        onUi((prev) => ({ ...prev, custom: deleteWord(prev.custom ?? "") }));
        return;
      }
      if (key.ctrl || key.meta) return;
      const body = typedChar(ch);
      if (body.length > 0) onUi((prev) => ({ ...prev, custom: (prev.custom ?? "") + body }));
      return;
    }
    if (key.escape) {
      // Two-stage dismissal (the ctrl+c arming pattern) — an accidental esc
      // must not silently drop the agent's question.
      if (ui.dismissArmed) return dismiss();
      onUi((prev) => ({ ...prev, dismissArmed: true }));
      return;
    }
    if (key.upArrow) {
      onUi((prev) => ({ ...prev, highlight: Math.max(0, prev.highlight - 1), dismissArmed: false }));
      return;
    }
    if (key.downArrow) {
      onUi((prev) => ({ ...prev, highlight: Math.min((q.options.length ?? 0) - 1, prev.highlight + 1), dismissArmed: false }));
      return;
    }
    if (key.ctrl || key.meta) return;
    if (ch === "c") {
      onUi((prev) => ({ ...prev, custom: "", dismissArmed: false }));
      return;
    }
    if (key.return || ch === " ") {
      const picked = q.options[ui.highlight];
      if (picked === undefined) return;
      if (q.multiple === true) {
        if (key.return) {
          // enter confirms the toggled set (may be empty → stay).
          if (selected.length > 0) advance(selected);
          return;
        }
        // space toggles the highlighted option.
        const next = selected.includes(picked.label)
          ? selected.filter((l) => l !== picked.label)
          : [...selected, picked.label];
        onUi((prev) => ({
          ...prev,
          dismissArmed: false,
          answers: prev.answers.map((a, i) => (i === prev.qIndex ? next : a)),
        }));
        return;
      }
      advance([picked.label]);
      return;
    }
    if (ui.dismissArmed) onUi((prev) => ({ ...prev, dismissArmed: false }));
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} flexShrink={0}>
      <Text wrap="truncate">
        <Text bold color="cyan">
          △ question{total > 1 ? ` (${ui.qIndex + 1}/${total})` : ""} · {q.header}
        </Text>
        {queued > 0 && <Text dimColor> · {queued} more queued</Text>}
      </Text>
      <Text wrap="wrap">{q.question}</Text>
      {q.options.map((opt, i) => {
        const picked = selected.includes(opt.label);
        const cursor = ui.custom === null && i === ui.highlight ? "❯ " : "  ";
        return (
          <Text key={opt.label} wrap="truncate" color={i === ui.highlight && ui.custom === null ? "cyan" : undefined}>
            {cursor}
            {q.multiple === true ? (picked ? "[x] " : "[ ] ") : picked ? "● " : ""}
            {opt.label}
            {i === ui.highlight && ui.custom === null ? <Text dimColor> — {opt.description}</Text> : null}
          </Text>
        );
      })}
      {ui.custom !== null ? (
        <Box flexDirection="column">
          <Text color="cyan">custom answer:</Text>
          <Text wrap="truncate">
            <Text dimColor={ui.custom.length === 0}>{ui.custom.length > 0 ? ui.custom : "type your answer…"}</Text>
            <Text dimColor>▌</Text>
          </Text>
          <Text dimColor>enter submit · esc back</Text>
        </Box>
      ) : (
        <Text dimColor wrap="truncate">
          {q.multiple === true
            ? "space toggle · enter confirm · c custom · "
            : "space/enter pick · c custom · "}
          esc{ui.dismissArmed ? " again dismiss" : " dismiss"}
        </Text>
      )}
      {ui.dismissArmed && ui.custom === null && <Text color="yellow">press esc again to dismiss all questions</Text>}
    </Box>
  );
}
