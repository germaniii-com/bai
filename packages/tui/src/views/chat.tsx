import { Box, Text, useInput, usePaste, useStdout, useWindowSize } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import { ScrollView, type ScrollViewRef } from "../components/scroll-view";
import { SelectDialog } from "../components/dialog";
import type { BaiClient } from "@bai/api/client";
import type { Input, Message, PermissionRequest, QuestionRequest, Session, SessionUsage } from "@bai/shared";
import { contextTracker } from "@bai/shared";
import type { Mode } from "../app";
import { buildTranscriptItems, messageText, revertBoundary, thinkingText, type TranscriptItem } from "../state/sync";
import type { PickerOption } from "../state/providers";
import { emptySubagentState, findChildForTask, type SubagentActivity, type SubagentState } from "../state/subagents";
import { emptyAskUi, type AskUiState } from "../state/asks";
import { Spinner } from "../components/spinner";
import { Markdown } from "../components/markdown";
import { ComposerHub } from "../components/composer";
import { layoutHubStatus } from "../state/hub";
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
import { useTheme } from "../theme";

/** SGR mouse buttons for the wheel (X10 button codes + 1000h tracking). */
const WHEEL_UP = 64;
const WHEEL_DOWN = 65;
/** Terminal rows per mouse-wheel tick (opencode's default scroll speed). */
const WHEEL_ROWS = 3;
/** No header — the composer hub owns the context — so the chat viewport
 *  always starts at terminal row 1 (1-based), the anchor for click
 *  hit-testing. Chip hit-testing is bottom-anchored instead (see the mouse
 *  handler): the hub sits at a fixed offset above the App footer. */
