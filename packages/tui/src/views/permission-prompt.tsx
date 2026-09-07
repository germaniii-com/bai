import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { BaiClient } from "@bai/api/client";
import type { PermissionRequest } from "@bai/shared";
import { deleteWord } from "../state/composer";
import { typedChar, type AskUiState } from "../state/asks";
import { useTheme } from "../theme";

/** Diff lines rendered before eliding with a counter. */
const DIFF_WINDOW = 14;

/**
 * Inline permission prompt (opencode's above-the-editor placement): a
 * normal layout child in the chat view — it takes the composer's slot
 * while pending, and everything else (transcript scrolling, ctrl-chords,
 * session switching) stays live. NOT a keyboard-owning modal.
 *
 *   a — allow once · s — allow always (this session) · d — reject
 *
 * Reject opens a small optional-message input (opencode's CorrectedError):
 * the text rides the denial back to the model as feedback. File asks show
 * the computed diff from the request's detail. Stage/message live in the
 * App-hoisted `ui` state (state/asks.ts) so the prompt survives unmounts.
 *
 * First reply wins across devices — a loser's prompt clears via the
 * permission.replied event. esc never answers an ask; ctrl chords pass
 * through to the app's global handler (ctrl+a must open the agent manager,
 * not approve).
 */
export function PermissionPrompt({
  client,
  request,
  context,
  ui,
  onUi,
  queued = 0,
  onDone,
}: {
  client: BaiClient;
  request: PermissionRequest;
  /** Optional origin line, e.g. "subagent @plan" for a child session's ask. */
  context?: string;
  /** App-hoisted prompt state (stage + reject message). */
  ui: AskUiState;
  /** Update the hoisted state (App applies it; survives unmount). */
  onUi: (update: (prev: AskUiState) => AskUiState) => void;
  /** Asks waiting behind this one (queue indicator). */
  queued?: number;
  onDone: () => void;
}) {
  // Request-scoped busy latch: the id the reply was sent for, not a bare
  // boolean. Consecutive asks swap the `request` prop on the SAME mounted
  // instance (the replied event pops the head in the same commit the next
  // asked event appends — no unmount between), so a `useState(false)` latch
  // would stay true forever and dead-key the second ask. Keyed by id, the
  // latch dies with its ask; a failed reply clears it (re-arm → retry)
  // instead of bricking the prompt.
  const [busyId, setBusyId] = useState<string | null>(null);
  const busy = busyId === (request.id as string);

  const reply = (status: "approved" | "rejected", scope: "once" | "always", msg?: string) => {
    if (busy) return;
    const id = request.id as string;
    setBusyId(id);
    void client
      .replyPermission(id, { status, scope, ...(msg !== undefined ? { message: msg } : {}) })
      .catch(() => setBusyId((current) => (current === id ? null : current)))
      .finally(() => onDone());
  };

  useInput((ch, key) => {
    if (busy) return;
    if (ui.stage === "reject") {
      if (key.escape) return reply("rejected", "once"); // esc = reject without a message
      if (key.return) return reply("rejected", "once", ui.message.trim().length > 0 ? ui.message.trim() : undefined);
      if (key.backspace || key.delete) {
        onUi((prev) => ({ ...prev, message: prev.message.slice(0, -1) }));
        return;
      }
      if (key.ctrl && ch === "w") {
        onUi((prev) => ({ ...prev, message: deleteWord(prev.message) }));
        return;
      }
      if (key.ctrl || key.meta) return;
      const body = typedChar(ch);
      if (body.length > 0) onUi((prev) => ({ ...prev, message: prev.message + body }));
      return;
    }
    // choose stage — plain keys only; ctrl/meta chords belong to the app.
    if (key.ctrl || key.meta) return;
    if (ch === "a") return reply("approved", "once");
    if (ch === "s") return reply("approved", "always");
    if (ch === "d") return onUi((prev) => ({ ...prev, stage: "reject" }));
    // esc never answers an ask — the run stays blocked until a real choice
    // (chat's esc keeps its interrupt-arming semantics meanwhile).
  });

  const detail = request.detail;
  const diffLines = detail?.diff !== undefined ? detail.diff.split("\n") : [];
  const hidden = Math.max(0, diffLines.length - DIFF_WINDOW);
  const t = useTheme();

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={t.warning} paddingX={1} flexShrink={0}>
      <Text wrap="truncate">
        <Text bold color={t.warning}>
          △ permission requested
        </Text>
        {queued > 0 && <Text color={t.dim}> · {queued} more queued</Text>}
      </Text>
      {context !== undefined && <Text color={t.secondary} wrap="truncate">{context}</Text>}
      <Text wrap="truncate">
        tool: <Text bold>{request.tool}</Text>
      </Text>
      {detail?.summary !== undefined && <Text wrap="wrap">{detail.summary}</Text>}

      {diffLines.length > 0 && (
        <Box flexDirection="column" marginTop={0}>
          {diffLines.slice(0, DIFF_WINDOW).map((line, i) => (
            <Text key={i} wrap="truncate">
              {line.startsWith("+++") || line.startsWith("---") ? (
                <Text color={t.dim}>{line}</Text>
              ) : line.startsWith("@@") ? (
                <Text color={t.secondary}>{line}</Text>
              ) : line.startsWith("+") ? (
                <Text color={t.success}>{line}</Text>
              ) : line.startsWith("-") ? (
                <Text color={t.danger}>{line}</Text>
              ) : (
                <Text color={t.dim}>{line}</Text>
              )}
            </Text>
          ))}
          {hidden > 0 && <Text color={t.dim}>… {hidden} more diff lines …</Text>}
        </Box>
      )}

      {ui.stage === "choose" ? (
        <Text color={t.dim}>a allow once · s allow always (session) · d reject with feedback</Text>
      ) : (
        <Box flexDirection="column" marginTop={0}>
          <Text color={t.warning}>reject — why? (optional; the model sees this message)</Text>
          <Text wrap="truncate">
            <Text color={ui.message.length === 0 ? t.dim : t.text}>{ui.message.length > 0 ? ui.message : "type a reason…"}</Text>
            <Text color={t.dim}>▌</Text>
          </Text>
          <Text color={t.dim}>enter reject · esc reject without message</Text>
        </Box>
      )}
    </Box>
  );
}
