import { useState } from "react";
import { Check, Copy, GitFork, Undo2, X } from "lucide-react";
import type { BaiClient } from "@bai/api/client";
import type { AgentInfo, Message, ProviderListResponse, Session } from "@bai/shared";
import { messageText, revertBoundary, thinkingText, toolCalls, type ToolCallView } from "./state";
import { findChildForTask, type SubagentState } from "./state-subagents";
import { AskPanel, type PendingAsk } from "./ask-panel";
import { ModelPicker } from "./model-picker";
import { AgentPicker } from "./agent-picker";
import { SubagentStream } from "./subagent-stream";
import { Markdown } from "./markdown";
import { FolderGlyph } from "./workspace";
import { Chevron, ToolStatusIcon } from "./icons";

/**
 * Contextual hub label — the composer status row's left chip (TUI parity):
 * a workspace (code) session shows its folder basename; a chat session shows
 * workbench + title; the draft state (no session yet) shows "new session".
 */
function hubContextLabel(active: Session | null): string {
  if (active === null) return "new session";
  const cwd = typeof active.cwd === "string" ? active.cwd : "";
  if (cwd.length > 0) {
    const parts = cwd.split("/").filter((s) => s.length > 0);
    return parts[parts.length - 1] ?? cwd;
  }
  return `${active.workbench} · ${active.title.length > 0 ? active.title : "(untitled)"}`;
}

/**
 * The chat surface, shared by the Chat section and the Workspace section
 * (a workspace session is an ordinary session — same streaming transcript,
 * composer hub, stop button). Presentational: all state lives in App so a
 * section switch keeps one source of truth.
 *
 * The COMPOSER is the centralized hub (TUI parity — there is no chat
 * header): input row on top, then a status row — contextual workspace/
 * session chip left; provider hint, "updating…", and the agent + model
 * pickers right. Navigation lives in the master rail.
 */