const VIEWPORT_TOP_ROW = 1;

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
  modelLabel,
  agent,
  footerRows,
  usage = null,
  workspaceRoot,
  deferInput = false,
  onEnterInput,
  onExitInput,
  onSessionCreated,
  onOpenSubagent,
  onOpenModels,
  onOpenAgents,
  onOpenSessions,
  subagents = emptySubagentState,
  pendingAsks = [],
  pendingChildAsks = [],
  pendingQuestions = [],
  askUi,
  setAskUi,
  onPermissionDone,
  onChildAskDone,
  onQuestionDone,
  onForkCreated,
  composerSeed,
  onComposerSeedConsumed,
  queuedInputs = [],
  sendingIds = [],
  onSendQueued,
  onCancelQueued,
  onEditQueued,
}: {
  client: BaiClient;
  session: Session | null;
  messages: Message[];
  /** True while the coordinator is draining this session (run.started → run.finished). */
  runActive: boolean;
  /** Input mode owned by App: NORMAL (vim motions) vs INPUT (typing). */
  mode: Mode;
  /** Effective model label (App-computed via currentModelLabel) — the hub's model chip. */
  modelLabel: string;
  /** Effective agent name (session pin → config default → build) — the hub's agent chip. */
  agent: string;
  /** Rows the App footer renders below this view — anchors the hub chip hit-testing. */
  footerRows: number;
  /** The session's latest provider-reported usage — the hub's context tracker. */
  usage?: SessionUsage | null;
  /**
   * The launch folder (registered as a workspace at boot; TUI = workspace
   * mode) — new sessions root here so they group under the workspace in
   * the webui. Undefined → cwd-less chat sessions (tests, embeds).
   */
  workspaceRoot?: string;
  /** True while an App-level overlay dialog is open: this view stays mounted
   *  (the transcript keeps streaming behind the dialog) but must go silent —
   *  Ink delivers input to every mounted handler, so keys/mouse/paste would
   *  double-handle. */
  deferInput?: boolean;
  /** Switch to INPUT mode (i/a/Enter in NORMAL; paste implies typing). */
  onEnterInput: () => void;
  /** Back to NORMAL (esc in INPUT). */
  onExitInput: () => void;
  onSessionCreated: (session: Session) => void;
  /** Open the model picker dialog (the palette's Switch model) — hub model chip. */
  onOpenModels: () => void;
  /** Open the agent manager dialog (the palette's Switch agent) — hub agent chip. */
  onOpenAgents: () => void;
  /** Open the session picker dialog (the palette's Switch session) — hub workspace/session chip. */
  onOpenSessions: () => void;
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
  /**
   * A fork just landed: App navigates to the new session and remembers the
   * seed; the forked message's text goes into the new session's composer.
   */
  onForkCreated?: (session: Session, seedText: string) => void;
  /** App-held composer seed (fork flow) — applied once the session is active. */
  composerSeed?: { sessionId: string; text: string } | null;
  /** Clears the seed after it has been applied (never re-applied on revisit). */
  onComposerSeedConsumed?: () => void;
  // ---- queued messages (message-queue feature) ---------------------------
  /** Pending queued inputs of the active session (admitted, not yet promoted). */
  queuedInputs?: Input[];
  /** Ids flipped to steer by send-now — rendered in place as "sending…" until promoted. */
  sendingIds?: string[];
  /** Send now: flip the queued input to steer (promotes at the next safe boundary). */
  onSendQueued?: (input: Input) => void;
  /** Cancel: drop the queued input — it never runs. */
  onCancelQueued?: (input: Input) => void;
  /** Edit: cancel the queued input and reseed the composer with its text. */
  onEditQueued?: (input: Input) => void;
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
  // individually by clicking its row (or enter/space on the focused node).
  // The state persists after the run and across session revisits; only the
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
  // the subagent dialog, open the message-actions modal on user messages).
  const [focus, setFocus] = useState<number | null>(null);
  const t = useTheme();

  // ---- message actions + two-phase revert (opencode parity) -------------
  // The message-actions modal (Enter/Space on a focused user message):
  // Revert / Copy / Fork / Restore. Like the inline ask prompts it takes
  // the composer hub's slot and owns the keyboard while open.
  const [msgActions, setMsgActions] = useState<{ messageId: string } | null>(null);

  // ---- queued-message actions (message-queue feature) --------------------
  // The queued-actions modal (Enter/Space on a focused queued node, or a
  // click): Send now / Edit / Cancel. Same hub-slot + keyboard-ownership
  // pattern as the message-actions modal.
  const [queuedActions, setQueuedActions] = useState<{ inputId: string } | null>(null);
  const queuedActionsInput =
    queuedActions !== null ? queuedInputs.find((i) => i.id === queuedActions.inputId) : undefined;

  // Two-phase revert display: everything at/after the boundary disappears
  // and a banner at the cut offers the restore. Items and the render loop
  // below index against the VISIBLE slice (messageIndex stays consistent).
  const revertId = revertBoundary(session);
  const boundaryIdx = revertId === undefined ? -1 : messages.findIndex((m) => m.id === revertId);
  const visibleMessages = boundaryIdx < 0 ? messages : messages.slice(0, boundaryIdx);
  const revertedCount = boundaryIdx < 0 ? 0 : messages.length - boundaryIdx;

  // The flattened node list — one focusable/clickable item per renderable
  // piece. Rebuilt per render (cheap); identities are stable per content.
  const items = buildTranscriptItems(visibleMessages);

  // Queued nodes (message-queue feature): pending inputs render at the
  // transcript tail as focusable/clickable items — future messages, dimmed
  // with a queued chip. Send-now flips re-chip their node "sending…" IN
  // PLACE (no vanish-then-reshow gap) until promotion; sending nodes don't
  // open the actions dialog.
  const sending = new Set(sendingIds);
  const queuedItems: Array<{ kind: "queued-input"; input: Input; sending: boolean }> = queuedInputs.map(
    (input) => ({ kind: "queued-input" as const, input, sending: sending.has(input.id) }),
  );

  // The banner marking the pending-revert cut is itself focusable/clickable
  // (enter restores) — critical when the revert hid EVERY user message and
  // the dialog is otherwise unreachable.
  const focusItems: Array<
    TranscriptItem | { kind: "revert-banner" } | { kind: "queued-input"; input: Input; sending: boolean }
  > = [...(revertedCount > 0 ? [...items, { kind: "revert-banner" as const }] : items), ...queuedItems];

  // App-seeded composer text (fork flow): when the freshly forked session
  // becomes active, its message's prompt text lands in the composer once.
  useEffect(() => {
    if (composerSeed === undefined || composerSeed === null) return;
    if (composerSeed.sessionId !== session?.id) return;
    setEditor({ text: composerSeed.text, cursor: composerSeed.text.length });
    onComposerSeedConsumed?.();
  }, [composerSeed, session?.id, onComposerSeedConsumed]);

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
  // any open message-actions modal dismissed with it, history traversal
  // back to the live-draft boundary (history itself is global and survives
  // the switch).
  useEffect(() => {
    followRef.current = true;
    pendingBottomRef.current = true;
    setScrollOffset(0);
    setSentPending(false);
    setFocus(null);
    setMsgActions(null);
    setQueuedActions(null);
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
    // Message-queue default (Cursor-style): a submit while the session is
    // draining QUEUES instead of steering — the queued node (fed by the
    // input.admitted event) is the feedback, so the thinking dots stay off.
    const queuing = session !== null && runActive;
    try {
      if (session === null) {
        // The server titles the session (truncated-prompt fallback, then an
        // LLM refine) from this first prompt — core/src/title.ts. TUI
        // sessions root at the launch folder (workspace mode) so they group
        // under that workspace in the webui.
        const created = await client.createSession({
          workbench: "chat",
          ...(workspaceRoot !== undefined ? { cwd: workspaceRoot } : {}),
        });
        onSessionCreated(created);
        await client.submitPrompt(created.id, { text: trimmed });
      } else {
        await client.submitPrompt(session.id, { text: trimmed, ...(queuing ? { queue: true } : {}) });
      }
      recordPrompt(trimmed);
      setEditor((e) =>
        e.text === value ? { text: nextDraft, cursor: nextDraft.length } : e,
      );
      if (!queuing) setSentPending(true); // dots until the run's first token (or run.finished)
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
    for (let ii = focusItems.length - 1; ii >= 0; ii--) {
      const pos = scrollRef.current?.getItemPosition(ii);
      if (pos !== null && pos !== undefined && pos.top < limit) return ii;
    }
    return Math.max(0, focusItems.length - 1);
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
    if (focusItems.length === 0) return;
    const base = focus ?? lastVisibleItem();
    const next = moveFocus(base, focusItems.length, down);
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
    const message = visibleMessages[item.messageIndex];
    return findChildForTask(subagents.children, item.rawArgs, taskChildId(message, item.call.callId));
  };

  // ---- message actions (opencode's DialogMessage parity) -----------------
  /** The message the modal is open for — looked up from the FULL history:
      the revert boundary itself is hidden from the transcript but still known. */
  const msgActionsMessage = msgActions !== null ? messages.find((m) => m.id === msgActions.messageId) : undefined;

  /**
   * Run a revert-family mutation, absorbing the post-interrupt busy window:
   * the abort unwinds asynchronously, so the first request can still meet a
   * 409 — retry briefly. Errors stay silent (submitText's precedent; the
   * session.updated stream carries the outcome either way).
   */
  const runWithBusyRetry = async (fn: () => Promise<void>): Promise<void> => {
    for (let attempt = 0; ; attempt++) {
      try {
        await fn();
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (attempt < 4 && message.includes("busy")) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          continue;
        }
        return;
      }
    }
  };

  const actionRevert = (message: Message): void => {
    if (session === null) return;
    setMsgActions(null);
    if (runActive) void client.interrupt(session.id);
    void runWithBusyRetry(async () => {
      await client.revertSession(session.id, message.id);
      // The reverted prompt returns to the composer, ready to edit & resend
      // (opencode's setPrompt round-trip; local — no remount in between).
      const text = messageText(message);
      setEditor({ text, cursor: text.length });
    });
  };

  const actionRestore = (): void => {
    if (session === null) return;
    setMsgActions(null);
    void runWithBusyRetry(async () => {
      await client.unrevertSession(session.id);
    });
  };

  const actionFork = (message: Message): void => {
    if (session === null) return;
    setMsgActions(null);
    if (runActive) void client.interrupt(session.id);
    void runWithBusyRetry(async () => {
      const forked = await client.forkSession(session.id, message.id);
      // The fork excludes the message itself — its text seeds the new
      // session's composer via the App-level seed (ChatView remounts on the
      // switch, so the seed applies after remount, not here).
      onForkCreated?.(forked, messageText(message));
    });
  };

  const actionCopy = (message: Message): void => {
    setMsgActions(null);
    // OSC 52 — the terminal clipboard escape: honored locally and over SSH
    // by most modern terminals, with no subprocess dependency.
    const encoded = Buffer.from(messageText(message), "utf8").toString("base64");
    stdout.write(`\x1b]52;c;${encoded}\x07`);
  };

  // ---- queued-message actions (message-queue feature) --------------------
  const actionSendQueued = (input: Input): void => {
    setQueuedActions(null);
    onSendQueued?.(input);
  };

  const actionCancelQueued = (input: Input): void => {
    setQueuedActions(null);
    onCancelQueued?.(input);
  };

  const actionEditQueued = (input: Input): void => {
    setQueuedActions(null);
    // The App-level handler cancels the input and seeds the composer via
    // the App-held seed (applied on the next render, fork-flow parity).
    onEditQueued?.(input);
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
    if (askPending || deferInput) return; // the prompt owns typing while it's up; overlays own everything
    onEnterInput();
    setEditor((e) => insert(e, sanitize(pasted)));
  });

  useInput(
    (ch, key) => {
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
      // Left press (release ignored — one click, one action): first the
      // composer hub's chips, then the transcript items. Hub chips are
      // BOTTOM-anchored (input wrapping above them is variable, but the
      // status row sits at a fixed offset above the App footer), while
      // transcript items are top-anchored (VIEWPORT_TOP_ROW). Only live
      // when the hub itself is on screen — a pending ask swaps the prompt
      // into the hub's slot.
      if (button === 0 && mouse[4] === "M") {
        const row = Number(mouse[3]);
        if (!askPending && msgActions === null && rows > 3 && row === rows - footerRows - 2) {
          // 1-based screen column → 0-based inner content column: border
          // (1) + paddingX (1) each side.
          const col = Number(mouse[2]) - 3;
          const chip = hubLayout.chips.find((c) => col >= c.start && col < c.end);
          if (chip !== undefined) {
            if (chip.kind === "agent") return onOpenAgents();
            if (chip.kind === "model") return onOpenModels();
            return onOpenSessions();
          }
          return;
        }
        // The item whose measured block contains the clicked row acts —
        // thought toggles, a task opens the subagent dialog, any other tool
        // toggles its inline output. Positions are exact per node (each
        // item is measured).
        for (let ii = 0; ii < focusItems.length; ii++) {
          const pos = scrollRef.current?.getItemPosition(ii);
          if (pos === null || pos === undefined) continue;
          const gap = ii === 0 ? 0 : 1;
          const top = VIEWPORT_TOP_ROW + pos.top + gap - shownOffset;
          const bottom = VIEWPORT_TOP_ROW + pos.top + pos.height - shownOffset;
          if (row < top || row >= bottom) continue;
          const item = focusItems[ii];
          if (item === undefined) return;
          if (item.kind === "revert-banner") {
            actionRestore();
          } else if (item.kind === "thought") {
            toggleThought(item.messageId);
          } else if (item.kind === "tool") {
            if (item.call.name === "task") {
              onOpenSubagent(resolveTaskChild(item)?.sessionId);
            } else {
              toggleToolOutput(`${item.messageId}:${item.call.callId}`);
            }
          } else if (item.kind === "queued-input") {
            // Sending nodes are in flight — no actions to offer.
            if (!item.sending) setQueuedActions({ inputId: item.input.id });
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

    // The message-actions / queued-actions dialogs own the keyboard (their
    // own useInput handles arrows/enter/esc/filter): everything defers
    // except scrolling.
    if (msgActions !== null || queuedActions !== null) {
      if (key.ctrl && ch === "u") return scrollBy(-halfPageRows);
      if (key.ctrl && ch === "d") return scrollBy(halfPageRows);
      return;
    }

    // An ask is pending: the inline prompt (its own useInput) owns plain
    // keys, arrows, enter/space, and — for questions and the permission
    // reject stage — esc. The chat keeps mouse (above), paging, and
     // ctrl+u/d scroll; other ctrl chords fall through to App's globals
     // (the supermenu stays reachable mid-ask — the point of going inline).
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
      // NORMAL: vim motions + ctrl chords. Plain typing is
      // ignored — only single-char mode entries count (batched chunks are
      // rapid-typing artifacts that belong to INPUT).
      if (key.ctrl) {
        if (ch === "u") return scrollBy(-halfPageRows);
        if (ch === "d") return scrollBy(halfPageRows);
        // ctrl+j/ctrl+k: transcript focus traversal (the accent highlight) —
        // steps message-by-message and scrolls by rows to reveal the target.
        if (ch === "j") return stepFocus(true);
        if (ch === "k") return stepFocus(false);
        // Editing chords stay live in both modes (the draft persists).
        if (ch === "w") return setEditor(deleteWordBefore);
        return; // remaining ctrl chords belong to App's globals handler
      }
      // ctrl+j's legacy spelling (lone "\n": ink parses the raw linefeed byte
      // as name:'enter' with ctrl=false, so it never reaches the ctrl branch
      // above). Typing is ignored in NORMAL mode, so a lone "\n" here is
      // unambiguously ctrl+j → focus traversal down.
      if (ch === "\n") return stepFocus(true);
      if (ch === "i" || ch === "a") {
        // Entering INPUT resets the transcript to the tail: a stale focus or
        // a scrolled-up reading position must not hide the growing queued
        // tail while typing (new nodes land at the bottom).
        setFocus(null);
        scrollTo(scrollRef.current?.getBottomOffset() ?? bottomOffset);
        return onEnterInput();
      }
      // Enter/Space act on the focused NODE: thought toggles, a task opens
      // the subagent dialog, a user message opens the message-actions modal
      // (revert/copy/fork/restore), the revert banner restores, any other
      // tool toggles its inline output.
      if (key.return || ch === " ") {
        const focusedItem = focus !== null ? focusItems[focus] : undefined;
        if (focusedItem !== undefined) {
          if (focusedItem.kind === "revert-banner") {
            actionRestore();
            return;
          }
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
          if (focusedItem.kind === "user") {
            setMsgActions({ messageId: focusedItem.messageId });
            return;
          }
          if (focusedItem.kind === "queued-input") {
            // Sending nodes are in flight — no actions to offer.
            if (!focusedItem.sending) setQueuedActions({ inputId: focusedItem.input.id });
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
  },
    // Deferred while an App-level overlay dialog is open: the view stays
    // mounted behind it, and Ink would deliver every key/mouse event twice.
    { isActive: !deferInput },
  );

  const len = focusItems.length;
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

  // Composer hub status row: pure column math over the inner width (the
  // composer box spans the padded body; border + paddingX eat 4 columns).
  // Recomputed per render — cheap, and it must track mode/session/labels.
  const hubLayout = layoutHubStatus({
    width: Math.max(8, columns - 4),
    session,
    mode,
    agent,
    model: modelLabel,
  });

  // Context tracker readout (shared/src/display.ts): `45.2k (23%)` with the
  // pi thresholds — undefined until the session's first usage lands.
  const tracker = contextTracker(usage);

  // Message-actions options: Restore leads when a revert is pending (the
  // dialog is reachable on any user message — the boundary itself is hidden).
  const messageActionOptions: PickerOption[] = [
    ...(revertId !== undefined
      ? [{ value: "restore", label: "Restore reverted messages", hint: "bring back the hidden messages" }]
      : []),
    { value: "revert", label: "Revert to here", hint: "undo this message + everything after" },
    { value: "copy", label: "Copy", hint: "message text to clipboard" },
    { value: "fork", label: "Fork from here", hint: "new session with the earlier history" },
  ];

  // Queued-message options (message-queue feature): send now / edit / cancel.
  const queuedActionOptions: PickerOption[] = [
    { value: "send", label: "Send now", hint: "promote immediately — the next provider turn" },
    { value: "edit", label: "Edit", hint: "cancel and put the text back in the composer" },
    { value: "cancel", label: "Cancel queue", hint: "drop it — it never runs" },
  ];

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
        {focusItems.map((item, ii) => {
          // Per-item gap row (replaces the old container gap): rendered
          // INSIDE the measured item so measured positions stay exact.
          const gap = ii === 0 ? 0 : 1;
          const focused = focus === ii;
          if (item.kind === "revert-banner") {
            // The pending-revert cut: a banner where the hidden messages
            // were (opencode's reverted banner). Focus/click → restore.
            return (
              <Box key="revert-banner" marginTop={gap} flexShrink={0} {...assistantInset}>
                <Text color={focused ? t.accent : t.dim}>
                  {focused ? "❯ " : "  "}↩ {revertedCount} message{revertedCount === 1 ? "" : "s"} reverted — enter
                  to restore
                </Text>
              </Box>
            );
          }
          if (item.kind === "queued-input") {
            // Queued nodes (message-queue feature): pending inputs at the
            // transcript tail — future messages, dimmed with a queued chip
            // ("sending…" once send-now flipped them, accent-tinted).
            return (
              <Box key={`queued:${item.input.id}`} marginTop={gap} flexShrink={0}>
                <Box
                  borderStyle="round"
                  // Dim border at rest; the accent is reserved for the
                  // focus highlight (user-bubble parity).
                  borderColor={focused ? t.accent : t.border}
                  borderBackgroundColor={t.background}
                  paddingX={1}
                  flexShrink={0}
                >
                  <Text wrap="wrap" color={t.dim}>
                    {item.input.payload.text}
                    {item.sending ? (
                      <Text color={t.success}> · ⏳ sending…</Text>
                    ) : (
                      <Text color={t.warning}> · ⏳ queued</Text>
                    )}
                  </Text>
                </Box>
              </Box>
            );
          }
          const m = visibleMessages[item.messageIndex];
          if (m === undefined) return null;
          const marker = focused ? <Text color={t.accent}>❯ </Text> : null;
          if (item.kind === "user") {
            return (
              <Box key={`${item.messageId}:user`} marginTop={gap} flexShrink={0}>
                <Box
                  borderStyle="round"
                  // Neutral outline at rest; the accent is reserved for the
                  // focus highlight so it stands out.
                  borderColor={focused ? t.accent : t.border}
                  borderBackgroundColor={t.background}
                  paddingX={1}
                  flexShrink={0}
                >
                  <Text wrap="wrap" color={t.text} bold={focused}>
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
                      <Text color={t.dim}>
                        {marker}── thought ──
                      </Text>
                      {/* Thinking renders markdown too, dimmed overall. */}
                      <Markdown text={thinking} dim />
                    </Box>
                  ) : (
                    <Text color={focused ? t.accent : t.dim}>
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
              const statusColor = asking ? t.danger : status === "running" ? t.warning : status === "error" ? t.danger : t.success;
              return (
                <Box key={`${item.messageId}:${c.callId}`} marginTop={gap} flexShrink={0}>
                  <Box {...assistantInset} flexShrink={0}>
                    <Text wrap="truncate">
                      {marker}
                      <Text color={focused ? t.accent : statusColor}>
                        {status === "done" ? "" : `${glyph} `}
                      </Text>
                      <Text
                        color={focused ? t.accent : (asking ? t.danger : status === "running" ? t.warning : status === "error" ? t.danger : t.dim)}
                      >
                        task {c.argsPreview}
                      </Text>
                      {asking && <Text color={t.danger}> · needs approval</Text>}
                      {!asking && status === "running" && <Text color={t.dim}> · working…</Text>}
                      {status === "error" && <Text color={t.danger}> · failed</Text>}
                      {focused && status !== "running" && <Text color={t.dim}> · enter to view</Text>}
                    </Text>
                  </Box>
                </Box>
              );
            }
            // Any other tool: its own node — click/enter toggles the inline
            // output (the tool_result content), thought-body style. An
            // answered permission ask is retained on the result: the row
            // carries the verdict, expanding reviews the ask (summary +
            // diff) that was approved/refused — history-backed, survives
            // reloads (task-node parity for the ask UX).
            const expanded = expandedTools.has(`${item.messageId}:${c.callId}`);
            const glyph = c.status === "running" ? "◦" : c.status === "error" ? "✗" : "✓";
            const color = c.status === "running" ? t.warning : c.status === "error" ? t.danger : t.success;
            const perm = c.permission;
            const permVerdict =
              perm === undefined
                ? undefined
                : perm.status === "approved"
                  ? `allowed (${perm.scope})`
                  : perm.message !== undefined
                    ? `rejected — "${perm.message}"`
                    : "rejected";
            return (
              <Box key={`${item.messageId}:${c.callId}`} marginTop={gap} flexShrink={0}>
                <Box {...assistantInset} flexDirection="column" flexShrink={0}>
                  <Text wrap="truncate">
                    {marker}
                    <Text color={focused ? t.accent : color}>{glyph} </Text>
                    <Text color={focused ? t.accent : t.text}>
                      {c.name}
                    </Text>
                    {c.argsPreview.length > 0 && <Text color={t.text}> {c.argsPreview}</Text>}
                    {permVerdict !== undefined && <Text color={t.dim}> · {permVerdict}</Text>}
                    {c.result !== undefined && c.result.isError && <Text color={t.danger}> · denied/failed</Text>}
                    {c.result !== undefined && focused && (
                      <Text color={t.dim}> · enter to {expanded ? "hide" : "view"} output</Text>
                    )}
                  </Text>
                  {expanded && perm !== undefined && (
                    <Box flexDirection="column" paddingLeft={2} marginBottom={perm.detail?.diff !== undefined ? 1 : 0}>
                      {perm.detail?.summary !== undefined && (
                        <Text color={t.dim} wrap="wrap">
                          ask: {perm.detail.summary}
                        </Text>
                      )}
                      {perm.detail?.diff !== undefined &&
                        perm.detail.diff.split("\n").map((line, li) => (
                          <Text key={li} color={t.dim} wrap="truncate">
                            {line}
                          </Text>
                        ))}
                    </Box>
                  )}
                  {expanded && c.questions !== undefined && c.result !== undefined ? (
                    // Retained Q&A review (question tool): pretty per-row
                    // question → answer instead of the model-facing sentence.
                    <Box flexDirection="column" paddingLeft={2}>
                      {c.questions.map((qa, i) => (
                        <Box key={i} flexDirection="column" marginBottom={1}>
                          <Text color={t.dim} wrap="wrap">
                            {qa.header !== undefined ? `[${qa.header}] ` : ""}
                            {qa.question}
                          </Text>
                          {qa.answers.length > 0 ? (
                            qa.answers.map((a, ai) => (
                              <Text key={ai} color={t.success} wrap="wrap">
                                ✓ {a}
                              </Text>
                            ))
                          ) : (
                            <Text color={t.dim} italic>· unanswered</Text>
                          )}
                        </Box>
                      ))}
                    </Box>
                  ) : (
                    expanded &&
                    c.result !== undefined && (
                      <Box flexDirection="column" paddingLeft={2}>
                        {c.result.content.split("\n").map((line, li) => (
                          <Text key={li} color={t.dim} wrap="wrap">
                            {line.length > 0 ? line : " "}
                          </Text>
                        ))}
                      </Box>
                    )
                  )}
                </Box>
              </Box>
            );
          }
          // text: the reply body — its own node; the ❯ marker marks focus.
          // Assistant replies render as markdown (components/markdown.tsx);
          // the marker hangs as a column so wrapped lines align under it.
          return (
            <Box key={`${item.messageId}:text`} marginTop={gap} flexShrink={0}>
              <Box {...assistantInset} flexShrink={0}>
                <Markdown text={messageText(m)} marker={marker ?? undefined} />
              </Box>
            </Box>
          );
        })}
        {len === 0 && !waiting && (
          <Box {...assistantInset}>
            <Text color={t.dim}>No messages yet — say something.</Text>
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
          <Text color={t.dim}>
            ↑ {aboveCount} earlier message{aboveCount === 1 ? "" : "s"} · mouse
            wheel / pageUp-pageDown to scroll · ctrl+j/k to focus
          </Text>
        </Box>
      )}

      {/* The composer HUB — the centralized surface (no header above):
          row 1 the draft (INPUT keeps the green border and › prompt, ▌ at
          the cursor), row 2 the status row (contextual session/workspace
          label left; mode badge + clickable agent/model chips right), row 3
          the commands row (the old footer hints, mode-dependent). Chips are
          click-routed by the mouse handler above (bottom-anchored math).
          While an ask is pending the hub is REPLACED by the inline prompt
          (opencode's placement): the prompt takes this slot, the transcript
          keeps scrolling, and typing is inert — the App forces NORMAL so no
          stale INPUT state lingers. */}
      {msgActions !== null ? (
        // The message-actions modal (opencode's DialogMessage): takes the
        // composer hub's slot like the inline ask prompts; its own useInput
        // owns arrows/enter/esc/filter while the chat defers. Deferred too
        // while an App-level overlay is open (both would hear every key).
        <SelectDialog
          title="Message Actions"
          options={messageActionOptions}
          deferInput={deferInput}
          onPick={(value) => {
            const message = msgActionsMessage;
            if (message === undefined) return setMsgActions(null);
            if (value === "revert") actionRevert(message);
            else if (value === "copy") actionCopy(message);
            else if (value === "fork") actionFork(message);
            else if (value === "restore") actionRestore();
            else setMsgActions(null);
          }}
          onClose={() => setMsgActions(null)}
          emptyHint="no actions"
        />
      ) : queuedActions !== null ? (
        // The queued-actions modal (message-queue feature): same hub-slot
        // pattern — Send now / Edit / Cancel on the selected queued node.
        <SelectDialog
          title="Queued Message"
          options={queuedActionOptions}
          deferInput={deferInput}
          onPick={(value) => {
            const input = queuedActionsInput;
            if (input === undefined) return setQueuedActions(null);
            if (value === "send") actionSendQueued(input);
            else if (value === "edit") actionEditQueued(input);
            else if (value === "cancel") actionCancelQueued(input);
            else setQueuedActions(null);
          }}
          onClose={() => setQueuedActions(null)}
          emptyHint="no actions"
        />
      ) : headPermission !== undefined ? (
        <PermissionPrompt
          key={String(headPermission.id)} // fresh instance per ask: local latches (busy) must not outlive their request
          client={client}
          request={headPermission}
          context={childContext}
          ui={askUi ?? emptyAskUi()}
          onUi={setAskUi ?? (() => {})}
          queued={askQueued}
          deferInput={deferInput}
          onDone={headFromChild ? (onChildAskDone ?? (() => {})) : (onPermissionDone ?? (() => {}))}
        />
      ) : headQuestion !== undefined ? (
        <QuestionPrompt
          key={String(headQuestion.id)} // fresh instance per ask (same latch concern)
          client={client}
          request={headQuestion}
          ui={askUi ?? emptyAskUi()}
          onUi={setAskUi ?? (() => {})}
          queued={askQueued}
          deferInput={deferInput}
          onDone={onQuestionDone ?? (() => {})}
        />
      ) : (
        <ComposerHub
          editor={editor}
          mode={mode}
          busy={busy}
          escArmed={escArmed}
          runActive={runActive}
          layout={hubLayout}
          queuedCount={queuedInputs.length - sendingIds.length}
          context={tracker}
        />
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
