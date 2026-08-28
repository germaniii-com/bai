import { Box, Text, useInput, useStdout, useWindowSize } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import type { BaiClient } from "@bai/api/client";
import type { Message, Session } from "@bai/shared";
import { messageText } from "../state/sync";
import { Spinner } from "../components/spinner";

/** Messages jumped per pageUp/pageDown (ctrl+u/ctrl+d) press. */
const PAGE = 12;
/** SGR mouse buttons for the wheel (X10 button codes + 1000h tracking). */
const WHEEL_UP = 64;
const WHEEL_DOWN = 65;

/**
 * Estimated rendered rows for a message at the given terminal width. User
 * messages render in a rounded box (+2 border rows, wrap width narrowed by
 * borders and paddingX → columns - 4); assistant messages are inset by
 * paddingLeft 2 + paddingRight 3 → columns - 5, one em narrower than the
 * user box's text width.
 */
function estimateRows(m: Message, columns: number): number {
  const text = messageText(m);
  const width = Math.max(8, columns - (m.role === "user" ? 4 : 5));
  let lines = 0;
  for (const seg of text.split("\n")) lines += Math.max(1, Math.ceil(seg.length / width));
  return m.role === "user" ? lines + 2 : Math.max(lines, 1);
}

/**
 * Chat view: scrollable message history + inline composer. The composer is a
 * minimal useInput-driven text input (no extra deps); ctrl-prefixed globals
 * are ignored here so typing stays clean. Scrolling is message-anchored:
 * `offset` counts messages hidden from the bottom (0 = pinned to latest), and
 * the window stays put while new messages arrive mid-read.
 */
