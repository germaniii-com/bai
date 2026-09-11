import { Box, Text, useInput, useStdout, useWindowSize } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import { followSession, type BaiClient } from "@bai/api/client";
import type { Message, PermissionRequest } from "@bai/shared";
import { ScrollView, type ScrollViewRef } from "../components/scroll-view";
import { PermissionDialog } from "./permission-dialog";
import { applyDeltaBatch, applyEvent, buildTranscriptItems, createDeltaBuffer, messageText } from "../state/sync";
import { moveFocus } from "../state/focus";
import type { SubagentActivity } from "../state/subagents";
import { Markdown } from "../components/markdown";
import { ToolOutputBody } from "../components/tool-output";
import { useTheme } from "../theme";

/** Pending-ask poll cadence while the child runs (transcript itself streams). */
const REFRESH_MS = 1500;
/** Transcript window (main-chat parity). */
const CHILD_HISTORY_LIMIT = 100;
/** Wheel rows per tick (matches the chat view). */
const WHEEL_UP = 64;
const WHEEL_DOWN = 65;
const WHEEL_ROWS = 3;

/**
 * Subagent output dialog (opencode's subagent inspector): the child's full
 * transcript as NODES (buildTranscriptItems — same structure as the main
 * chat view), live-refreshing while the child works. ctrl+j/k traverses the
 * nodes; space/enter expands a thought or a tool call's output (so failed
 * tool calls show their error text); ←/→ cycles subagents; ↑ exits at the
 * top of the scroll; esc always exits. A pending permission ask reviews
 * inline (the dialog is the review surface — subagents are not in the
 * session picker).
 */
