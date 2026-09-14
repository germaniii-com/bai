import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { BaiClient } from "@bai/api/client";
import type { Message } from "@bai/shared";
import { messageText, thinkingText, toolCalls } from "./state";
import type { SubagentActivity } from "./state-subagents";
import { Markdown } from "./markdown";
import { Chevron, SubagentStatusIcon, ToolStatusIcon } from "./icons";

/** Live-refresh cadence while the child is still running (TUI parity). */
const REFRESH_MS = 1500;
/** Messages per page (newest window + older scroll-back pages). */
const PAGE = 50;

/**
 * Inline live subagent transcript (TUI SubagentDialog parity): the child
 * session's transcript, refreshed by POLLING a snapshot every 1.5s while
 * the child runs — NOT by holding a dedicated SSE stream.
 *
 * Why polling (the TUI's choice, deliberately ported): browsers cap ~6
 * concurrent connections per origin, and the page already holds the global
 * firehose + the parent's durable stream. One more held stream per
 * expanded task node saturates that budget, and every unrelated request —
 * permission replies, a new panel's own snapshot — then queues in the
 * browser until a stream closes. Polling is one short-lived GET per tick,
 * held connections stay at two, and everything stays responsive.
 *
 * Paging: the newest page lives in `latest` (replaced each poll; messages
 * aged out of it are appended to `older` so nothing is lost), and `older`
 * grows upward on scroll-back (`loadOlder` prepends older pages). `active`
 * (task result not yet landed, or the tracked child still running) drives
 * the cadence: poll while active, one final fetch when it flips false,
 * plain static transcript afterwards.
 */