export function ChatView({
  client,
  session,
  messages,
  runActive,
  onSessionCreated,
}: {
  client: BaiClient;
  session: Session | null;
  messages: Message[];
  /** True while the coordinator is draining this session (run.started → run.finished). */
  runActive: boolean;
  onSessionCreated: (session: Session) => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [sentPending, setSentPending] = useState(false);
  const [offset, setOffset] = useState(0);
  const lastLen = useRef(messages.length);

  // Waiting-for-reply indicator: from submit (optimistic) or run start until
  // the assistant's first text lands. Stops on errors too — run.finished
  // clears runActive even when no reply ever arrived.
  const last = messages[messages.length - 1];
  const hasVisibleReply = last !== undefined && last.role === "assistant" && messageText(last).length > 0;
  useEffect(() => {
    if (runActive || hasVisibleReply) setSentPending(false);
  }, [runActive, hasVisibleReply]);
  const waiting = (sentPending || runActive) && !hasVisibleReply;

  // Keep the reading window stable when messages arrive while scrolled up.
  useEffect(() => {
    const grew = messages.length - lastLen.current;
    lastLen.current = messages.length;
    if (grew > 0) setOffset((o) => (o > 0 ? o + grew : 0));
  }, [messages.length]);

  // Session switched → back to the latest messages, no stale pending state.
  useEffect(() => {
    setOffset(0);
    setSentPending(false);
  }, [session?.id]);

  const submitText = async (value: string): Promise<void> => {
    const trimmed = value.trim();
    if (trimmed.length === 0 || busy) return;
    setBusy(true);
    try {
      if (session === null) {
        const created = await client.createSession({ title: trimmed.slice(0, 60), workbench: "chat" });
        onSessionCreated(created);
        await client.submitPrompt(created.id, { text: trimmed });
      } else {
        await client.submitPrompt(session.id, { text: trimmed });
      }
      setText("");
      setSentPending(true); // dots until the run's first token (or run.finished)
      setOffset(0); // follow the reply
    } catch (err) {
      setSentPending(false);
      // Errors surface via the parent's error line on next refresh; keep input.
    } finally {
      setBusy(false);
    }
  };

  const submit = (): void => {
    void submitText(text);
  };

  // Latest message count for clamping — readable from stale closures (the
  // mouse listener subscribes once) without re-subscribing.
  const lenRef = useRef(messages.length);
  lenRef.current = messages.length;

  const scrollBy = useCallback((delta: number): void => {
    setOffset((o) => Math.max(0, Math.min(o + delta, Math.max(0, lenRef.current - 1))));
  }, []);

  // Mouse wheel scrolling: enable X10 mouse tracking with SGR encoding while
  // the chat view is mounted. Wheel events arrive through useInput itself —
  // ink's key parser doesn't recognize SGR mouse sequences, so it forwards
  // them as multi-character input (ESC prefix stripped). Parsing here keeps
  // stdin in ink's paused/readable mode; a separate stdin 'data' listener
  // would switch the stream to flowing mode and break ink's input path.
  const { stdout } = useStdout();
  useEffect(() => {
    stdout.write("\x1b[?1000h\x1b[?1006h");
    return () => {
      stdout.write("\x1b[?1006l\x1b[?1000l");
    };
  }, [stdout]);

  useInput((ch, key) => {
    // Mouse wheel (SGR sequence forwarded by ink as literal input, ESC
    // stripped). Works even while busy — reading history during a run.
    const wheel = ch !== undefined ? /^\x1b?\[<(\d+);\d+;\d+[Mm]$/.exec(ch) : null;
    if (wheel !== null) {
      const button = Number(wheel[1]);
      if (button === WHEEL_UP) return scrollBy(1);
      if (button === WHEEL_DOWN) return scrollBy(-1);
      return;
    }
    if (key.pageUp || (key.ctrl && ch === "u")) return scrollBy(PAGE);
    if (key.pageDown || (key.ctrl && ch === "d")) return scrollBy(-PAGE);
    if (busy || key.ctrl || key.meta) return;
    if (key.return) {
      void submit();
    } else if (key.backspace || key.delete) {
      setText((t) => t.slice(0, -1));
    } else if (ch !== undefined && ch.length > 0) {
      // Input can arrive batched: several keystrokes (or pasted text) in one
      // chunk. Newlines inside the chunk are submit boundaries — the text
      // accumulated so far, plus the completed segment, goes out as a message.
      const segments = ch.split(/[\r\n]+/);
      const tail = (segments.pop() ?? "").replace(/[\x00-\x1f\x7f]/g, "");
      if (segments.length > 0) {
        const completed = segments.map((s) => s.replace(/[\x00-\x1f\x7f]/g, "")).join(" ");
        void submitText(text + completed);
      }
      if (tail.length > 0) setText((t) => t + tail);
    }
  });

  const len = messages.length;
  const clamped = Math.min(offset, Math.max(0, len - 1));

  // Viewport windowing: the message list gets whatever rows the terminal has
  // left over from the fixed chrome (header, composer, footer, indicator).
  // Walking backward from the anchor keeps the newest messages visible.
  const { columns, rows } = useWindowSize();
  const chrome =
    3 /* header box */ +
    3 /* composer box */ +
    1 /* footer hints */ +
    1 /* list marginBottom */ +
    2 /* error line + estimation slack */ +
    (clamped > 0 ? 2 : 0) /* scroll indicator */;
  const budget = Math.max(1, rows - chrome);
  const end = len - clamped;
  let start = Math.max(0, end - 1);
  const newest = messages[end - 1];
  if (newest !== undefined) {
    let used = estimateRows(newest, columns);
    for (let i = end - 2; i >= 0; i--) {
      const m = messages[i];
      if (m === undefined) break;
      const cost = estimateRows(m, columns) + 1; // + gap row
      if (used + cost > budget) break;
      used += cost;
      start = i;
    }
  }
  const visible = messages.slice(start, end);

  return (
    <Box flexDirection="column" flexGrow={1}>
      {/* Viewport: flexBasis 0 + flexGrow 1 pins this box to exactly the
          leftover rows between header and composer; flex-end keeps messages
          hugging the composer. Overflow (estimation error) escapes upward,
          never into the composer. User messages get a bordered box; assistant
          messages render plain — role is conveyed by shape, not labels. */}
      <Box
        flexDirection="column"
        gap={1}
        marginBottom={1}
        flexGrow={1}
        flexShrink={1}
        flexBasis={0}
        justifyContent="flex-end"
      >
        {visible.length === 0 && <Text dimColor>No messages yet — say something.</Text>}
        {visible.map((m) => {
          const text = messageText(m);
          if (m.role === "user") {
            return (
              <Box key={m.id} borderStyle="round" borderColor="green" paddingX={1}>
                <Text wrap="wrap">{text}</Text>
              </Box>
            );
          }
          return (
            <Box key={m.id} paddingLeft={2} paddingRight={3}>
              <Text wrap="wrap" color={m.role === "assistant" ? undefined : "yellow"}>
                {text}
              </Text>
            </Box>
          );
        })}
        {waiting && <Spinner label="thinking…" />}
      </Box>

      {clamped > 0 && (
        <Box marginBottom={1}>
          <Text dimColor>
            ↑ {clamped} earlier message{clamped === 1 ? "" : "s"} · mouse wheel or pageUp/pageDown
            to scroll
          </Text>
        </Box>
      )}

      {/* Green border ties the composer to the user's message boxes — what
          you type here is what a green box above shows. */}
      <Box borderStyle="round" borderColor="green" paddingX={1}>
        <Text color="magenta">› </Text>
        <Text>{text}</Text>
        <Text dimColor>▌</Text>
        {busy && <Text dimColor> (working…)</Text>}
      </Box>
    </Box>
  );
}
