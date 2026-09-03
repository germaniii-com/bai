import { Box, Text, useInput, usePaste, useStdout, useWindowSize } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import { ScrollView, type ScrollViewRef } from "../components/scroll-view";
import type { BaiClient } from "@bai/api/client";
import type { Message, PermissionRequest, QuestionRequest, Session } from "@bai/shared";
import type { Mode } from "../app";
import { buildTranscriptItems, messageText, thinkingText, type TranscriptItem } from "../state/sync";
import { emptySubagentState, findChildForTask, type SubagentActivity, type SubagentState } from "../state/subagents";
import { emptyAskUi, type AskUiState } from "../state/asks";
import { Spinner } from "../components/spinner";
import { PermissionPrompt } from "./permission-prompt";
import { QuestionPrompt } from "./question-prompt";
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
  onOpenSubagent,
  subagents = emptySubagentState,
  pendingAsks = [],
  pendingChildAsks = [],
  pendingQuestions = [],
  askUi,
  setAskUi,
  onPermissionDone,
  onChildAskDone,
  onQuestionDone,
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
  /**
   * Open the subagent output dialog — `sessionId` when the task's child is
   * resolved (result link or title match), undefined to let App focus the
   * first running/asking child.
   */
  onOpenSubagent: (sessionId: string | undefined) => void;
  /** Tracked subagents of this session — live status for task nodes. */
  subagents?: SubagentState;
  // ---- inline ask prompts (opencode's above-the-editor placement) ------
  /** Pending permission asks for the active session (App-owned queue). */
  pendingAsks?: PermissionRequest[];
  /** Pending asks from the active session's subagents (firehose-fed). */
  pendingChildAsks?: PermissionRequest[];
  /** Pending agent→user question blocks (the `question` tool). */
  pendingQuestions?: QuestionRequest[];
  /** App-hoisted prompt UI state (survives prompt unmounts — state/asks.ts). */
  askUi?: AskUiState;
  /** Update the hoisted prompt state. */
  setAskUi?: (update: (prev: AskUiState) => AskUiState) => void;
  /** Pop the head ask off its queue after a reply (App applies the slice). */
  onPermissionDone?: () => void;
  onChildAskDone?: () => void;
  onQuestionDone?: () => void;
}) {
  const [editor, setEditor] = useState<Editor>({ text: "", cursor: 0 });
  const [busy, setBusy] = useState(false);
  const [sentPending, setSentPending] = useState(false);
  const [escArmed, setEscArmed] = useState(false);

  // ---- inline ask prompts (opencode's above-the-editor placement) ------
  // The head pending ask (priority: parent permission > subagent
  // permission > question — the modal era's ordering). While one is
  // pending it takes the composer's slot and owns plain keys; the
  // transcript (mouse wheel, paging, ctrl+u/d), ctrl-chords, view
  // switching, and session switching all stay live.
  const headPermission = pendingAsks[0] ?? pendingChildAsks[0];
  const headFromChild = pendingAsks.length === 0 && headPermission !== undefined;
  const headQuestion = headPermission === undefined ? pendingQuestions[0] : undefined;
  const askPending = headPermission !== undefined || headQuestion !== undefined;
  const askQueued = Math.max(0, pendingAsks.length + pendingChildAsks.length + pendingQuestions.length - 1);
  // Origin line for a subagent's ask (who is asking).
  const childContext =
    headFromChild && headPermission !== undefined
      ? `subagent @${subagents.children.get(headPermission.sessionId ?? "")?.agent ?? "subagent"}`
      : undefined;
  // esc routing while an ask is pending: questions (two-stage dismiss) and
  // the permission reject stage own esc; the permission choose stage leaves
  // it to the chat (focus clear, then interrupt arming — the abandon hatch).
  const escOwnedByPrompt =
    headQuestion !== undefined ||
    (headPermission !== undefined && (askUi?.stage ?? "choose") === "reject");

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

  // Tool-output nodes: every tool call is its own transcript node, and
  // non-task tools expand inline to their result content (task nodes open
  // the subagent dialog instead). Keyed `${messageId}:${callId}`.
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());

  // NORMAL-mode transcript focus: index into the flattened NODE list
  // (buildTranscriptItems — thought, each tool call, text, user message),
  // null = no focus. ctrl+j/ctrl+k step nodes; the focused node renders
  // highlighted; Enter/Space act on it (toggle thought/tool output, open
  // the subagent dialog).
  const [focus, setFocus] = useState<number | null>(null);

  // The flattened node list — one focusable/clickable item per renderable
  // piece. Rebuilt per render (cheap); identities are stable per content.
  const items = buildTranscriptItems(messages);

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
  // The first press focuses the last visible node (where you're looking);
  // further steps clamp at the ends and scroll BY ROWS to reveal the target.
  const lastVisibleItem = (): number => {
    const limit = scrollOffsetRef.current + Math.max(1, viewportHeight);
    for (let ii = items.length - 1; ii >= 0; ii--) {
      const pos = scrollRef.current?.getItemPosition(ii);
      if (pos !== null && pos !== undefined && pos.top < limit) return ii;
    }
    return Math.max(0, items.length - 1);
  };

  const revealItem = (index: number): void => {
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
    if (items.length === 0) return;
    const base = focus ?? lastVisibleItem();
    const next = moveFocus(base, items.length, down);
    setFocus(next);
    revealItem(next);
  };

  /** Toggle one tool node's inline output (non-task tools). */
  const toggleToolOutput = (key: string): void => {
    setExpandedTools((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  /** Toggle one message's thought node. */
  const toggleThought = (messageId: string): void => {
    setExpandedThinking((prev) => {
      const next = new Set(prev);
      if (next.has(messageId)) next.delete(messageId);
      else next.add(messageId);
      return next;
    });
  };

  /** The tracked child a tool item's task spawned (exact via title/link). */
  const resolveTaskChild = (item: Extract<TranscriptItem, { kind: "tool" }>): SubagentActivity | undefined => {
    if (item.call.name !== "task") return undefined;
    const message = messages[item.messageIndex];
    return findChildForTask(subagents.children, item.rawArgs, taskChildId(message, item.call.callId));
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
    if (askPending) return; // the prompt owns typing while it's up
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
      // Left press (release ignored — one click, one action): the item whose
      // measured block contains the clicked row acts — thought toggles, a
      // task opens the subagent dialog, any other tool toggles its inline
      // output. Positions are exact per node (each item is measured).
      if (button === 0 && mouse[4] === "M") {
        const row = Number(mouse[3]);
        for (let ii = 0; ii < items.length; ii++) {
          const pos = scrollRef.current?.getItemPosition(ii);
          if (pos === null || pos === undefined) continue;
          const gap = ii === 0 ? 0 : 1;
          const top = VIEWPORT_TOP_ROW + pos.top + gap - shownOffset;
          const bottom = VIEWPORT_TOP_ROW + pos.top + pos.height - shownOffset;
          if (row < top || row >= bottom) continue;
          const item = items[ii];
          if (item === undefined) return;
          if (item.kind === "thought") {
            toggleThought(item.messageId);
          } else if (item.kind === "tool") {
            if (item.call.name === "task") {
              onOpenSubagent(resolveTaskChild(item)?.sessionId);
            } else {
              toggleToolOutput(`${item.messageId}:${item.call.callId}`);
            }
          }
          return;
        }
      }
      return;
    }
    // pageUp/pageDown = half a viewport; ctrl+u/ctrl+d = a quarter (opencode).
    const pageRows = Math.max(1, Math.floor(viewportHeight / 2));
    const halfPageRows = Math.max(1, Math.floor(viewportHeight / 4));
    if (key.pageUp) return scrollBy(-pageRows);
    if (key.pageDown) return scrollBy(pageRows);

    // An ask is pending: the inline prompt (its own useInput) owns plain
    // keys, arrows, enter/space, and — for questions and the permission
    // reject stage — esc. The chat keeps mouse (above), paging, and
    // ctrl+u/d scroll; other ctrl chords fall through to App's globals
    // (session switching stays live mid-ask — the point of going inline).
    if (askPending) {
      if (key.escape && !escOwnedByPrompt) {
        // The chat's esc semantics: clear transcript focus first, then the
        // double-press interrupt (abandoning the blocked run answers the
        // ask the hard way — core fails the pending ask on stop).
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
      if (key.ctrl && ch === "u") return scrollBy(-halfPageRows);
      if (key.ctrl && ch === "d") return scrollBy(halfPageRows);
      return;
    }

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
        return; // remaining ctrl chords belong to App's globals handler
      }
      // ctrl+j's legacy spelling (lone "\n": ink parses the raw linefeed byte
      // as name:'enter' with ctrl=false, so it never reaches the ctrl branch
      // above). Typing is ignored in NORMAL mode, so a lone "\n" here is
      // unambiguously ctrl+j → focus traversal down.
      if (ch === "\n") return stepFocus(true);
      if (ch === "i" || ch === "a") return onEnterInput();
      // Enter/Space act on the focused NODE: thought toggles, a task opens
      // the subagent dialog, any other tool toggles its inline output;
      // Enter falls through to INPUT mode on user/text nodes.
      if (key.return || ch === " ") {
        const focusedItem = focus !== null ? items[focus] : undefined;
        if (focusedItem !== undefined) {
          if (focusedItem.kind === "thought") {
            toggleThought(focusedItem.messageId);
            return;
          }
          if (focusedItem.kind === "tool") {
            if (focusedItem.call.name === "task") {
              onOpenSubagent(resolveTaskChild(focusedItem)?.sessionId);
            } else {
              toggleToolOutput(`${focusedItem.messageId}:${focusedItem.call.callId}`);
            }
            return;
          }
        }
        if (key.return) return onEnterInput();
        return; // space on user/text: no-op
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

  const len = items.length;
  // Clamp for rendering: the measured content height can lag one commit behind
  // a scroll, and the follow callbacks re-sync the state.
  const shownOffset = Math.min(scrollOffset, bottomOffset);

  // Messages fully above the viewport top — the "↑ N earlier messages"
  // count (distinct messages among the clipped items). Skipped until the
  // first measurement lands (heights default to 0).
  let aboveCount = 0;
  if (len > 0 && contentHeight > 0) {
    const seen = new Set<number>();
    for (let ii = 0; ii < items.length; ii++) {
      const pos = scrollRef.current?.getItemPosition(ii);
      if (pos === null || pos === undefined) break;
      if (pos.top + pos.height <= shownOffset) {
        seen.add(items[ii]!.messageIndex);
      } else {
        break;
      }
    }
    aboveCount = seen.size;
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
          Item boxes carry flexShrink 0 so Yoga never compresses them.
          The transcript is a flat list of NODES (buildTranscriptItems): a
          user message, a thought, each tool call, and the reply text are
          each their own focusable/clickable/measured item — thought and
          task highlight independently, and every tool call can expand to
          its output. */}
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
        {items.map((item, ii) => {
          const m = messages[item.messageIndex];
          if (m === undefined) return null;
          const focused = focus === ii;
          // Per-item gap row (replaces the old container gap): rendered
          // INSIDE the measured item so measured positions stay exact.
          const gap = ii === 0 ? 0 : 1;
          const marker = focused ? <Text color="cyan">❯ </Text> : null;
          if (item.kind === "user") {
            return (
              <Box key={`${item.messageId}:user`} marginTop={gap} flexShrink={0}>
                <Box
                  borderStyle="round"
                  // Neutral white outline at rest; the cyan accent is reserved
                  // for the focus highlight so it stands out.
                  borderColor={focused ? "cyan" : "white"}
                  paddingX={1}
                  flexShrink={0}
                >
                  <Text wrap="wrap" bold={focused}>
                    {messageText(m)}
                  </Text>
                </Box>
              </Box>
            );
          }
          if (item.kind === "thought") {
            const thinking = thinkingText(m);
            const lineCount = thinking.split("\n").length;
            const expanded = expandedThinking.has(item.messageId);
            return (
              <Box key={`${item.messageId}:thought`} marginTop={gap} flexShrink={0}>
                <Box {...assistantInset} flexShrink={0}>
                  {expanded ? (
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
                      {marker}▸ thought ({lineCount} line
                      {lineCount === 1 ? "" : "s"})
                    </Text>
                  )}
                </Box>
              </Box>
            );
          }
          if (item.kind === "tool") {
            const c = item.call;
            // task: live status from the tracked child (asking/running beat
            // the transcript's result-less "running"); the dialog (click or
            // enter) shows the child's live transcript.
            if (c.name === "task") {
              const child = resolveTaskChild(item);
              const asking = child?.needsApproval === true;
              const live = c.result === undefined && (asking || child?.running === true);
              const status = live ? "running" : c.status;
              const glyph = asking ? "⚠" : status === "running" ? "◦" : status === "error" ? "✗" : "▸";
              const statusColor = asking ? "red" : status === "running" ? "yellow" : status === "error" ? "red" : "green";
              return (
                <Box key={`${item.messageId}:${c.callId}`} marginTop={gap} flexShrink={0}>
                  <Box {...assistantInset} flexShrink={0}>
                    <Text wrap="truncate">
                      {marker}
                      <Text color={focused ? "cyan" : statusColor}>
                        {status === "done" ? "" : `${glyph} `}
                      </Text>
                      <Text
                        color={focused ? "cyan" : (asking ? "red" : status === "running" ? "yellow" : status === "error" ? "red" : undefined)}
                        dimColor={!focused && status === "done"}
                      >
                        task {c.argsPreview}
                      </Text>
                      {asking && <Text color="red"> · needs approval</Text>}
                      {!asking && status === "running" && <Text dimColor> · working…</Text>}
                      {status === "error" && <Text color="red"> · failed</Text>}
                      {focused && status !== "running" && <Text dimColor> · enter to view</Text>}
                    </Text>
                  </Box>
                </Box>
              );
            }
            // Any other tool: its own node — click/enter toggles the inline
            // output (the tool_result content), thought-body style.
            const expanded = expandedTools.has(`${item.messageId}:${c.callId}`);
            const glyph = c.status === "running" ? "◦" : c.status === "error" ? "✗" : "✓";
            const color = c.status === "running" ? "yellow" : c.status === "error" ? "red" : "green";
            return (
              <Box key={`${item.messageId}:${c.callId}`} marginTop={gap} flexShrink={0}>
                <Box {...assistantInset} flexDirection="column" flexShrink={0}>
                  <Text wrap="truncate">
                    {marker}
                    <Text color={focused ? "cyan" : color}>{glyph} </Text>
                    <Text color={focused ? "cyan" : undefined} dimColor={!focused}>
                      {c.name}
                    </Text>
                    {c.argsPreview.length > 0 && <Text> {c.argsPreview}</Text>}
                    {c.result !== undefined && c.result.isError && <Text color="red"> · denied/failed</Text>}
                    {c.result !== undefined && focused && (
                      <Text dimColor> · enter to {expanded ? "hide" : "view"} output</Text>
                    )}
                  </Text>
                  {expanded && c.result !== undefined && (
                    <Box flexDirection="column" paddingLeft={2}>
                      {c.result.content.split("\n").map((line, li) => (
                        <Text key={li} dimColor wrap="wrap">
                          {line.length > 0 ? line : " "}
                        </Text>
                      ))}
                    </Box>
                  )}
                </Box>
              </Box>
            );
          }
          // text: the reply body — its own node; the ❯ marker marks focus.
          return (
            <Box key={`${item.messageId}:text`} marginTop={gap} flexShrink={0}>
              <Box {...assistantInset} flexShrink={0}>
                <Text wrap="wrap">
                  {marker}
                  {messageText(m)}
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
          there. While an ask is pending the composer is REPLACED by the
          inline prompt (opencode's placement): the prompt takes this slot,
          the transcript keeps scrolling, and typing is inert — the App
          forces NORMAL so no stale INPUT state lingers. */}
      {headPermission !== undefined ? (
        <PermissionPrompt
          client={client}
          request={headPermission}
          context={childContext}
          ui={askUi ?? emptyAskUi()}
          onUi={setAskUi ?? (() => {})}
          queued={askQueued}
          onDone={headFromChild ? (onChildAskDone ?? (() => {})) : (onPermissionDone ?? (() => {}))}
        />
      ) : headQuestion !== undefined ? (
        <QuestionPrompt
          client={client}
          request={headQuestion}
          ui={askUi ?? emptyAskUi()}
          onUi={setAskUi ?? (() => {})}
          queued={askQueued}
          onDone={onQuestionDone ?? (() => {})}
        />
      ) : (
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
      )}
    </Box>
  );
}

/**
 * The child session a task call produced — from its paired tool_result
 * payload's `subagent` link (core persists it on completion). Undefined
 * while the task is still running; the dialog then focuses the first
 * running/asking child instead.
 */
function taskChildId(message: Message | undefined, callId: string): string | undefined {
  if (message === undefined) return undefined;
  for (const p of message.parts) {
    if (p.kind !== "tool_result") continue;
    const payload = p.payload as { callId?: string; subagent?: { sessionId?: unknown } } | null;
    if (payload?.callId !== callId) continue;
    const sessionId = payload.subagent?.sessionId;
    return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : undefined;
  }
  return undefined;
}