export function ChatPane({
  client,
  list,
  active,
  configDefault,
  configDefaultAgent,
  agents,
  refreshAgents,
  refreshProviders,
  providersFetching,
  messages,
  draft,
  setDraft,
  onSubmit,
  runActive,
  waiting,
  error,
  onSwitchWorkspace,
  subagents,
  pendingAsk,
  askQueued = 0,
  onAskDone,
  startPlaceholder = "Start a chat…",
  onForkMessage,
  onRevertMessage,
  onRestoreRevert,
  revertBusy,
}: {
  client: BaiClient;
  /** Null until the first provider engagement fetch lands. */
  list: ProviderListResponse | null;
  active: Session | null;
  /** Default model from GET /api/config — keeps the picker label truthful. */
  configDefault?: string;
  /** Default agent (config agents.default) — keeps the agent label truthful. */
  configDefaultAgent?: string;
  /** Live agent catalog (App-owned; refreshed via agents.updated). */
  agents: AgentInfo[];
  refreshAgents: () => Promise<void>;
  refreshProviders: () => Promise<void>;
  providersFetching: boolean;
  messages: Message[];
  draft: string;
  setDraft: (value: string) => void;
  onSubmit: () => void;
  runActive: boolean;
  waiting: boolean;
  error: string | null;
  /** Workspace-chip click: switch to the workspace picker (code sessions only). */
  onSwitchWorkspace: () => void;
  /** Composer placeholder while no session is open. */
  startPlaceholder?: string;
  /** Tracked children of the active session (firehose-fed) — live status
   *  for task nodes and the inline live transcripts. */
  subagents?: SubagentState;
  // ---- inline ask panel (non-blocking; replaces the modal era) ----------
  /** The merged, prioritized pending ask (undefined → no panel). */
  pendingAsk?: PendingAsk;
  /** Asks waiting behind the head one (queue indicator). */
  askQueued?: number;
  /** Pop the head ask off its queue after a reply. */
  onAskDone: () => void;
  // ---- per-user-message actions (opencode parity) ------------------------
  /** Fork at a message: new session with the earlier history, composer seeded. */
  onForkMessage?: (message: Message) => void;
  /** Revert to a user message: hide it + everything after, roll back files. */
  onRevertMessage?: (message: Message) => void;
  /** Restore a pending revert (bring the hidden messages back). */
  onRestoreRevert?: () => void;
  /** True while a revert/restore request is in flight (disables the buttons). */
  revertBusy?: boolean;
}) {
  // Two-phase revert display: everything at/after the boundary disappears
  // and a small banner offers the restore (messages come back until the
  // next prompt commits the deletion server-side).
  const boundary = revertBoundary(active);
  const boundaryIdx = boundary === undefined ? -1 : messages.findIndex((m) => m.id === boundary);
  const visible = boundaryIdx < 0 ? messages : messages.slice(0, boundaryIdx);
  const revertedCount = boundaryIdx < 0 ? 0 : messages.length - boundaryIdx;

  return (
    <main className="chat">
      <div className="messages">
        {visible.length === 0 && revertedCount === 0 && !waiting && <p className="dim empty">No messages yet.</p>}
        {visible.map((m) => (
          <div key={m.id} className={`message ${m.role}`}>
            {m.role === "assistant" && thinkingText(m).length > 0 && <ThinkingNode text={thinkingText(m)} />}
            {m.role === "assistant" && toolCalls(m).length > 0 && (
              <ToolNodes calls={toolCalls(m)} subagents={subagents} client={client} />
            )}
            {/* Assistant bodies render markdown; user input stays literal. */}
            {m.role === "assistant" ? <Markdown text={messageText(m)} /> : <p>{messageText(m)}</p>}
            {m.role === "user" && (onForkMessage !== undefined || onRevertMessage !== undefined) && (
              <UserMessageActions message={m} onFork={onForkMessage} onRevert={onRevertMessage} />
            )}
          </div>
        ))}
        {revertedCount > 0 && onRestoreRevert !== undefined && (
          <div className="revert-banner" role="status">
            <Undo2 size={13} aria-hidden="true" />
            <span>
              {revertedCount} message{revertedCount === 1 ? "" : "s"} reverted — sending a new message commits this
            </span>
            <button type="button" onClick={onRestoreRevert} disabled={revertBusy === true}>
              restore
            </button>
          </div>
        )}
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
      {pendingAsk !== undefined && (
        // The inline ask panel (opencode's above-the-input placement): a
        // normal layout child between transcript and composer — no overlay,
        // no dim. The transcript keeps scrolling; the composer stays put
        // below; the rest of the app stays navigable. Keyed by the request
        // id: a next ask swaps in as a fresh instance, so component-local
        // latches (busy) can never outlive their ask.
        <AskPanel key={String(pendingAsk.request.id)} client={client} ask={pendingAsk} queued={askQueued} onDone={onAskDone} />
      )}
      {/* The composer HUB — the centralized surface (there is no chat
          header): row 1 the input + send/stop, row 2 the status row
          (contextual workspace/session chip left; provider hint +
          "updating…" + agent/model pickers right). The workspace chip
          switches to the workspace picker for code sessions. The inline ask
          panel above stays a normal layout child — the composer never
          moves. All buttons here are type="button": only the form's
          implicit submit (Enter / the send button) sends. */}
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
      >
        <div className="composer-input-row">
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
        </div>
        <div className="composer-row composer-status">
          {active !== null && typeof active.cwd === "string" && active.cwd.length > 0 ? (
            <button
              type="button"
              className="composer-chip"
              title={`${active.cwd} — switch workspace`}
              onClick={onSwitchWorkspace}
            >
              <FolderGlyph />
              <span className="chip-label">{hubContextLabel(active)}</span>
            </button>
          ) : (
            <span
              className="composer-chip static"
              title={active === null ? "Draft — the session is created with your first message" : undefined}
            >
              <FolderGlyph />
              <span className="chip-label">{hubContextLabel(active)}</span>
            </span>
          )}
          <span className="composer-spacer" />
          {list !== null && !list.providers.some((p) => p.connected && p.id !== "stub") && (
            <span className="hint">no provider connected</span>
          )}
          {providersFetching && <span className="dim">updating…</span>}
          <AgentPicker
            client={client}
            agents={agents}
            active={active}
            configDefaultAgent={configDefaultAgent}
            refreshAgents={refreshAgents}
          />
          <ModelPicker
            client={client}
            list={list}
            active={active}
            configDefault={configDefault}
            refreshProviders={refreshProviders}
          />
        </div>
      </form>
    </main>
  );
}

/**
 * Hover-revealed action row under a user message (opencode web parity):
 * copy the prompt text, fork a new session from the earlier history, or
 * revert to this message (undoing it, everything after it, and the file
 * changes they made). Copy flips to a check for two seconds on success.
 */
