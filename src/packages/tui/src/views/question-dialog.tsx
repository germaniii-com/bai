import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { BaiClient } from "@bai/api/client";
import type { QuestionRequest } from "@bai/shared";
import { deleteWord } from "../state/composer";

/**
 * Question dialog — the answer half of the `question` tool (opencode's
 * question UI, TUI-flavored). One question at a time; ↑/↓ highlight, space/
 * enter picks (space toggles in multiple mode), c types a custom answer.
 * Answers submit after the last question. esc arms, then dismisses the
 * whole block (the model sees "The user dismissed this question").
 */
export function QuestionDialog({
  client,
  request,
  onDone,
}: {
  client: BaiClient;
  request: QuestionRequest;
  onDone: () => void;
}) {
  // One label-array per question, filled in as the user steps through.
  const [answers, setAnswers] = useState<string[][]>(() => request.questions.map(() => []));
  const [qIndex, setQIndex] = useState(0);
  const [highlight, setHighlight] = useState(0);
  // Non-null: typing a custom answer into this buffer (replaces the pick).
  const [custom, setCustom] = useState<string | null>(null);
  const [dismissArmed, setDismissArmed] = useState(false);
  const [busy, setBusy] = useState(false);

  const total = request.questions.length;
  const q = request.questions[qIndex];
  if (q === undefined) return null;
  const selected = answers[qIndex] ?? [];

  const submit = () => {
    if (busy) return;
    setBusy(true);
    void client
      .replyQuestion(request.id as string, answers)
      .catch(() => {})
      .finally(() => onDone());
  };

  const dismiss = () => {
    if (busy) return;
    setBusy(true);
    void client
      .rejectQuestion(request.id as string)
      .catch(() => {})
      .finally(() => onDone());
  };

  /** Store the current answer set for this question and advance/submit. */
  const advance = (labels: string[]) => {
    const next = answers.map((a, i) => (i === qIndex ? labels : a));
    setAnswers(next);
    setHighlight(0);
    setCustom(null);
    if (qIndex + 1 >= total) {
      if (busy) return;
      setBusy(true);
      void client
        .replyQuestion(request.id as string, next)
        .catch(() => {})
        .finally(() => onDone());
    } else {
      setQIndex(qIndex + 1);
    }
  };

  useInput((ch, key) => {
    if (busy) return;
    if (custom !== null) {
      // Custom-answer input mode.
      if (key.escape) {
        setCustom(null);
        return;
      }
      if (key.return) {
        const value = custom.trim();
        if (value.length > 0) advance([value]);
        return;
      }
      if (key.backspace || key.delete) {
        setCustom((c) => (c ?? "").slice(0, -1));
        return;
      }
      if (key.ctrl && ch === "w") {
        setCustom((c) => deleteWord(c ?? ""));
        return;
      }
      if (key.ctrl || key.meta) return;
      if (ch !== undefined && ch.length > 0) {
        const body = ch.replace(/[\r\n\x00-\x1f\x7f]/g, "");
        if (body.length > 0) setCustom((c) => (c ?? "") + body);
      }
      return;
    }
    if (key.escape) {
      // Two-stage dismissal (the ctrl+c arming pattern) — an accidental esc
      // must not silently drop the agent's question.
      if (dismissArmed) return dismiss();
      setDismissArmed(true);
      return;
    }
    if (key.upArrow) {
      setHighlight((h) => Math.max(0, h - 1));
      return;
    }
    if (key.downArrow) {
      setHighlight((h) => Math.min((q.options.length ?? 0) - 1, h + 1));
      return;
    }
    if (ch === "c") {
      setCustom("");
      return;
    }
    if (key.return || ch === " ") {
      const picked = q.options[highlight];
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
        setAnswers((all) => all.map((a, i) => (i === qIndex ? next : a)));
        return;
      }
      advance([picked.label]);
      return;
    }
    if (dismissArmed) setDismissArmed(false);
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">
        question{total > 1 ? ` (${qIndex + 1}/${total})` : ""} · {q.header}
      </Text>
      <Text>{q.question}</Text>
      {q.options.map((opt, i) => {
        const picked = selected.includes(opt.label);
        const cursor = custom === null && i === highlight ? "❯ " : "  ";
        return (
          <Text key={opt.label} color={i === highlight && custom === null ? "cyan" : undefined}>
            {cursor}
            {q.multiple === true ? (picked ? "[x] " : "[ ] ") : picked ? "● " : ""}
            {opt.label}
            {i === highlight && custom === null ? <Text dimColor> — {opt.description}</Text> : null}
          </Text>
        );
      })}
      {custom !== null ? (
        <Box flexDirection="column">
          <Text color="cyan">custom answer:</Text>
          <Text>
            <Text dimColor={custom.length === 0}>{custom.length > 0 ? custom : "type your answer…"}</Text>
            <Text dimColor>▌</Text>
          </Text>
          <Text dimColor>enter submit · esc back</Text>
        </Box>
      ) : (
        <Text dimColor>
          {q.multiple === true
            ? "space toggle · enter confirm · c custom · "
            : "space/enter pick · c custom · "}
          esc{dismissArmed ? " again dismiss" : " dismiss"}
        </Text>
      )}
      {dismissArmed && custom === null && <Text color="yellow">press esc again to dismiss all questions</Text>}
    </Box>
  );
}
