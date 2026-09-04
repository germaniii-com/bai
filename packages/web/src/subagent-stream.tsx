import { useEffect, useRef, useState } from "react";
import type { BaiClient } from "@bai/api/client";
import type { Message } from "@bai/shared";
import { messageText, thinkingText, toolCalls } from "./state";
import type { SubagentActivity } from "./state-subagents";

/** Live-refresh cadence while the child is still running (TUI parity). */
const REFRESH_MS = 1500;

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
 * `active` (task result not yet landed, or the tracked child still
 * running) drives the cadence: poll while active, one final fetch when it
 * flips false, plain static transcript afterwards.
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
  const [messages, setMessages] = useState<Message[]>([]);
  const [error, setError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  // In-flight guard: a slow snapshot must never stack with the next tick's.
  const fetchingRef = useRef(false);

  useEffect(() => {
    let disposed = false;

    const fetchSnapshot = async (): Promise<void> => {
      if (fetchingRef.current) return;
      fetchingRef.current = true;
      try {
        const snap = await client.historySnapshot(child.sessionId);
        if (!disposed) {
          setMessages(snap.messages);
          setError(null);
        }
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
  }, [client, child.sessionId, active]);

  // Follow the bottom: every transcript change snaps to the latest row
  // unless the user scrolled up (small panel — any upward scroll pins).
  const pinnedRef = useRef(true);
  useEffect(() => {
    const el = bodyRef.current;
    if (el === null) return;
    if (pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);
  const onScroll = (): void => {
    const el = bodyRef.current;
    if (el === null) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  const status = child.needsApproval
    ? { glyph: "⚠", text: "needs approval", className: "subagent-status-asking" }
    : active
      ? { glyph: "◐", text: "working…", className: "subagent-status-running" }
      : { glyph: "✓", text: "done", className: "subagent-status-done" };

  return (
    <div className="subagent-stream" aria-label={`live transcript of the ${child.agent} subagent`}>
      <div className="subagent-stream-head">
        <span className="subagent-agent">@{child.agent}</span>
        <span className="subagent-title">{child.title}</span>
        <span className={`subagent-status ${status.className}`}>
          {status.glyph} {status.text}
        </span>
      </div>
      {error !== null ? (
        <div className="subagent-stream-error">{error}</div>
      ) : (
        <div className="subagent-stream-body" ref={bodyRef} onScroll={onScroll}>
          {messages.length === 0 && <p className="dim">waiting for the subagent…</p>}
          {messages.map((m) => (
            <div key={m.id} className={`subagent-message subagent-${m.role}`}>
              {m.role === "assistant" && thinkingText(m).length > 0 && (
                <ChildThought text={thinkingText(m)} />
              )}
              {m.role === "assistant" && toolCalls(m).length > 0 && <ToolNodes calls={toolCalls(m)} />}
              {messageText(m).length > 0 && <p>{messageText(m)}</p>}
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
        {open ? "▾" : "▸"} thought
      </button>
      {open && <div className="thinking-body">{text}</div>}
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
        const glyph = c.status === "running" ? "◦" : c.status === "error" ? "✗" : "✓";
        return (
          <div key={c.callId} className={`tool-node tool-${c.status}`}>
            <button type="button" className="tool-toggle" onClick={() => toggle(c.callId)} aria-expanded={open}>
              <span className={`tool-glyph tool-glyph-${c.status}`}>{glyph}</span> {c.name}
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