function UserMessageActions({
  message,
  onFork,
  onRevert,
}: {
  message: Message;
  onFork?: (message: Message) => void;
  onRevert?: (message: Message) => void;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(messageText(message));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable (denied permission, insecure context) — no feedback to show.
    }
  };
  return (
    <div className="message-actions">
      <button
        type="button"
        className="message-action"
        onClick={() => void copy()}
        aria-label={copied ? "copied" : "copy message"}
        title={copied ? "Copied" : "Copy message"}
      >
        {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
      </button>
      {onFork !== undefined && (
        <button
          type="button"
          className="message-action"
          onClick={() => onFork(message)}
          aria-label="fork from here"
          title="Fork from here — new session with the earlier history, composer prefilled"
        >
          <GitFork size={13} aria-hidden="true" />
        </button>
      )}
      {onRevert !== undefined && (
        <button
          type="button"
          className="message-action"
          onClick={() => onRevert(message)}
          aria-label="revert to here"
          title="Revert — undo this message, everything after it, and their file changes"
        >
          <Undo2 size={13} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

/**
 * A reasoning transcript node (opencode parity): the model's chain of
 * thought rendered as its own collapsible block above the reply. Collapsed
 * by default; each node toggles independently; the state survives session
 * switches because the thinking parts live in the message history itself.
 */function ThinkingNode({ text }: { text: string }) {
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
        <Chevron open={open} />
        <span>
          thought ({lineCount} line{lineCount === 1 ? "" : "s"})
        </span>
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
 * Tool-call transcript nodes: one collapsible line per call (tool name +
 * args digest + status), expanding to the result content. Mirrors the
 * ThinkingNode pattern — collapsible, independent, history-backed.
 *
 * Task calls (TUI SubagentDialog parity): the row shows the tracked
 * child's LIVE status (⚠ needs approval / ◦ working…) — resolved from the
 * firehose-fed children even before the task result lands — and expands
 * into an inline live transcript of the child session (SubagentStream).
 * No navigation away: the parent session stays open underneath.
 */
function ToolNodes({
  calls,
  subagents,
  client,
}: {
  calls: ToolCallView[];
  subagents?: SubagentState;
  client: BaiClient;
}) {
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
        // Task nodes: resolve the tracked child (result link when landed,
        // exact title match while still running) for live status.
        const isTask = c.name === "task";
        const child =
          isTask && subagents !== undefined
            ? findChildForTask(subagents.children, c.rawArgs, c.subagent?.sessionId)
            : undefined;
        const asking = child?.needsApproval === true;
        const live = c.result === undefined && (asking || child?.running === true);
        const status = live ? ("running" as const) : c.status;
        const agent = child?.agent ?? c.subagent?.agent;
        // Retained answered ask (task-node parity for the ask UX): the
        // verdict rides the row; expanding reviews the ask (summary/diff)
        // that was approved/refused — history-backed, survives reloads.
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
          <div key={c.callId} className={`tool-node tool-${status}`}>
            <button
              type="button"
              className="tool-toggle"
              onClick={() => toggle(c.callId)}
              aria-expanded={open}
            >
              <ToolStatusIcon status={status} asking={asking} /> {c.name}
              {c.argsPreview.length > 0 && <span className="tool-args"> {c.argsPreview}</span>}
              {isTask && agent !== undefined && <span className="subagent-agent">@{agent}</span>}
              {asking && <span className="subagent-asking"> · needs approval</span>}
              {!asking && live && <span className="dim"> · working…</span>}
              {permVerdict !== undefined && <span className="dim"> · {permVerdict}</span>}
            </button>
            {open && isTask && child !== undefined ? (
              // Live child transcript (snapshot polling while the task
              // runs; stays reviewable after it finishes).
              <SubagentStream
                client={client}
                child={child}
                active={c.result === undefined || child.running}
              />
            ) : (
              open &&
              (c.result !== undefined || perm !== undefined || c.questions !== undefined) && (
                <div className={`tool-body ${c.result?.isError === true ? "tool-body-error" : ""}`}>
                  {perm !== undefined && (
                    <div className="ask-review">
                      <div className="ask-review-verdict">
                        {perm.status === "approved" ? (
                          <Check size={12} aria-hidden="true" />
                        ) : (
                          <X size={12} aria-hidden="true" />
                        )}
                        <span>permission {permVerdict}</span>
                      </div>
                      {perm.detail?.summary !== undefined && <div className="ask-review-summary">{perm.detail.summary}</div>}
                      {perm.detail?.diff !== undefined && <pre className="perm-diff">{perm.detail.diff}</pre>}
                    </div>
                  )}
                  {c.questions !== undefined ? (
                    // Retained Q&A review (question tool): pretty per-row
                    // question → answer instead of the model-facing sentence.
                    <div className="qa-review">
                      {c.questions.map((qa, i) => (
                        <div key={i} className="qa-item">
                          <div className="qa-q">
                            {qa.header !== undefined && <span className="qa-header">[{qa.header}] </span>}
                            {qa.question}
                          </div>
                          {qa.answers.length > 0 ? (
                            qa.answers.map((a) => (
                              <div key={a} className="qa-a">
                                <Check size={12} aria-hidden="true" />
                                <span>{a}</span>
                              </div>
                            ))
                          ) : (
                            <div className="qa-a qa-a-unanswered">· unanswered</div>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    c.result?.content
                  )}
                </div>
              )
            )}
          </div>
        );
      })}
    </div>
  );
}
