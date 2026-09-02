import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { BaiClient } from "@bai/api/client";
import type { PermissionRequest } from "@bai/shared";
import { deleteWord } from "../state/composer";

/** Diff lines rendered before eliding with a counter. */
const DIFF_WINDOW = 14;

/**
 * Interactive permission ask (opencode2's dialog, bai-flavored):
 *
 *   a — allow once · s — allow always (this session) · d — reject
 *
 * Reject opens a small optional-message input (opencode's CorrectedError):
 * the text rides the denial back to the model as feedback. File asks show
 * the computed diff from the request's detail.
 *
 * Rendered in the app's dialog slot — it owns the keyboard while pending
 * (first reply wins across devices; a loser's dialog clears via the
 * permission.replied event).
 */
export function PermissionDialog({
  client,
  request,
  onDone,
}: {
  client: BaiClient;
  request: PermissionRequest;
  onDone: () => void;
}) {
  // "choose" = the three options; "reject" = optional feedback message input.
  const [stage, setStage] = useState<"choose" | "reject">("choose");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const reply = (status: "approved" | "rejected", scope: "once" | "always", msg?: string) => {
    if (busy) return;
    setBusy(true);
    void client
      .replyPermission(request.id as string, { status, scope, ...(msg !== undefined ? { message: msg } : {}) })
      .catch(() => {})
      .finally(() => onDone());
  };

  useInput((ch, key) => {
    if (busy) return;
    if (stage === "reject") {
      if (key.escape) return reply("rejected", "once"); // esc = reject without a message
      if (key.return) return reply("rejected", "once", message.trim().length > 0 ? message.trim() : undefined);
      if (key.backspace || key.delete) {
        setMessage((m) => m.slice(0, -1));
        return;
      }
      if (key.ctrl && ch === "w") {
        setMessage((m) => deleteWord(m));
        return;
      }
      if (key.ctrl || key.meta) return;
      if (ch !== undefined && ch.length > 0) {
        const body = ch.replace(/[\r\n\x00-\x1f\x7f]/g, "");
        if (body.length > 0) setMessage((m) => m + body);
      }
      return;
    }
    // choose stage
    if (ch === "a") return reply("approved", "once");
    if (ch === "s") return reply("approved", "always");
    if (ch === "d") return setStage("reject");
    // esc never answers an ask — the run stays blocked until a real choice.
  });

  const detail = request.detail;
  const diffLines = detail?.diff !== undefined ? detail.diff.split("\n") : [];
  const hidden = Math.max(0, diffLines.length - DIFF_WINDOW);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow">
        permission requested
      </Text>
      <Text>
        tool: <Text bold>{request.tool}</Text>
      </Text>
      {detail?.summary !== undefined && <Text>{detail.summary}</Text>}

      {diffLines.length > 0 && (
        <Box flexDirection="column" marginTop={0}>
          {diffLines.slice(0, DIFF_WINDOW).map((line, i) => (
            <Text key={i} wrap="truncate">
              {line.startsWith("+++") || line.startsWith("---") ? (
                <Text dimColor>{line}</Text>
              ) : line.startsWith("@@") ? (
                <Text color="magenta">{line}</Text>
              ) : line.startsWith("+") ? (
                <Text color="green">{line}</Text>
              ) : line.startsWith("-") ? (
                <Text color="red">{line}</Text>
              ) : (
                <Text dimColor>{line}</Text>
              )}
            </Text>
          ))}
          {hidden > 0 && <Text dimColor>… {hidden} more diff lines …</Text>}
        </Box>
      )}

      {stage === "choose" ? (
        <Text dimColor>a allow once · s allow always (session) · d reject with feedback</Text>
      ) : (
        <Box flexDirection="column" marginTop={0}>
          <Text color="yellow">reject — why? (optional; the model sees this message)</Text>
          <Text>
            <Text dimColor={message.length === 0}>{message.length > 0 ? message : "type a reason…"}</Text>
            <Text dimColor>▌</Text>
          </Text>
          <Text dimColor>enter reject · esc reject without message</Text>
        </Box>
      )}
    </Box>
  );
}
