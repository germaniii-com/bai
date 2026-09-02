import { Box, Text, useInput, usePaste, useStdout, useWindowSize } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import type { BaiClient } from "@bai/api/client";
import type { Message, Session } from "@bai/shared";
import type { Mode } from "../app";
import { messageText, thinkingText, toolCalls } from "../state/sync";
import { Spinner } from "../components/spinner";
import {
  backspace,
  deleteForward,
  deleteWordBefore,
  insert,
  insertMultiline,
  moveLeft,
  moveLineDown,
  moveLineEnd,
  moveLineStart,
  moveLineUp,
  moveRight,
  openAbove,
  openBelow,
  sanitize,
  type Editor,
} from "../state/composer";
import { recordPrompt, resetTraversal, traverse } from "../state/history";
import { moveFocus, snapOffset } from "../state/focus";

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
  // Tool calls render one collapsed line each (args digest + status glyph),
  // with a gap row before the first one.
  const calls = toolCalls(m);
  if (calls.length > 0 && m.role !== "user") lines += calls.length + 1;
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
 * multi-line, cursor-aware text input built on the pure `Editor` model (no
 * extra deps); ctrl-prefixed globals are ignored here so typing stays clean.
 * Scrolling is message-anchored: `offset` counts messages hidden from the
 * bottom (0 = pinned to latest), and the window stays put while new messages
 * arrive mid-read.
 */
