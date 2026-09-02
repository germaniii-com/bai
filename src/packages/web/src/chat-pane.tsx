import { useState } from "react";
import type { BaiClient } from "@bai/api/client";
import type { Message, ProviderListResponse, Session } from "@bai/shared";
import { messageText, thinkingText, toolCalls, type ToolCallView } from "./state";
import { ModelPicker } from "./model-picker";

/**
 * The chat surface, shared by the Chat section and the Workspace section
 * (a workspace session is an ordinary session — same streaming transcript,
 * model picker, stop button). Presentational: all state lives in App so a
 * section switch keeps one source of truth.
 */
export function ChatPane({
  client,
  list,
  active,
  configDefault,
  refreshProviders,
  providersFetching,
  messages,
  draft,
  setDraft,
  onSubmit,
  runActive,
  waiting,
  error,
  startPlaceholder = "Start a chat…",
}: {
  client: BaiClient;
  /** Null until the first provider engagement fetch lands. */
  list: ProviderListResponse | null;
  active: Session | null;
  /** Default model from GET /api/config — keeps the picker label truthful. */
  configDefault?: string;
  refreshProviders: () => Promise<void>;
  providersFetching: boolean;
  messages: Message[];
  draft: string;
  setDraft: (value: string) => void;
  onSubmit: () => void;
  runActive: boolean;
  waiting: boolean;
  error: string | null;
  /** Composer placeholder while no session is open. */
  startPlaceholder?: string;
}) {
  return (
    <main className="chat">
      <div className="chat-head">
        <ModelPicker
          client={client}
          list={list}
          active={active}
          configDefault={configDefault}
          refreshProviders={refreshProviders}
        />
        {providersFetching && <span className="dim">updating…</span>}
        {list !== null && !list.providers.some((p) => p.connected && p.id !== "stub") && (
          <span className="hint">no provider connected — add one under settings</span>
        )}
      </div>
      <div className="messages">
        {messages.length === 0 && !waiting && <p className="dim empty">No messages yet.</p>}
        {messages.map((m) => (
          <div key={m.id} className={`message ${m.role}`}>
            {m.role === "assistant" && thinkingText(m).length > 0 && <ThinkingNode text={thinkingText(m)} />}
            {m.role === "assistant" && toolCalls(m).length > 0 && <ToolNodes calls={toolCalls(m)} />}
            <p>{messageText(m)}</p>
          </div>
        ))}
        {waiting && (
          <div className="message assistant">
            <div className="typing" role="status" aria-label="assistant is thinking">
              <span className="dot" />
              <span className="dot" />
              <span className="dot" />
              <span className="typing-label">thinking…</span>
            </div>
          </div>
        )}
      </div>
      {error !== null && <div className="error">{error}</div>}
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
      >
        <input
          value={draft}
          placeholder={active === null ? startPlaceholder : "Message…"}
          onChange={(e) => setDraft(e.target.value)}
          aria-label="message"
        />
        {runActive && active !== null ? (
          // Stop replaces send while the model is responding; the partial
          // reply stays in history after the interrupt.
          <button
            type="button"
            className="stop"
            onClick={() => void client.interrupt(active.id)}
            aria-label="stop generating"
          >
            stop
          </button>
        ) : (
          <button type="submit" disabled={draft.trim().length === 0}>
            send
          </button>
        )}
      </form>
    </main>
  );
}

/**
 * A reasoning transcript node (opencode parity): the model's chain of
 * thought rendered as its own collapsible block above the reply. Collapsed
 * by default; each node toggles independently; the state survives session
 * switches because the thinking parts live in the message history itself.
 */
function ThinkingNode({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const lineCount = text.split("\n").length;
  return (
    <div className="thinking-node">
      <button
        type="button"
        className="thinking-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {open ? "▾" : "▸"} thought ({lineCount} line{lineCount === 1 ? "" : "s"})
      </button>
      {open && <div className="thinking-body">{text}</div>}
    </div>
  );
}

/**
 * Tool-call transcript nodes: one collapsible line per call (tool name +
 * args digest + status), expanding to the result content. Mirrors the
 * ThinkingNode pattern — collapsible, independent, history-backed.
 */
function ToolNodes({ calls }: { calls: ToolCallView[] }) {
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());
  const toggle = (callId: string) => {
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
            <button
              type="button"
              className="tool-toggle"
              onClick={() => toggle(c.callId)}
              aria-expanded={open}
            >
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