export function SubagentStream({
  client,
  child,
  active,
}: {
  client: BaiClient;
  child: SubagentActivity;
  /** The task is still executing (or the tracked child is running). */
  active: boolean;
}) {
  const [older, setOlder] = useState<Message[]>([]);
  const [latest, setLatest] = useState<Message[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  // In-flight guard: a slow snapshot must never stack with the next tick's.
  const fetchingRef = useRef(false);
  // Newest window mirrored in a ref so a poll can age messages into `older`
  // without a state-updater side effect.
  const latestRef = useRef<Message[]>([]);
  // Scroll anchor for prepends (preserve reading position).
  const anchorRef = useRef<{ height: number; top: number; firstId: string | undefined } | null>(null);
  const seededRef = useRef(false);
  const childIdRef = useRef<string | undefined>(undefined);

  /** Replace the newest window, aging evicted messages into `older`. */
  const applyLatest = useCallback((messages: Message[]): void => {
    const newIds = new Set(messages.map((m) => m.id));
    const dropped = latestRef.current.filter((m) => !newIds.has(m.id));
    if (dropped.length > 0) {
      setOlder((prev) => {
        const known = new Set(prev.map((m) => m.id));
        return [...prev, ...dropped.filter((m) => !known.has(m.id))];
      });
    }
    latestRef.current = messages;
    setLatest(messages);
  }, []);

  useEffect(() => {
    let disposed = false;
    // Reset paging state only for a NEW child. An `active` flip (the run
    // finishing) re-runs this effect for its trailing fetch — it must not
    // discard pages the user scrolled back to.
    if (childIdRef.current !== child.sessionId) {
      childIdRef.current = child.sessionId;
      setOlder([]);
      setLatest([]);
      latestRef.current = [];
      setHasMore(false);
      setCursor(null);
      setLoadingOlder(false);
      seededRef.current = false;
    }

    const fetchSnapshot = async (): Promise<void> => {
      if (fetchingRef.current) return;
      fetchingRef.current = true;
      try {
        const snap = await client.historySnapshot(child.sessionId, { limit: PAGE });
        if (disposed) return;
        applyLatest(snap.messages);
        // Seed hasMore/cursor once (poll ticks keep the existing older cursor).
        if (!seededRef.current) {
          seededRef.current = true;
          setHasMore(snap.hasMore === true);
          setCursor(snap.nextCursor ?? null);
        }
        setError(null);
      } catch (err) {
        if (!disposed) setError(err instanceof Error ? err.message : String(err));
      } finally {
        fetchingRef.current = false;
      }
    };

    void fetchSnapshot();
    // Poll only while the task is live. When `active` flips false this
    // effect re-runs: the interval is cleared and the unconditional fetch
    // above becomes the trailing snapshot that catches the final rows
    // written between the last tick and the run ending.
    let timer: ReturnType<typeof setInterval> | null = null;
    if (active) {
      timer = setInterval(() => void fetchSnapshot(), REFRESH_MS);
    }
    return () => {
      disposed = true;
      if (timer !== null) clearInterval(timer);
    };
  }, [client, child.sessionId, active, applyLatest]);

  const loadOlder = useCallback((): void => {
    if (!hasMore || cursor === null || loadingOlder) return;
    setLoadingOlder(true);
    void (async () => {
      try {
        const page = await client.historySnapshot(child.sessionId, { limit: PAGE, before: cursor });
        setOlder((prev) => {
          const known = new Set([...prev, ...latestRef.current].map((m) => m.id));
          return [...page.messages.filter((m) => !known.has(m.id)), ...prev];
        });
        setHasMore(page.hasMore === true);
        setCursor(page.nextCursor ?? null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoadingOlder(false);
      }
    })();
  }, [client, child.sessionId, hasMore, cursor, loadingOlder]);

  // Combined render list, deduped at the older/latest seam.
  const messages: Message[] = [...older, ...latest.filter((m) => !older.some((o) => o.id === m.id))];

  // Follow the bottom: every transcript change snaps to the latest row
  // unless the user scrolled up (small panel — any upward scroll pins).
  const pinnedRef = useRef(true);
  useEffect(() => {
    const el = bodyRef.current;
    if (el === null) return;
    if (pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Preserve the reading position when a page is prepended above.
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (anchor === null) return;
    if (messages[0]?.id !== anchor.firstId) {
      const el = bodyRef.current;
      if (el !== null) {
        const delta = el.scrollHeight - anchor.height;
        if (delta > 0) el.scrollTop = anchor.top + delta;
      }
      anchorRef.current = null;
    } else if (!loadingOlder) {
      anchorRef.current = null;
    }
  }, [messages, loadingOlder]);

  const onScroll = (): void => {
    const el = bodyRef.current;
    if (el === null) return;
    if (el.scrollTop <= 24 && hasMore && !loadingOlder) {
      anchorRef.current = { height: el.scrollHeight, top: el.scrollTop, firstId: messages[0]?.id };
      loadOlder();
      return;
    }
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  const status = child.needsApproval
    ? { text: "needs approval", className: "subagent-status-asking" }
    : active
      ? { text: "working…", className: "subagent-status-running" }
      : { text: "done", className: "subagent-status-done" };

  return (
    <div className="subagent-stream" aria-label={`live transcript of the ${child.agent} subagent`}>
      <div className="subagent-stream-head">
        <span className="subagent-agent">@{child.agent}</span>
        <span className="subagent-title">{child.title}</span>
        <span className={`subagent-status ${status.className}`}>
          <SubagentStatusIcon asking={child.needsApproval} active={active} />
          <span>{status.text}</span>
        </span>
      </div>
      {error !== null ? (
        <div className="subagent-stream-error">{error}</div>
      ) : (
        <div className="subagent-stream-body" ref={bodyRef} onScroll={onScroll}>
          {(hasMore || loadingOlder) && (
            <div className="load-older" role="status">
              {loadingOlder ? (
                <span className="dim">Loading earlier messages…</span>
              ) : (
                <button
                  type="button"
                  className="load-older-btn"
                  onClick={() => {
                    const el = bodyRef.current;
                    if (el !== null) anchorRef.current = { height: el.scrollHeight, top: el.scrollTop, firstId: messages[0]?.id };
                    loadOlder();
                  }}
                >
                  Load earlier messages
                </button>
              )}
            </div>
          )}
          {messages.length === 0 && <p className="dim">waiting for the subagent…</p>}
          {messages.map((m) => (
            <div key={m.id} className={`subagent-message subagent-${m.role}`}>
              {m.role === "assistant" && thinkingText(m).length > 0 && (
                <ChildThought text={thinkingText(m)} />
              )}
              {m.role === "assistant" && toolCalls(m).length > 0 && <ToolNodes calls={toolCalls(m)} />}
              {messageText(m).length > 0 &&
                (m.role === "assistant" ? <Markdown text={messageText(m)} /> : <p>{messageText(m)}</p>)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Collapsed-by-default thought node inside the child transcript. */
function ChildThought({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="thinking-node">
      <button type="button" className="thinking-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <Chevron open={open} />
        <span>thought</span>
      </button>
      {open && (
        <div className="thinking-body">
          <Markdown text={text} />
        </div>
      )}
    </div>
  );
}

/**
 * The parent pane's tool node renderer reused for the child's calls —
 * plain status, no nested subagent expansion.
 */
function ToolNodes({ calls }: { calls: ReturnType<typeof toolCalls> }) {
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());
  const toggle = (callId: string): void => {
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(callId)) next.delete(callId);
      else next.add(callId);
      return next;
    });
  };
  return (
    <div className="tool-nodes">
      {calls.map((c) => {
        const open = openIds.has(c.callId);
        return (
          <div key={c.callId} className={`tool-node tool-${c.status}`}>
            <button type="button" className="tool-toggle" onClick={() => toggle(c.callId)} aria-expanded={open}>
              <ToolStatusIcon status={c.status} /> {c.name}
              {c.argsPreview.length > 0 && <span className="tool-args"> {c.argsPreview}</span>}
            </button>
            {open && c.result !== undefined && (
              <div className={`tool-body ${c.result.isError ? "tool-body-error" : ""}`}>{c.result.content}</div>
            )}
          </div>
        );
      })}
    </div>
  );
}