export function ChatView({
  client,
  session,
  messages,
  runActive,
  footerLines,
  mode,
  onEnterInput,
  onExitInput,
  onSessionCreated,
}: {
  client: BaiClient;
  session: Session | null;
  messages: Message[];
  /** True while the coordinator is draining this session (run.started → run.finished). */
  runActive: boolean;
  /** Exact footer line count (hints + error + setup hint) — click hit testing. */
  footerLines: number;
  /** Input mode owned by App: NORMAL (vim motions) vs INPUT (typing). */
  mode: Mode;
  /** Switch to INPUT mode (i/a/Enter in NORMAL; paste implies typing). */
  onEnterInput: () => void;
  /** Back to NORMAL (esc in INPUT). */
  onExitInput: () => void;
  onSessionCreated: (session: Session) => void;
}) {
  const [editor, setEditor] = useState<Editor>({ text: "", cursor: 0 });
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

  // NORMAL-mode transcript focus: index into `messages`, null = no focus
  // (plain browsing). j/k/up/down move it; the focused message renders
  // highlighted; Enter/Space toggle a focused thought's visibility.
  const [focus, setFocus] = useState<number | null>(null);
  // Last rendered visible window [start, end) — read by the key handler to
  // re-snap the scroll offset when focus leaves the viewport (same estimate
  // fidelity as click hit-testing; ref write during render, like lenRef).
  const windowRef = useRef<{ start: number; end: number }>({ start: 0, end: 0 });

  // Keep the reading window stable when messages arrive while scrolled up.
  useEffect(() => {
    const grew = messages.length - lastLen.current;
    lastLen.current = messages.length;
    if (grew > 0) setOffset((o) => (o > 0 ? o + grew : 0));
  }, [messages.length]);

  // Session switched → back to the latest messages, no stale pending state,
  // focus cleared (the transcript it pointed into is gone), history
  // traversal back to the live-draft boundary (history itself is global and
  // survives the switch).
  useEffect(() => {
    setOffset(0);
    setSentPending(false);
    setFocus(null);
    resetTraversal();
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

  /**
   * Submit `value` as a prompt. On success the draft clears to `nextDraft`
   * (default: empty) — but only when the draft is still exactly `value`, so
   * keystrokes that landed during the await survive. Burst submits pass the
   * post-Enter tail as `nextDraft`; a tail that coincidentally equals the
   * submitted value then clears to itself (a no-op), never to empty.
   */
  const submitText = async (value: string, nextDraft = ""): Promise<void> => {
    const trimmed = value.trim();
    if (trimmed.length === 0 || busy) return;
    setBusy(true);
    try {
      if (session === null) {
        // The server titles the session (truncated-prompt fallback, then an
        // LLM refine) from this first prompt — core/src/title.ts.
        const created = await client.createSession({ workbench: "chat" });
        onSessionCreated(created);
        await client.submitPrompt(created.id, { text: trimmed });
      } else {
        await client.submitPrompt(session.id, { text: trimmed });
      }
      recordPrompt(trimmed);
      setEditor((e) =>
        e.text === value ? { text: nextDraft, cursor: nextDraft.length } : e,
      );
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
    void submitText(editor.text);
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

  // Bracketed paste: pasted text (including newlines) arrives on its own
  // channel and is inserted literally at the cursor — it never reaches
  // useInput, which is what makes a lone "\n" there a reliable ctrl+j.
  // Paste implies typing intent: NORMAL mode switches to INPUT first
  // (idempotent when already there), so pasted content is always editable.
  usePaste((pasted) => {
    onEnterInput();
    setEditor((e) => insert(e, sanitize(pasted)));
  });

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
    // pageUp/pageDown scroll in both modes (not ctrl chords); ctrl+u/ctrl+d
    // paging is a NORMAL-mode command — dead while typing (mode split).
    if (key.pageUp) return scrollBy(PAGE);
    if (key.pageDown) return scrollBy(-PAGE);

    // esc: INPUT exits the mode; NORMAL clears the transcript focus first,
    // then interrupts the running drain (double-press: first arms, second
    // fires). Safe on an idle session; dialogs handle their own esc and
    // replace this view.
    if (key.escape) {
      if (mode === "input") return onExitInput();
      if (focus !== null) {
        setFocus(null);
        return;
      }
      if (runActive && session !== null) {
        if (escArmed) {
          disarmEsc();
          void client.interrupt(session.id);
        } else {
          setEscArmed(true);
          if (escTimer.current !== null) clearTimeout(escTimer.current);
          escTimer.current = setTimeout(disarmEsc, 2500);
        }
      }
      return;
    }

    // ctrl+j's legacy spelling (lone "\n", key.ctrl=false in legacy
    // terminals) is a kept editing chord in both modes — match it before the
    // mode branches. Kitty-protocol terminals deliver a real ctrl+j below.
    if (ch === "\n") return setEditor(openBelow);

    if (mode === "normal") {
      // NORMAL: vim motions + the ctrl command family. Plain typing is
      // ignored — only single-char mode entries count (batched chunks are
      // rapid-typing artifacts that belong to INPUT).
      if (key.ctrl) {
        if (ch === "u") return scrollBy(PAGE);
        if (ch === "d") return scrollBy(-PAGE);
        // ctrl+t toggles ALL reasoning nodes: expand all when any is
        // collapsed, collapse all otherwise.
        if (ch === "t") {
          const thinkingIds = messages
            .filter((m) => m.role === "assistant" && thinkingText(m).length > 0)
            .map((m) => m.id);
          const allExpanded =
            thinkingIds.length > 0 &&
            thinkingIds.every((id) => expandedThinking.has(id));
          setExpandedThinking(allExpanded ? new Set() : new Set(thinkingIds));
          return;
        }
        // Editing chords stay live in both modes (the draft persists).
        if (ch === "w") return setEditor(deleteWordBefore);
        if (ch === "j") return setEditor(openBelow);
        if (ch === "k") return setEditor(openAbove);
        return; // remaining ctrl chords belong to App's globals handler
      }
      if (ch === "i" || ch === "a") return onEnterInput();
      // Enter/Space toggle the focused thought's visibility; Enter falls
      // through to INPUT mode when the focus isn't on a thought.
      if (key.return || ch === " ") {
        const focusedMessage = focus !== null ? messages[focus] : undefined;
        if (
          focusedMessage !== undefined &&
          thinkingText(focusedMessage).length > 0
        ) {
          setExpandedThinking((prev) => {
            const next = new Set(prev);
            if (next.has(focusedMessage.id)) next.delete(focusedMessage.id);
            else next.add(focusedMessage.id);
            return next;
          });
          return;
        }
        if (key.return) return onEnterInput();
        return; // space outside a thought: no-op
      }
      // j/k/up/down: transcript traversal. The first press focuses the last
      // visible message (where you're looking); further steps clamp at the
      // ends and re-snap the scroll window when focus leaves the viewport.
      if (key.upArrow || ch === "k" || key.downArrow || ch === "j") {
        const len = messages.length;
        if (len === 0) return;
        const down = key.downArrow || ch === "j";
        const base =
          focus ?? Math.max(0, Math.min(windowRef.current.end, len) - 1);
        const next = moveFocus(base, len, down);
        setFocus(next);
        setOffset((o) =>
          snapOffset(
            next,
            len,
            o,
            windowRef.current.start,
            windowRef.current.end,
          ),
        );
      }
      return;
    }

    // ---- INPUT mode: typing into the draft ----
    // Kept editing chords; every other ctrl chord is dead while typing.
    if (key.ctrl) {
      if (ch === "w") return setEditor(deleteWordBefore);
      if (ch === "j") return setEditor(openBelow);
      if (ch === "k") return setEditor(openAbove);
      return;
    }
    if (busy || key.meta) return;
    // Up/down are line-wise cursor movement in the draft (standard editor
    // behavior). History traversal only engages from an empty draft — once
    // an entry is recalled, the arrows move within it; clear the draft to
    // traverse further. Recalled entries put the cursor at their end.
    if (key.upArrow) {
      if (editor.text.length === 0) {
        const recalled = traverse(true, editor.text);
        if (recalled !== null) setEditor({ text: recalled, cursor: recalled.length });
      } else {
        setEditor(moveLineUp);
      }
      return;
    }
    if (key.downArrow) {
      if (editor.text.length === 0) {
        const recalled = traverse(false, editor.text);
        if (recalled !== null) setEditor({ text: recalled, cursor: recalled.length });
      } else {
        setEditor(moveLineDown);
      }
      return;
    }
    if (key.return) {
      void submit();
    } else if (key.backspace) {
      setEditor(backspace);
    } else if (key.delete) {
      setEditor(deleteForward);
    } else if (key.home) {
      setEditor(moveLineStart);
    } else if (key.end) {
      setEditor(moveLineEnd);
    } else if (key.leftArrow) {
      setEditor(moveLeft);
    } else if (key.rightArrow) {
      setEditor(moveRight);
    } else if (ch !== undefined && ch.length > 0) {
      // Typed input can arrive batched (several keystrokes in one chunk).
      // \r is the only submit boundary (Enter); "\n" is ctrl+j and stays in
      // the draft as a structural newline (insertMultiline → vim o).
      const parts = ch.split(/\r/);
      const tail = sanitize(parts.pop() ?? "");
      if (parts.length > 0) {
        // Enter inside the burst: the draft (with the completed segment
        // inserted at the cursor) goes out; the tail becomes the new draft.
        const completed = parts.map((s) => sanitize(s)).join(" ");
        const value =
          editor.text.slice(0, editor.cursor) +
          completed +
          editor.text.slice(editor.cursor);
        setEditor({ text: tail, cursor: tail.length });
        void submitText(value, tail);
      } else if (tail.length > 0) {
        setEditor((e) => insertMultiline(e, tail));
      }
    }
  });

  const len = messages.length;
  const clamped = Math.min(offset, Math.max(0, len - 1));

  // Viewport windowing: the message list gets whatever rows the terminal has
  // left over from the fixed chrome (header, composer, footer, indicator).
  // Walking backward from the anchor keeps the newest messages visible.
  const { columns, rows } = useWindowSize();
  // The composer box grows with the draft: 2 border rows + one row per draft
  // line (multi-line drafts are real since ctrl+j/ctrl+k and paste).
  const composerLines = Math.max(1, editor.text.split("\n").length);
  const composerRows = 2 + composerLines;
  const chrome =
    3 /* header box */ +
    composerRows +
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
    composerRows -
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
  // Publish the rendered window for the key handler's focus re-snap (ref
  // write during render — the established pattern here, cf. lenRef).
  windowRef.current = { start, end };

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
        {visible.map((m, vi) => {
          const text = messageText(m);
          const focused = focus === start + vi;
          if (m.role === "user") {
            return (
              <Box
                key={m.id}
                borderStyle="round"
                // Neutral white outline at rest; the cyan accent is reserved
                // for the focus highlight so it stands out.
                borderColor={focused ? "cyan" : "white"}
                paddingX={1}
              >
                <Text wrap="wrap" bold={focused}>
                  {text}
                </Text>
              </Box>
            );
          }
          const thinking = thinkingText(m);
          const thinkingLineCount =
            thinking.length > 0 ? thinking.split("\n").length : 0;
          const expanded = expandedThinking.has(m.id);
          const calls = toolCalls(m);
          // Focus marker: an inline cyan ❯ on the block's first rendered
          // line — no extra rows, so estimateRows and click hit-testing stay
          // exact (the 2-column prefix lives inside the estimation slack).
          const marker = focused ? <Text color="cyan">❯ </Text> : null;
          const firstRowIsThinking = thinkingLineCount > 0;
          const firstRowIsTool = firstRowIsThinking === false && calls.length > 0;
          return (
            <Box key={m.id} {...assistantInset} flexDirection="column" gap={1}>
              {thinkingLineCount > 0 &&
                (expanded ? (
                  <Box flexDirection="column">
                    <Text dimColor>
                      {marker}── thought ──
                    </Text>
                    {thinking.split("\n").map((line, i) => (
                      <Text key={i} dimColor wrap="wrap">
                        {line.length > 0 ? line : " "}
                      </Text>
                    ))}
                  </Box>
                ) : (
                  <Text color={focused ? "cyan" : undefined} dimColor={!focused}>
                    {marker}▸ thought ({thinkingLineCount} line
                    {thinkingLineCount === 1 ? "" : "s"})
                  </Text>
                ))}
              {calls.length > 0 && (
                <Box flexDirection="column">
                  {calls.map((c, i) => {
                    const lineMarker = i === 0 && firstRowIsTool ? marker : null;
                    const glyph = c.status === "running" ? "◦" : c.status === "error" ? "✗" : "✓";
                    const color = c.status === "running" ? "yellow" : c.status === "error" ? "red" : "green";
                    return (
                      <Text key={c.callId} wrap="truncate">
                        {lineMarker}
                        <Text color={color}>{glyph} </Text>
                        <Text dimColor>{c.name}</Text>
                        {c.argsPreview.length > 0 && <Text> {c.argsPreview}</Text>}
                        {c.result !== undefined && c.result.isError && (
                          <Text color="red"> · denied/failed</Text>
                        )}
                      </Text>
                    );
                  })}
                </Box>
              )}
              <Text
                wrap="wrap"
                color={m.role === "assistant" ? undefined : "yellow"}
              >
                {thinkingLineCount === 0 && calls.length === 0 ? marker : null}
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
            ↑ {clamped} earlier message{clamped === 1 ? "" : "s"} · j/k or
            mouse wheel / pageUp-pageDown to scroll
          </Text>
        </Box>
      )}

      {/* The composer mirrors the mode: INPUT keeps the green border and ›
          prompt (the typing affordance — message boxes themselves are
          neutral white so the cyan focus highlight stands out), with the ▌
          block at the cursor position (multi-line drafts render their
          embedded newlines; ←/→/Home/End move the cursor). NORMAL dims the
          box and swaps the prompt to vim's ex-mode `:` — typing is off
          there. */}
      <Box
        borderStyle="round"
        borderColor={mode === "input" ? "green" : "gray"}
        paddingX={1}
      >
        <Text color="magenta">{mode === "input" ? "› " : ": "}</Text>
        <Text>
          {editor.text.slice(0, editor.cursor)}
          {mode === "input" && <Text dimColor>▌</Text>}
          {editor.text.slice(editor.cursor)}
        </Text>
        {busy && <Text dimColor> (working…)</Text>}
        {mode === "input" && <Text dimColor> · esc normal</Text>}
        {mode === "normal" && runActive && !escArmed && (
          <Text dimColor> · esc to stop</Text>
        )}
        {mode === "normal" && escArmed && (
          <Text color="yellow"> · esc again to stop</Text>
        )}
      </Box>
    </Box>
  );
}
