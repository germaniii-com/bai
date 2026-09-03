import { Box, Text, useInput, usePaste, useStdout, useWindowSize } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import { ScrollView, type ScrollViewRef } from "../components/scroll-view";
import type { BaiClient } from "@bai/api/client";
import type { Message, Session } from "@bai/shared";
import { unwrapTaskOutput } from "@bai/shared";
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
import { moveFocus } from "../state/focus";

/** SGR mouse buttons for the wheel (X10 button codes + 1000h tracking). */
const WHEEL_UP = 64;
const WHEEL_DOWN = 65;
/** Terminal rows per mouse-wheel tick (opencode's default scroll speed). */
const WHEEL_ROWS = 3;
/** The app header is exactly 3 rows (round border + one truncated line), so
 *  the chat viewport always starts at terminal row 4 (1-based) — the anchor
 *  for click hit-testing. */
const VIEWPORT_TOP_ROW = 4;

/**
 * Chat view: continuous-scroll message history + inline composer. The
 * composer is a multi-line, cursor-aware text input built on the pure
 * `Editor` model (no extra deps); ctrl-prefixed globals are ignored here so
 * typing stays clean.
 *
 * Scrolling is ROW-based and continuous (components/scroll-view.tsx): the
 * transcript renders in full and the container clips at `scrollOffset` rows
 * from the top, so partial messages at the viewport edges are natural — no
 * message snapping. Follow-the-bottom is the sticky policy: while pinned
 * (`followRef`), every content-height change re-snaps to the bottom; scrolled
 * up, the reading window is automatically stable while new content streams in
 * below (the offset is from the top, so new rows appear out of view).
 */
