import { Box, Text, useInput, useStdout, useWindowSize } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import type { BaiClient } from "@bai/api/client";
import type { Message, PermissionRequest } from "@bai/shared";
import { ScrollView, type ScrollViewRef } from "../components/scroll-view";
import { PermissionDialog } from "./permission-dialog";
import { toolCalls } from "../state/sync";
import type { SubagentActivity } from "../state/subagents";

/** Live-refetch cadence while the child session is still running. */
const REFRESH_MS = 1500;
/** Wheel rows per tick (matches the chat view). */
const WHEEL_UP = 64;
const WHEEL_DOWN = 65;
const WHEEL_ROWS = 3;

/**
 * Subagent output dialog (opencode's subagent inspector): the child
 * session's full transcript, live-refreshing while it works. ←/→ cycle
 * between the parent's subagents (wrap-around); ↑ exits when the
 * transcript is scrolled to the top (otherwise it scrolls up, opencode's
 * behavior); esc always exits.
 *
 * Rendered in the app's dialog slot — it owns the keyboard while open.
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
  const [tick, setTick] = useState(0); // forces a refetch when bumped

  // ---- transcript fetch + live refresh -----------------------------------
  useEffect(() => {
    if (current === undefined) return;
    const ctrl = new AbortController();
    setLoadError(null);
    void (async () => {
      try {
        const snap = await client.historySnapshot(current.sessionId);
        if (ctrl.signal.aborted) return;
        setMessages(snap.messages);
        // The child's pending permission ask rides the snapshot — the
        // dialog is the review surface (subagents are not in the picker).
        setPendingAsk(snap.pendingPermissions[0] ?? null);
      } catch (err) {
        if (!ctrl.signal.aborted) setLoadError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => ctrl.abort();
  }, [client, current?.sessionId, tick]);

  useEffect(() => {
    if (current === undefined || !current.running) return;
    const timer = setInterval(() => setTick((t) => t + 1), REFRESH_MS);
    return () => clearInterval(timer);
  }, [current?.sessionId, current?.running]);

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

  // Fresh child (←/→ or first open): follow the bottom again.
  useEffect(() => {
    followRef.current = true;
    setScrollOffset(0);
  }, [current?.sessionId]);

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
    if (key.pageUp) return scrollBy(-pageRows);
    if (key.pageDown) return scrollBy(pageRows);
    if (key.ctrl && ch === "u") return scrollBy(-halfPageRows);
    if (key.ctrl && ch === "d") return scrollBy(halfPageRows);
    if (key.downArrow || ch === "j") return scrollBy(1);
    if (ch === "k") return scrollBy(-1);
  });

  if (current === undefined) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
        <Text bold color="cyan">subagent</Text>
        <Text dimColor>no subagents yet</Text>
        <Text dimColor>↑/esc back</Text>
      </Box>
    );
  }

  const status = current.needsApproval
    ? { glyph: "⚠", text: "needs approval", color: "red" as const }
    : current.running
      ? { glyph: "◐", text: "working…", color: "yellow" as const }
      : { glyph: "✓", text: "done", color: "green" as const };

  return (
    <Box flexDirection="column" height={rows > 0 ? rows : undefined} borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text wrap="truncate">
        <Text bold color="cyan">subagent </Text>
        <Text color="yellow">@{current.agent}</Text>
        <Text dimColor> — {current.title}</Text>
        {children.length > 1 && (
          <Text dimColor>{` [${index + 1}/${children.length}]`}</Text>
        )}
        <Text> </Text>
        <Text color={status.color}>{`${status.glyph} ${status.text}`}</Text>
      </Text>

      {pendingAsk !== null ? (
        // The child is blocked on a permission ask: review it right here
        // (a/s/d reply; the transcript resumes after).
        <PermissionDialog
          client={client}
          request={pendingAsk}
          onDone={() => {
            setPendingAsk(null);
            setTick((t) => t + 1);
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
          {messages.map((m) => (
            <Box key={m.id} flexDirection="column" marginBottom={1} flexShrink={0}>
              {m.role === "user" ? (
                <Text wrap="wrap" dimColor>
                  › {messageTextOf(m)}
                </Text>
              ) : (
                <>
                  {toolCalls(m).map((c) => {
                    const glyph = c.status === "running" ? "◦" : c.status === "error" ? "✗" : "✓";
                    const color = c.status === "running" ? "yellow" : c.status === "error" ? "red" : "green";
                    return (
                      <Text key={c.callId} wrap="truncate">
                        <Text color={color}>{glyph} </Text>
                        <Text dimColor>{c.name}</Text>
                        {c.argsPreview.length > 0 && <Text> {c.argsPreview}</Text>}
                      </Text>
                    );
                  })}
                  <Text wrap="wrap">{messageTextOf(m)}</Text>
                </>
              )}
            </Box>
          ))}
          {messages.length === 0 && !loadError && (
            <Text dimColor>waiting for the subagent…</Text>
          )}
          {loadError !== null && <Text color="red">{loadError}</Text>}
        </ScrollView>
      )}

      <Text dimColor>
        {children.length > 1 ? "←/→ subagent · " : ""}j/k scroll · ↑ (at top) / esc back
      </Text>
    </Box>
  );
}

/** Flatten a message's text parts (local — keeps the dialog self-contained). */
function messageTextOf(message: Message): string {
  return message.parts
    .map((p) => (p.kind === "text" ? ((p.payload as { text?: string } | null)?.text ?? "") : ""))
    .join("");
}
