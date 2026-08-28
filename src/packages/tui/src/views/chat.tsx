import { Box, Text, useInput, useStdout, useWindowSize } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import type { BaiClient } from "@bai/api/client";
import type { Message, Session } from "@bai/shared";
import { messageText, thinkingText } from "../state/sync";
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
function estimateRows(m: Message, columns: number, expanded: boolean): number {
  const text = messageText(m);
  const width = Math.max(8, columns - (m.role === "user" ? 4 : 5));
  // Empty text (thinking-only phase, before the first answer delta) renders
  // zero rows — don't count a line for it.
  let lines = 0;
  if (text.length > 0) {
    for (const seg of text.split("\n"))
      lines += Math.max(1, Math.ceil(seg.length / width));
  }
  // Thinking nodes count toward the budget: expanded = header + reasoning
  // lines + gap; collapsed = summary line + gap before the reply.
  const thinking = thinkingText(m);
  if (thinking.length > 0 && m.role !== "user") {
    if (expanded) {
      lines += 2; // header + gap
      for (const seg of thinking.split("\n"))
        lines += Math.max(1, Math.ceil(seg.length / width));
    } else {
      lines += 2; // summary line + gap
    }
  }
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
  footerLines,
  onSessionCreated,
}: {
  client: BaiClient;
  session: Session | null;
  messages: Message[];
  /** True while the coordinator is draining this session (run.started → run.finished). */
  runActive: boolean;
  /** Exact footer line count (hints + error + setup hint) — click hit testing. */
  footerLines: number;
  onSessionCreated: (session: Session) => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [sentPending, setSentPending] = useState(false);
  const [offset, setOffset] = useState(0);
  const [escArmed, setEscArmed] = useState(false);
  const lastLen = useRef(messages.length);

  // Waiting-for-reply indicator: from submit (optimistic) or run start until
  // the assistant's first text lands. Stops on errors too — run.finished
  // clears runActive even when no reply ever arrived.
  const last = messages[messages.length - 1];
  const hasVisibleReply =
    last !== undefined &&
    last.role === "assistant" &&
    messageText(last).length > 0;
  useEffect(() => {
    if (runActive || hasVisibleReply) setSentPending(false);
  }, [runActive, hasVisibleReply]);
  const waiting = (sentPending || runActive) && !hasVisibleReply;

  // Thinking nodes (opencode parity): every assistant message's reasoning
  // renders as its own transcript node — collapsed by default, each toggled
  // individually by clicking its row (ctrl+t toggles all). The state
  // persists after the run and across session revisits; only the
  // *visibility* toggles.
  const [expandedThinking, setExpandedThinking] = useState<Set<string>>(
    new Set(),
  );

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

  // Double-esc interrupt arming: first esc arms ("esc again to stop"), the
  // second fires. Arms auto-expire so a stale press can't stop a later run.
  const escTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disarmEsc = useCallback(() => {
    setEscArmed(false);
    if (escTimer.current !== null) {
      clearTimeout(escTimer.current);
      escTimer.current = null;
    }
  }, []);
  useEffect(() => {
    if (!runActive) disarmEsc(); // run ended (reply, error, or interrupt)
  }, [runActive, disarmEsc]);
  useEffect(() => {
    disarmEsc(); // session switched — never carry an arm across
  }, [session?.id, disarmEsc]);
  useEffect(() => disarmEsc, [disarmEsc]); // unmount

  const submitText = async (value: string): Promise<void> => {
    const trimmed = value.trim();
    if (trimmed.length === 0 || busy) return;
    setBusy(true);
    try {
      if (session === null) {
        const created = await client.createSession({
          title: trimmed.slice(0, 60),
          workbench: "chat",
        });
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
    setOffset((o) =>
      Math.max(0, Math.min(o + delta, Math.max(0, lenRef.current - 1))),
    );
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
    // SGR mouse events arrive as literal input (ESC stripped): press
    // `ESC[<button;col;rowM`, release `…m`. Coordinates are 1-based. Works
    // even while busy — reading history during a run.
    const mouse =
      ch !== undefined ? /^\x1b?\[<(\d+);(\d+);(\d+)([Mm])$/.exec(ch) : null;
    if (mouse !== null) {
      const button = Number(mouse[1]);
      if (button === WHEEL_UP) return scrollBy(1);
      if (button === WHEEL_DOWN) return scrollBy(-1);
      // Left press (release ignored — one click, one toggle) on a thinking
      // node's row toggles that node individually.
      if (button === 0 && mouse[4] === "M") {
        const row = Number(mouse[3]);
        for (const [id, nodeRow] of nodeRows) {
          if (nodeRow === row) {
            setExpandedThinking((prev) => {
              const next = new Set(prev);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              return next;
            });
            break;
          }
        }
      }
      return;
    }
    if (key.pageUp || (key.ctrl && ch === "u")) return scrollBy(PAGE);
    if (key.pageDown || (key.ctrl && ch === "d")) return scrollBy(-PAGE);
    // esc interrupts the running drain (waiting or mid-stream) — double-press:
    // first arms, second fires. Safe on an idle session; dialogs handle their
    // own esc and replace this view.
    if (key.escape && runActive && session !== null) {
      if (escArmed) {
        disarmEsc();
        void client.interrupt(session.id);
      } else {
        setEscArmed(true);
        if (escTimer.current !== null) clearTimeout(escTimer.current);
        escTimer.current = setTimeout(disarmEsc, 2500);
      }
      return;
    }
    // ctrl+t toggles ALL reasoning nodes (works mid-typing; ctrl never
    // inserts): expand all when any is collapsed, collapse all otherwise.
    if (key.ctrl && ch === "t") {
      const thinkingIds = messages
        .filter((m) => m.role === "assistant" && thinkingText(m).length > 0)
        .map((m) => m.id);
      const allExpanded =
        thinkingIds.length > 0 &&
        thinkingIds.every((id) => expandedThinking.has(id));
      setExpandedThinking(allExpanded ? new Set() : new Set(thinkingIds));
      return;
    }
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
        const completed = segments
          .map((s) => s.replace(/[\x00-\x1f\x7f]/g, ""))
          .join(" ");
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
    (clamped > 0 ? 2 : 0); /* scroll indicator */
  const budget = Math.max(1, rows - chrome);
  const end = len - clamped;

  // Terminal row (1-based) of the viewport's last content row: the viewport
  // is bottom-anchored, so its bottom edge is the terminal bottom minus
  // composer, footer, scroll block, and the viewport's bottom margin.
  // Referenced from the mouse handler above via closure (via nodeRows).
  // Keep these constants in sync with the JSX below and App's footer.
  const viewportBottomRow =
    rows -
    footerLines -
    3 /* composer box */ -
    (clamped > 0 ? 2 : 0) -
    1; /* viewport marginBottom */
  let start = Math.max(0, end - 1);
  const newest = messages[end - 1];
  if (newest !== undefined) {
    let used = estimateRows(newest, columns, expandedThinking.has(newest.id));
    for (let i = end - 2; i >= 0; i--) {
      const m = messages[i];
      if (m === undefined) break;
      const cost = estimateRows(m, columns, expandedThinking.has(m.id)) + 1; // + gap row
      if (used + cost > budget) break;
      used += cost;
      start = i;
    }
  }
  const visible = messages.slice(start, end);

  // Terminal row of each visible thinking node (1-based) — click hit testing.
  // Walk bottom-up from the viewport's last row: while waiting the spinner
  // occupies that row plus a gap row above it; every message block is
  // separated by a gap row, and a node's clickable line is its block's first
  // row. Must stay in sync with the JSX below.
  const nodeRows = new Map<string, number>();
  {
    let cursorBottom = viewportBottomRow - (waiting ? 2 : 0);
    for (let i = visible.length - 1; i >= 0; i--) {
      const m = visible[i];
      if (m === undefined) break;
      const height = estimateRows(m, columns, expandedThinking.has(m.id));
      const top = cursorBottom - height + 1;
      if (m.role === "assistant" && thinkingText(m).length > 0)
        nodeRows.set(m.id, top);
      cursorBottom = top - 1;
    }
  }

  // Non-user content (assistant replies, the empty-state line, the thinking
  // spinner) shares one inset so the whole non-user column aligns.
  const assistantInset = { paddingLeft: 2, paddingRight: 3 };

  return (
    <Box flexDirection="column" flexGrow={1}>
      {/* Viewport: flexBasis 0 + flexGrow 1 pins this box to exactly the
          leftover rows between header and composer; flex-end keeps messages
          hugging the composer. Overflow (estimation error) escapes upward,
          never into the composer. User messages get a bordered box; assistant
          messages render plain — role is conveyed by shape, not labels.
          Reasoning renders as a transcript node (opencode parity): collapsed
          to a summary line, expanded to the full chain of thought. */}
      <Box
        flexDirection="column"
        gap={1}
        marginBottom={1}
        flexGrow={1}
        flexShrink={1}
        flexBasis={0}
        justifyContent="flex-end"
      >
        {visible.length === 0 && !waiting && (
          <Box {...assistantInset}>
            <Text dimColor>No messages yet — say something.</Text>
          </Box>
        )}
        {visible.map((m) => {
          const text = messageText(m);
          if (m.role === "user") {
            return (
              <Box
                key={m.id}
                borderStyle="round"
                borderColor="green"
                paddingX={1}
              >
                <Text wrap="wrap">{text}</Text>
              </Box>
            );
          }
          const thinking = thinkingText(m);
          const thinkingLineCount =
            thinking.length > 0 ? thinking.split("\n").length : 0;
          const expanded = expandedThinking.has(m.id);
          return (
            <Box key={m.id} {...assistantInset} flexDirection="column" gap={1}>
              {thinkingLineCount > 0 &&
                (expanded ? (
                  <Box flexDirection="column">
                    <Text dimColor>── thought ──</Text>
                    {thinking.split("\n").map((line, i) => (
                      <Text key={i} dimColor wrap="wrap">
                        {line.length > 0 ? line : " "}
                      </Text>
                    ))}
                  </Box>
                ) : (
                  <Text dimColor>
                    ▸ thought ({thinkingLineCount} line
                    {thinkingLineCount === 1 ? "" : "s"})
                  </Text>
                ))}
              <Text
                wrap="wrap"
                color={m.role === "assistant" ? undefined : "yellow"}
              >
                {text}
              </Text>
            </Box>
          );
        })}
        {waiting && (
          <Box {...assistantInset}>
            <Spinner label="thinking…" />
          </Box>
        )}
      </Box>

      {clamped > 0 && (
        <Box marginBottom={1}>
          <Text dimColor>
            ↑ {clamped} earlier message{clamped === 1 ? "" : "s"} · mouse wheel
            or pageUp/pageDown to scroll
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
        {runActive && !escArmed && <Text dimColor> · esc to stop</Text>}
        {escArmed && <Text color="yellow"> · esc again to stop</Text>}
      </Box>
    </Box>
  );
}