export function ChatView({
  client,
  session,
  messages,
  runActive,
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
  const [escArmed, setEscArmed] = useState(false);

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

  // Task nodes (subagent spawning): the same collapsible treatment for the
  // `task` tool — expanded shows the child agent's final output (unwrapped
  // from its <task> envelope). Keyed `${messageId}:${callId}`; toggled by
  // Enter/Space on a focused message and folded into ctrl+t.
  const [expandedTasks, setExpandedTasks] = useState<Set<string>>(new Set());

  // NORMAL-mode transcript focus: index into `messages`, null = no focus
  // (plain browsing). ctrl+j/ctrl+k move it; the focused message renders
  // highlighted; Enter/Space toggle a focused thought's visibility.
  const [focus, setFocus] = useState<number | null>(null);

  // ---- Continuous scroll state (terminal rows from the transcript top) ----
  const scrollRef = useRef<ScrollViewRef>(null);
  const [scrollOffset, setScrollOffset] = useState(0);
  // Measured transcript/viewport heights (mirrored from the ScrollView) —
  // drive the indicator, clamping, and the paging distances.
  const [contentHeight, setContentHeight] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const bottomOffset = Math.max(0, contentHeight - viewportHeight);
  // Sticky-bottom policy: follow = pinned to the latest content; pending = a
  // session switch or submit wants the next content-height change to snap.
  const followRef = useRef(true);
  const pendingBottomRef = useRef(false);
  // Latest offset readable from stale closures (the mouse listener
  // subscribes once) without re-subscribing.
  const scrollOffsetRef = useRef(0);
  scrollOffsetRef.current = scrollOffset;

  // Session switched → follow the new transcript from the bottom, no stale
  // pending state, focus cleared (the transcript it pointed into is gone),
  // history traversal back to the live-draft boundary (history itself is
  // global and survives the switch).
  useEffect(() => {
    followRef.current = true;
    pendingBottomRef.current = true;
    setScrollOffset(0);
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
      // Follow the reply: re-engage sticky-bottom; the snap happens when the
      // user message lands (content-height change).
      followRef.current = true;
      pendingBottomRef.current = true;
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

  // ---- Scroll operations (continuous, clamped to [0, bottomOffset]) ----
  const scrollTo = useCallback(
    (offset: number): void => {
      const bottom = scrollRef.current?.getBottomOffset() ?? bottomOffset;
      const next = Math.max(0, Math.min(offset, bottom));
      followRef.current = next >= bottom;
      setScrollOffset(next);
    },
    [bottomOffset],
  );

  const scrollBy = useCallback(
    (delta: number): void => {
      scrollTo(scrollOffsetRef.current + delta);
    },
    [scrollTo],
  );

  // Follow-the-bottom wiring: while pinned (or a snap is pending), every
  // content-height change re-anchors to the bottom — streaming replies,
  // thinking expand/collapse, and the waiting spinner all ride this. Scrolled
  // up, the offset is from the TOP, so new rows appear out of view and the
  // reading window is stable with no compensation at all.
  const handleContentHeightChange = useCallback((height: number): void => {
    setContentHeight(height);
    const bottom = Math.max(0, height - (scrollRef.current?.getViewportHeight() ?? 0));
    if (pendingBottomRef.current || followRef.current) {
      pendingBottomRef.current = false;
      followRef.current = true;
      setScrollOffset(bottom);
    } else if (scrollOffsetRef.current > bottom) {
      setScrollOffset(bottom); // content shrank below the reading position
    }
  }, []);

  const handleViewportSizeChange = useCallback(
    (size: { width: number; height: number }): void => {
      setViewportHeight(size.height);
      if (pendingBottomRef.current || followRef.current) {
        pendingBottomRef.current = false;
        followRef.current = true;
        setScrollOffset(
          Math.max(0, (scrollRef.current?.getContentHeight() ?? 0) - size.height),
        );
      }
    },
    [],
  );

  // ---- NORMAL-mode focus traversal (ctrl+j/ctrl+k) ----
  // The first press focuses the last visible message (where you're looking);
  // further steps clamp at the ends and scroll BY ROWS to reveal the target.
  const lastVisibleMessage = (): number => {
    const limit = scrollOffsetRef.current + Math.max(1, viewportHeight);
    for (let i = messages.length - 1; i >= 0; i--) {
      const pos = scrollRef.current?.getItemPosition(i);
      if (pos !== null && pos !== undefined && pos.top < limit) return i;
    }
    return Math.max(0, messages.length - 1);
  };

  const revealMessage = (index: number): void => {
    const pos = scrollRef.current?.getItemPosition(index);
    if (pos === null || pos === undefined) return;
    const current = scrollOffsetRef.current;
    const vh = Math.max(1, viewportHeight);
    if (pos.top < current) {
      scrollTo(pos.top); // target above the window: pin its top row
    } else if (pos.top + pos.height > current + vh) {
      scrollTo(Math.max(0, pos.top + pos.height - vh)); // below: pin its bottom row
    }
  };

  const stepFocus = (down: boolean): void => {
    const len = messages.length;
    if (len === 0) return;
    const base = focus ?? lastVisibleMessage();
    const next = moveFocus(base, len, down);
    setFocus(next);
    revealMessage(next);
  };

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

  // Terminal resize: ink re-renders (which re-measures the viewport), but an
  // explicit remeasure keeps the measured size honest per upstream guidance.
  const { columns, rows } = useWindowSize();
  useEffect(() => {
    scrollRef.current?.remeasure();
  }, [columns, rows]);

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
      // Wheel: continuous row scrolling. The offset is from the transcript
      // TOP, so wheel-up (toward older content) is a negative delta.
      if (button === WHEEL_UP) return scrollBy(-WHEEL_ROWS);
      if (button === WHEEL_DOWN) return scrollBy(WHEEL_ROWS);
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
    // pageUp/pageDown = half a viewport; ctrl+u/ctrl+d = a quarter (opencode).
    const pageRows = Math.max(1, Math.floor(viewportHeight / 2));
    const halfPageRows = Math.max(1, Math.floor(viewportHeight / 4));
    if (key.pageUp) return scrollBy(-pageRows);
    if (key.pageDown) return scrollBy(pageRows);

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

    if (mode === "normal") {
      // NORMAL: vim motions + the ctrl command family. Plain typing is
      // ignored — only single-char mode entries count (batched chunks are
      // rapid-typing artifacts that belong to INPUT).
      if (key.ctrl) {
        if (ch === "u") return scrollBy(-halfPageRows);
        if (ch === "d") return scrollBy(halfPageRows);
        // ctrl+j/ctrl+k: transcript focus traversal (the cyan highlight) —
        // steps message-by-message and scrolls by rows to reveal the target.
        if (ch === "j") return stepFocus(true);
        if (ch === "k") return stepFocus(false);
        // ctrl+t toggles ALL reasoning nodes AND task nodes: expand all
        // when any is collapsed, collapse all otherwise.
        if (ch === "t") {
          const thinkingIds = messages
            .filter((m) => m.role === "assistant" && thinkingText(m).length > 0)
            .map((m) => m.id);
          const taskIds = messages.flatMap((m) =>
            m.role === "assistant"
              ? toolCalls(m)
                  .filter((c) => c.name === "task" && c.result !== undefined)
                  .map((c) => `${m.id}:${c.callId}`)
              : [],
          );
          const allOpen =
            (thinkingIds.length === 0 || thinkingIds.every((id) => expandedThinking.has(id))) &&
            (taskIds.length === 0 || taskIds.every((id) => expandedTasks.has(id)));
          setExpandedThinking(allOpen ? new Set() : new Set(thinkingIds));
          setExpandedTasks(allOpen ? new Set() : new Set(taskIds));
          return;
        }
        // Editing chords stay live in both modes (the draft persists).
        if (ch === "w") return setEditor(deleteWordBefore);
        return; // remaining ctrl chords belong to App's globals handler
      }
      // ctrl+j's legacy spelling (lone "\n": ink parses the raw linefeed byte
      // as name:'enter' with ctrl=false, so it never reaches the ctrl branch
      // above). Typing is ignored in NORMAL mode, so a lone "\n" here is
      // unambiguously ctrl+j → focus traversal down.
      if (ch === "\n") return stepFocus(true);
      if (ch === "i" || ch === "a") return onEnterInput();
      // Enter/Space toggle the focused thought's visibility; task nodes
      // toggle the same way (thoughts take precedence); Enter falls through
      // to INPUT mode when the focus isn't on either.
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
        if (focusedMessage !== undefined) {
          const taskIds = toolCalls(focusedMessage)
            .filter((c) => c.name === "task" && c.result !== undefined)
            .map((c) => `${focusedMessage.id}:${c.callId}`);
          if (taskIds.length > 0) {
            setExpandedTasks((prev) => {
              const next = new Set(prev);
              const allOpen = taskIds.every((id) => next.has(id));
              for (const id of taskIds) {
                if (allOpen) next.delete(id);
                else next.add(id);
              }
              return next;
            });
            return;
          }
        }
        if (key.return) return onEnterInput();
        return; // space outside a thought/task: no-op
      }
      // j/k/arrows: continuous line scroll (±1 row) — the smooth path.
      if (key.upArrow || ch === "k") return scrollBy(-1);
      if (key.downArrow || ch === "j") return scrollBy(1);
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
    // ctrl+j's legacy spelling (lone "\n", key.ctrl=false in legacy
    // terminals) is a kept editing chord in INPUT mode only — NORMAL's
    // ctrl+j/k now drive focus traversal.
    if (ch === "\n") return setEditor(openBelow);
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
  // Clamp for rendering: the measured content height can lag one commit behind
  // a scroll, and the follow callbacks re-sync the state.
  const shownOffset = Math.min(scrollOffset, bottomOffset);

  // Messages fully above the viewport top — the "↑ N earlier messages" count.
  // Skipped until the first measurement lands (heights default to 0).
  let aboveCount = 0;
  if (len > 0 && contentHeight > 0) {
    for (let i = 0; i < len; i++) {
      const pos = scrollRef.current?.getItemPosition(i);
      if (pos !== null && pos !== undefined && pos.top + pos.height <= shownOffset) {
        aboveCount++;
      } else {
        break;
      }
    }
  }

  // Terminal row (1-based) of each visible thinking node — click hit testing.
  // The thinking header is the message block's first rendered row; the
  // per-item gap margin (i > 0) lives inside the measured item, above that
  // row. Content row c maps to terminal row VIEWPORT_TOP_ROW + c − shownOffset.
  const nodeRows = new Map<string, number>();
  if (len > 0 && contentHeight > 0) {
    const vh = Math.max(1, viewportHeight);
    for (let i = 0; i < len; i++) {
      const m = messages[i];
      if (m === undefined || m.role !== "assistant" || thinkingText(m).length === 0) {
        continue;
      }
      const pos = scrollRef.current?.getItemPosition(i);
      if (pos === null || pos === undefined) continue;
      const row = VIEWPORT_TOP_ROW + pos.top + (i === 0 ? 0 : 1) - shownOffset;
      if (row >= VIEWPORT_TOP_ROW && row < VIEWPORT_TOP_ROW + vh) {
        nodeRows.set(m.id, row);
      }
    }
  }

  // Non-user content (assistant replies, the empty-state line, the thinking
  // spinner) shares one inset so the whole non-user column aligns.
  const assistantInset = { paddingLeft: 2, paddingRight: 3 };

  return (
    <Box flexDirection="column" flexGrow={1}>
      {/* Continuous scroll viewport (components/scroll-view.tsx): the
          transcript renders in full and the container clips at `scrollOffset`
          rows from the top — scrolling is row-continuous and partial messages
          at the edges are natural. bottomAlign keeps short transcripts hugging
          the composer. The component's overflow-hidden viewport is the
          deterministic guard: content can never bleed into the composer.
          Message boxes carry flexShrink 0 so Yoga never compresses them.
          User messages get a bordered box; assistant messages render plain —
          role is conveyed by shape, not labels. Reasoning renders as a
          transcript node (opencode parity): collapsed to a summary line,
          expanded to the full chain of thought. */}
      <ScrollView
        ref={scrollRef}
        scrollOffset={shownOffset}
        bottomAlign
        onContentHeightChange={handleContentHeightChange}
        onViewportSizeChange={handleViewportSizeChange}
        flexGrow={1}
        flexShrink={1}
        flexBasis={0}
        minHeight={0}
        marginBottom={1}
      >
        {messages.map((m, i) => {
          const text = messageText(m);
          const focused = focus === i;
          // Per-item gap row (replaces the old container gap): rendered
          // INSIDE the measured item so measured positions stay exact.
          const gap = i === 0 ? 0 : 1;
          if (m.role === "user") {
            return (
              <Box key={m.id} marginTop={gap} flexShrink={0}>
                <Box
                  borderStyle="round"
                  // Neutral white outline at rest; the cyan accent is reserved
                  // for the focus highlight so it stands out.
                  borderColor={focused ? "cyan" : "white"}
                  paddingX={1}
                  flexShrink={0}
                >
                  <Text wrap="wrap" bold={focused}>
                    {text}
                  </Text>
                </Box>
              </Box>
            );
          }
          const thinking = thinkingText(m);
          const thinkingLineCount =
            thinking.length > 0 ? thinking.split("\n").length : 0;
          const expanded = expandedThinking.has(m.id);
          const calls = toolCalls(m);
          // Focus marker: an inline cyan ❯ on the block's first rendered
          // line — no extra rows, so measured positions and click
          // hit-testing stay exact.
          const marker = focused ? <Text color="cyan">❯ </Text> : null;
          const firstRowIsThinking = thinkingLineCount > 0;
          const firstRowIsTool = firstRowIsThinking === false && calls.length > 0;
          return (
            <Box key={m.id} marginTop={gap} flexShrink={0}>
              <Box {...assistantInset} flexDirection="column" gap={1} flexShrink={0}>
                {thinkingLineCount > 0 &&
                  (expanded ? (
                    <Box flexDirection="column">
                      <Text dimColor>
                        {marker}── thought ──
                      </Text>
                      {thinking.split("\n").map((line, li) => (
                        <Text key={li} dimColor wrap="wrap">
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
                    {calls.map((c, ci) => {
                      const lineMarker = ci === 0 && firstRowIsTool ? marker : null;
                      const glyph = c.status === "running" ? "◦" : c.status === "error" ? "✗" : "✓";
                      const color = c.status === "running" ? "yellow" : c.status === "error" ? "red" : "green";
                      // task: a collapsible node — expanded shows the child
                      // agent's final output (opencode2 parity).
                      const isTask = c.name === "task" && c.result !== undefined;
                      const taskKey = `${m.id}:${c.callId}`;
                      const taskOpen = isTask && expandedTasks.has(taskKey);
                      const taskOutput = isTask ? unwrapTaskOutput(c.result?.content ?? "") : undefined;
                      return (
                        <Box key={c.callId} flexDirection="column">
                          <Text wrap="truncate">
                            {lineMarker}
                            <Text color={color}>{glyph} </Text>
                            <Text dimColor>{c.name}</Text>
                            {c.argsPreview.length > 0 && <Text> {c.argsPreview}</Text>}
                            {c.result !== undefined && c.result.isError && (
                              <Text color="red"> · denied/failed</Text>
                            )}
                            {isTask && focused && (
                              <Text dimColor> · enter to {taskOpen ? "hide" : "view"} output</Text>
                            )}
                          </Text>
                          {taskOpen && (
                            <Box flexDirection="column" paddingLeft={2}>
                              {(taskOutput?.text ?? c.result?.content ?? "")
                                .split("\n")
                                .map((line, li) => (
                                  <Text key={li} dimColor wrap="wrap">
                                    {line.length > 0 ? line : " "}
                                  </Text>
                                ))}
                            </Box>
                          )}
                        </Box>
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
            </Box>
          );
        })}
        {len === 0 && !waiting && (
          <Box {...assistantInset}>
            <Text dimColor>No messages yet — say something.</Text>
          </Box>
        )}
        {waiting && (
          <Box marginTop={len > 0 ? 1 : 0} {...assistantInset}>
            <Spinner label="thinking…" />
          </Box>
        )}
      </ScrollView>

      {aboveCount > 0 && (
        <Box marginBottom={1}>
          <Text dimColor>
            ↑ {aboveCount} earlier message{aboveCount === 1 ? "" : "s"} · mouse
            wheel / pageUp-pageDown to scroll · ctrl+j/k to focus
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