export function SubagentDialog({
  client,
  children,
  index,
  onNavigate,
  onExit,
}: {
  client: BaiClient;
  /** The parent's tracked subagents (asks-first order — state/subagents.ts). */
  children: SubagentActivity[];
  /** Which child is shown. */
  index: number;
  /** ←/→: the caller applies the wrap-around cycle to `delta` (-1 | +1). */
  onNavigate: (delta: number) => void;
  /** ↑ at the top, or esc. */
  onExit: () => void;
}) {
  const current = children[index];
  const [messages, setMessages] = useState<Message[]>([]);
  const [pendingAsk, setPendingAsk] = useState<PermissionRequest | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const t = useTheme();

  // ---- transcript: windowed snapshot + live durable stream ----------------
  // (replaces the old full-snapshot poll every 1.5s — the stream carries
  // deltas, so a long child transcript no longer re-downloads + re-renders).
  useEffect(() => {
    if (current === undefined) return;
    const ctrl = new AbortController();
    setLoadError(null);
    setMessages([]);
    setHistoryHasMore(false);
    setHistoryCursor(null);
    void (async () => {
      try {
        const snap = await client.historySnapshot(current.sessionId, { limit: CHILD_HISTORY_LIMIT });
        if (ctrl.signal.aborted) return;
        setMessages(snap.messages);
        setHistoryHasMore(snap.hasMore === true);
        setHistoryCursor(snap.nextCursor ?? null);
        // The child's pending permission ask rides the snapshot.
        setPendingAsk(snap.pendingPermissions[0] ?? null);
        if (current.running) {
          const buffer = createDeltaBuffer({
            flushMs: 75,
            onFlush: (deltas) => applyDeltaBatch(setMessages, deltas),
          });
          ctrl.signal.addEventListener("abort", () => buffer.dispose());
          await followSession(client, current.sessionId, {
            from: snap.afterSeq,
            signal: ctrl.signal,
            onEvent: (evt) => {
              if (evt.type === "message.part.delta") {
                const payload = evt.payload as { messageId: string; partId: string; delta: string };
                buffer.push(payload.messageId, payload.partId, payload.delta);
                return;
              }
              buffer.flush();
              applyEvent(setMessages, evt);
              if (evt.type === "message.created") {
                setMessages((prev) =>
                  prev.length > CHILD_HISTORY_LIMIT ? prev.slice(prev.length - CHILD_HISTORY_LIMIT) : prev,
                );
              }
            },
            onDrop: () => {},
          });
          buffer.flush();
          buffer.dispose();
        }
      } catch (err) {
        if (!ctrl.signal.aborted) setLoadError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => ctrl.abort();
  }, [client, current?.sessionId]);

  // Pending ask while running: lightweight global-index poll (not a full
  // transcript refetch — the stream above owns transcript freshness).
  useEffect(() => {
    if (current === undefined || !current.running) return;
    const timer = setInterval(() => {
      void client
        .pendingAsks()
        .then(({ pendingPermissions }) => {
          setPendingAsk(pendingPermissions.find((r) => r.sessionId === current.sessionId) ?? null);
        })
        .catch(() => {});
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [client, current?.sessionId, current?.running]);

  const loadOlder = useCallback(async () => {
    if (current === undefined || !historyHasMore || historyCursor === null || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const older = await client.historySnapshot(current.sessionId, {
        limit: CHILD_HISTORY_LIMIT,
        before: historyCursor,
      });
      setMessages((prev) => {
        const seen = new Set(prev.map((m) => m.id));
        return [...older.messages.filter((m) => !seen.has(m.id)), ...prev];
      });
      setHistoryHasMore(older.hasMore === true);
      setHistoryCursor(older.nextCursor ?? null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingOlder(false);
    }
  }, [client, current, historyHasMore, historyCursor, loadingOlder]);

  // ---- node-level expansion + focus (main-chat parity) -------------------
  const items = buildTranscriptItems(messages);
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const [expandedThinking, setExpandedThinking] = useState<Set<string>>(new Set());
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());
  const [expandedToolsFull, setExpandedToolsFull] = useState<Set<string>>(new Set());

  /**
   * Toggle a tool node's preview (main-chat parity): enter/space shows the
   * ≤10-line preview, enter/space again hides it (hiding from full
   * collapses fully). f toggles full via toggleToolFull.
   */
  const toggleToolPreview = (key: string): void => {
    if (expandedToolsFull.has(key)) {
      setExpandedTools((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      setExpandedToolsFull((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      return;
    }
    setExpandedTools((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  /** Toggle the bounded full output (the f key): preview ↔ full. */
  const toggleToolFull = (key: string): void => {
    if (expandedToolsFull.has(key)) {
      // Back to the truncated preview (preview set keeps the key).
      setExpandedToolsFull((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      return;
    }
    setExpandedTools((prev) => new Set(prev).add(key));
    setExpandedToolsFull((prev) => new Set(prev).add(key));
  };

  const toggleIn = (set: (fn: (prev: Set<string>) => Set<string>) => void, key: string): void => {
    set((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // ---- scrolling (row-continuous, follow-the-bottom while running) ------
  const scrollRef = useRef<ScrollViewRef>(null);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [contentHeight, setContentHeight] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const followRef = useRef(true);
  const scrollOffsetRef = useRef(0);
  scrollOffsetRef.current = scrollOffset;
  const bottomOffset = Math.max(0, contentHeight - viewportHeight);
  const shownOffset = Math.min(scrollOffset, bottomOffset);

  const handleContentHeightChange = useCallback((height: number): void => {
    setContentHeight(height);
    const bottom = Math.max(0, height - (scrollRef.current?.getViewportHeight() ?? 0));
    if (followRef.current) setScrollOffset(bottom);
    else if (scrollOffsetRef.current > bottom) setScrollOffset(bottom);
  }, []);

  const handleViewportSizeChange = useCallback((size: { height: number }): void => {
    setViewportHeight(size.height);
    if (followRef.current) {
      setScrollOffset(Math.max(0, (scrollRef.current?.getContentHeight() ?? 0) - size.height));
    }
  }, []);

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

  // Fresh child (←/→ or first open): follow the bottom again, focus cleared.
  useEffect(() => {
    followRef.current = true;
    setScrollOffset(0);
    setFocusIndex(null);
  }, [current?.sessionId]);

  const lastVisibleItem = (): number => {
    const limit = scrollOffsetRef.current + Math.max(1, viewportHeight);
    for (let ii = items.length - 1; ii >= 0; ii--) {
      const pos = scrollRef.current?.getItemPosition(ii);
      if (pos !== null && pos !== undefined && pos.top < limit) return ii;
    }
    return Math.max(0, items.length - 1);
  };

  const revealItem = (ii: number): void => {
    const pos = scrollRef.current?.getItemPosition(ii);
    if (pos === null || pos === undefined) return;
    const offset = scrollOffsetRef.current;
    const vh = Math.max(1, viewportHeight);
    if (pos.top < offset) {
      scrollTo(pos.top);
    } else if (pos.top + pos.height > offset + vh) {
      scrollTo(Math.max(0, pos.top + pos.height - vh));
    }
  };

  const stepItem = (down: boolean): void => {
    if (items.length === 0) return;
    const base = focusIndex ?? lastVisibleItem();
    // Clamping traversal — the main chat view's moveFocus semantics.
    const next = moveFocus(base, items.length, down);
    setFocusIndex(next);
    revealItem(next);
  };

  // Mouse wheel (same mechanism as the chat view).
  const { stdout } = useStdout();
  useEffect(() => {
    stdout.write("\x1b[?1000h\x1b[?1006h");
    return () => {
      stdout.write("\x1b[?1006l\x1b[?1000l");
    };
  }, [stdout]);
  const { rows } = useWindowSize();
  useEffect(() => {
    scrollRef.current?.remeasure();
  }, [rows]);

  useInput((ch, key) => {
    // A pending ask owns the keyboard (the embedded PermissionDialog
    // handles a/s/d and its own esc semantics) — navigation is gated off.
    if (pendingAsk !== null) return;
    const mouse = ch !== undefined ? /^\x1b?\[<(\d+);(\d+);(\d+)([Mm])$/.exec(ch) : null;
    if (mouse !== null) {
      const button = Number(mouse[1]);
      if (button === WHEEL_UP) return scrollBy(-WHEEL_ROWS);
      if (button === WHEEL_DOWN) return scrollBy(WHEEL_ROWS);
      return;
    }
    if (key.escape) return onExit();
    // ↑ exits at the top of the transcript (opencode); otherwise it scrolls.
    if (key.upArrow) {
      if (shownOffset <= 0) return onExit();
      return scrollBy(-1);
    }
    if (key.leftArrow) return onNavigate(-1);
    if (key.rightArrow) return onNavigate(1);
    const pageRows = Math.max(1, Math.floor(viewportHeight / 2));
    const halfPageRows = Math.max(1, Math.floor(viewportHeight / 4));
    if (key.pageUp) {
      if (scrollOffsetRef.current <= 0 && historyHasMore && !loadingOlder) {
        void loadOlder();
        return;
      }
      return scrollBy(-pageRows);
    }
    if (key.pageDown) return scrollBy(pageRows);
    if (key.ctrl && ch === "u") return scrollBy(-halfPageRows);
    if (key.ctrl && ch === "d") return scrollBy(halfPageRows);
    // Node traversal + expand (main-chat parity): ctrl+j/k step nodes,
    // space/enter toggle the focused thought/tool output. ctrl+j's legacy
    // spelling (lone "\n": ink parses the raw linefeed byte as name:'enter'
    // with ctrl=false, so it never reaches the ctrl branch above) steps
    // down too — unambiguous here, nothing types in the dialog.
    if (key.ctrl && ch === "j") return stepItem(true);
    if (key.ctrl && ch === "k") return stepItem(false);
    if (ch === "\n") return stepItem(true);
    // f on a focused tool node toggles the bounded full output
    // (preview ↔ full; plain space/enter below toggles preview).
    if (ch === "f") {
      const fullItem = focusIndex !== null ? items[focusIndex] : undefined;
      if (fullItem?.kind === "tool") {
        toggleToolFull(`${fullItem.messageId}:${fullItem.call.callId}`);
      }
      return;
    }
    if (key.downArrow || ch === "j") return scrollBy(1);
    if (ch === "k") return scrollBy(-1);
    if (key.return || ch === " ") {
      const focusedItem = focusIndex !== null ? items[focusIndex] : undefined;
      if (focusedItem?.kind === "thought") {
        toggleIn(setExpandedThinking, focusedItem.messageId);
        return;
      }
      if (focusedItem?.kind === "tool") {
        // Plain space/enter toggles the preview (or hides).
        // f is handled above (toggleToolFull).
        toggleToolPreview(`${focusedItem.messageId}:${focusedItem.call.callId}`);
        return;
      }
      return; // user/text nodes: no-op (esc/↑ exit)
    }
  });

  if (current === undefined) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={t.border} borderBackgroundColor={t.background} paddingX={1}>
        <Text bold color={t.accent}>subagent</Text>
        <Text color={t.dim}>no subagents yet</Text>
        <Text color={t.dim}>↑/esc back</Text>
      </Box>
    );
  }

  const status = current.needsApproval
    ? { glyph: "⚠", text: "needs approval", color: t.danger }
    : current.running
      ? { glyph: "◐", text: "working…", color: t.warning }
      : { glyph: "✓", text: "done", color: t.success };

  return (
    <Box flexDirection="column" height={rows > 0 ? rows : undefined} borderStyle="round" borderColor={t.border} borderBackgroundColor={t.background} paddingX={1}>
      <Text wrap="truncate">
        <Text bold color={t.accent}>subagent </Text>
        <Text color={t.warning}>@{current.agent}</Text>
        <Text color={t.dim}> — {current.title}</Text>
        {children.length > 1 && <Text color={t.dim}>{` [${index + 1}/${children.length}]`}</Text>}
        <Text> </Text>
        <Text color={status.color}>{`${status.glyph} ${status.text}`}</Text>
      </Text>

      {pendingAsk !== null ? (
        // The child is blocked on a permission ask: review it right here
        // (a/s/d reply; the transcript resumes after).
        <PermissionDialog
          key={String(pendingAsk.id)} // fresh instance per ask: the busy latch must not outlive its request
          client={client}
          request={pendingAsk}
          onDone={() => {
            setPendingAsk(null);
          }}
        />
      ) : (
        <ScrollView
          ref={scrollRef}
          scrollOffset={shownOffset}
          onContentHeightChange={handleContentHeightChange}
          onViewportSizeChange={handleViewportSizeChange}
          flexGrow={1}
          flexShrink={1}
          flexBasis={0}
          minHeight={0}
          marginY={1}
        >
          {items.map((item, ii) => {
            const focused = focusIndex === ii;
            const marker = focused ? <Text color={t.accent}>❯ </Text> : null;
            const gap = ii === 0 ? 0 : 1;
            if (item.kind === "user") {
              return (
                <Box key={`${item.messageId}:user`} marginTop={gap} marginBottom={1} flexShrink={0}>
                  <Text wrap="wrap" color={t.dim}>
                    {marker}› {messageText(messages[item.messageIndex] as Message)}
                  </Text>
                </Box>
              );
            }
            if (item.kind === "thought") {
              const thinking = messageTextOfKind(messages[item.messageIndex], "thinking");
              const lineCount = thinking.split("\n").length;
              const expanded = expandedThinking.has(item.messageId);
              return (
                <Box key={`${item.messageId}:thought`} marginTop={gap} marginBottom={1} flexShrink={0}>
                  {expanded ? (
                    <Box flexDirection="column">
                      <Text color={t.dim}>{marker}── thought ──</Text>
                      <Markdown text={thinking} dim />
                    </Box>
                  ) : (
                    <Text color={focused ? t.accent : t.dim}>
                      {marker}▸ thought ({lineCount} line{lineCount === 1 ? "" : "s"})
                    </Text>
                  )}
                </Box>
              );
            }
            if (item.kind === "tool") {
              const c = item.call;
              const toolKey = `${item.messageId}:${c.callId}`;
              const expanded = expandedTools.has(toolKey);
              const full = expandedToolsFull.has(toolKey);
              const glyph = c.status === "running" ? "◦" : c.status === "error" ? "✗" : "✓";
              const color = c.status === "running" ? t.warning : c.status === "error" ? t.danger : t.success;
              return (
                <Box key={`${item.messageId}:${c.callId}`} marginTop={gap} marginBottom={expanded ? 1 : 0} flexShrink={0} flexDirection="column">
                  <Text wrap="truncate">
                    {marker}
                    <Text color={focused ? t.accent : color}>{glyph} </Text>
                    <Text color={focused ? t.accent : t.text}>
                      {c.name}
                    </Text>
                    {c.argsPreview.length > 0 && <Text color={t.text}> {c.argsPreview}</Text>}
                    {c.result !== undefined && c.result.isError && <Text color={t.danger}> · failed</Text>}
                    {c.result !== undefined && focused && (
                      <Text color={t.dim}>
                        {expanded
                          ? full
                            ? " · space to hide · f to truncate"
                            : " · space to hide · f for full"
                          : " · space to view output"}
                      </Text>
                    )}
                  </Text>
                  {expanded && c.result !== undefined && (
                    <ToolOutputBody content={c.result.content} mode={full ? "full" : "preview"} />
                  )}
                </Box>
              );
            }
            // text: the child's reply body — markdown like the main view.
            return (
              <Box key={`${item.messageId}:text`} marginTop={gap} marginBottom={1} flexShrink={0}>
                <Markdown text={messageText(messages[item.messageIndex] as Message)} marker={marker ?? undefined} />
              </Box>
            );
          })}
          {items.length === 0 && !loadError && <Text color={t.dim}>waiting for the subagent…</Text>}
          {loadError !== null && <Text color={t.danger}>{loadError}</Text>}
        </ScrollView>
      )}

      <Text color={t.dim}>
        {children.length > 1 ? "←/→ subagent · " : ""}ctrl+j/k node · space output · j/k scroll · ↑ (at top) / esc back
      </Text>
    </Box>
  );
}

/** Flatten one message's parts of a kind (text/thinking). */
function messageTextOfKind(message: Message | undefined, kind: "text" | "thinking"): string {
  if (message === undefined) return "";
  return message.parts
    .filter((p) => p.kind === kind)
    .map((p) => (p.payload as { text?: string } | null)?.text ?? "")
    .join("");
}
