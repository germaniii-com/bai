import { useEffect, useId, useRef, useState, type Dispatch, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent, type SetStateAction } from "react";
import { Check, Copy, FileText, FolderOpen, Gauge, GitFork, GraduationCap, Hourglass, Undo2, X, Zap } from "lucide-react";
import type { BaiClient } from "@bai/api/client";
import type { AgentInfo, AttachmentRef, Input, Message, ProviderListResponse, Session, SessionUsage } from "@bai/shared";
import { contextTracker, formatMentionRange, formatTokens, applyMention, expandMentionPaths, mentionDisplayToken, mentionLeaf, mentionTrigger, splitMentionQuery, splitMentions } from "@bai/shared";
import { messageText, revertBoundary, thinkingText, toolCalls, type ToolCallView } from "./state";
import { findChildForTask, type SubagentState } from "./state-subagents";
import { AskPanel, type PendingAsk } from "./ask-panel";
import { ModelPicker } from "./model-picker";
import { AgentPicker } from "./agent-picker";
import { SubagentStream } from "./subagent-stream";
import { Markdown } from "./markdown";
import { MentionPicker, type MentionEntry } from "./mention-picker";
import { AttachmentChips, AttachmentParts, AttachButton, ImageLightbox, QueuedAttachments, type MediaAttachment } from "./attachments";
import { FolderGlyph } from "./workspace";
import { Chevron, ToolStatusIcon } from "./icons";
import { IconButton } from "./ui";
import { Button, Chip, Field, Modal, Textarea } from "./components";

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
 * The context chip's tooltip — the exact numbers behind the compact label
 * (same token sum the tracker label uses: input + output + cache reads +
 * cache writes; reasoning excluded as an output subset).
 */
function contextChipTitle(usage: SessionUsage | null | undefined): string {
  if (usage === undefined || usage === null) return "";
  const tokens =
    (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
  const tokensKnown = usage.inputTokens !== undefined || usage.outputTokens !== undefined;
  if (!tokensKnown) {
    return usage.contextWindow !== undefined
      ? "Context usage unknown until the next model response (post-compaction)."
      : "";
  }
  if (usage.contextWindow === undefined) return `${formatTokens(tokens)} tokens in context`;
  const pct = Math.round((tokens / usage.contextWindow) * 100);
  return `${formatTokens(tokens)} of ${formatTokens(usage.contextWindow)} tokens (${pct}% of context window)`;
}

interface MentionUi {
  open: boolean;
  raw: string;
  pathQuery: string;
  results: MentionEntry[];
  selected: number;
  loading: boolean;
  error?: string;
}

const EMPTY_MENTION: MentionUi = { open: false, raw: "", pathQuery: "", results: [], selected: 0, loading: false };

/**
 * A user message's body: plain text runs plus `#file` mention chips. Chips
 * show the leaf (opencode parity), carry the full path in a hover tooltip,
 * and click through to the workspace file viewer when a root is available.
 */
function MessageText({
  text,
  root,
  onOpenFile,
}: {
  text: string;
  root?: string;
  onOpenFile?: (root: string, path: string) => void;
}) {
  const segments = splitMentions(text);
  if (!segments.some((s) => s.type === "mention")) return <p>{text}</p>;
  return (
    <p className="message-text">
      {segments.map((seg, i) => {
        if (seg.type === "text") return <span key={i}>{seg.text}</span>;
        const range = seg.from !== undefined ? { from: seg.from, ...(seg.to !== undefined ? { to: seg.to } : {}) } : undefined;
        const path = seg.path ?? "";
        const clickable = root !== undefined && root.length > 0 && onOpenFile !== undefined;
        return (
          <button
            key={i}
            type="button"
            className={clickable ? "mention-chip clickable" : "mention-chip"}
            title={`${path}${formatMentionRange(range)}`}
            disabled={!clickable}
            onClick={clickable ? () => onOpenFile?.(root, path) : undefined}
          >
            <FileText size={12} aria-hidden="true" />
            {`${mentionLeaf(path)}${formatMentionRange(range)}`}
          </button>
        );
      })}
    </p>
  );
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
  preferZdr,
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
   queuedInputs = [],
   sendingIds = [],
   onSendQueued,
   onCancelQueued,
   onEditQueued,
   onLearn,
   usage = null,
   agentLocked = false,
   onOpenWorkspace,
   workspaceRoot,
   onOpenFile,
   mentionPaths,
   setMentionPaths,
   attachments = [],
   onAddAttachments,
   onRemoveAttachment,
   attachmentsBusy = false,
  }: {
  client: BaiClient;
  /** Null until the first provider engagement fetch lands. */
  list: ProviderListResponse | null;
  active: Session | null;
  /** Default model from GET /api/config — keeps the picker label truthful. */
  configDefault?: string;
  /** Default agent (config agents.default) — keeps the agent label truthful. */
  configDefaultAgent?: string;
  /** config models.preferZdr — the model picker floats ZDR models first. */
  preferZdr?: boolean;
  /** Live agent catalog (App-owned; refreshed via agents.updated). */
  agents: AgentInfo[];
  refreshAgents: () => Promise<void>;
  refreshProviders: () => Promise<void>;
  providersFetching: boolean;
  messages: Message[];
  draft: string;
  setDraft: (value: string) => void;
  /** Composer `#file` alias map (leaf token → full workspace-relative path). */
  mentionPaths: Record<string, string>;
  setMentionPaths: Dispatch<SetStateAction<Record<string, string>>>;
  onSubmit: (text: string) => void;
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
  /**
   * Learn (hermes /learn parity, no slash command): open the learn modal and
   * submit the standards-guided learn request as a normal user turn in THIS
   * session (empty request = distill this conversation). Undefined hides the
   * chip (draft state — the Skills page covers fresh learns).
   */
  onLearn?: (request: string) => void;
  /** The session's latest provider-reported usage — the context tracker chip. */
  usage?: SessionUsage | null;
  /**
   * Pin the agent display (webui Chat section): the chat agent is pinned
   * server-side at session creation / next message, so the picker is
   * replaced by a static "agent: chat" chip. The Workspace section keeps
   * the live picker.
   */
  agentLocked?: boolean;
  /**
   * "Open workspace" action for workspace.create tool nodes: navigate to the
   * workspace route for the created folder (App's selectWorkspace).
   */
  onOpenWorkspace?: (wsPath: string) => void;
  /**
   * Absolute workspace root for `#file` mentions. Set only in the Workspace
   * section (a code session's cwd or the viewed workspace) — chat sessions
   * have no root, so the picker stays off there (opencode2's project-scoped
   * completion).
   */
  workspaceRoot?: string;
  /**
   * Open a `#file` mention chip's file in the web workspace viewer. Receives
   * the owning workspace root (a code session's cwd) and the workspace-
   * relative path.
   */
  onOpenFile?: (root: string, path: string) => void;
  /** Pending attachments for the next send (uploaded; shown as chips). */
  attachments?: AttachmentRef[];
  /** Files picked from the OS dialog — App uploads and appends refs. */
  onAddAttachments?: (files: File[]) => void;
  onRemoveAttachment?: (id: string) => void;
  /** True while an upload is in flight (disables the `+` button). */
  attachmentsBusy?: boolean;
}) {
  // Two-phase revert display: everything at/after the boundary disappears
  // and a small banner offers the restore (messages come back until the
  // next prompt commits the deletion server-side).
  const boundary = revertBoundary(active);
  const boundaryIdx = boundary === undefined ? -1 : messages.findIndex((m) => m.id === boundary);
  const visible = boundaryIdx < 0 ? messages : messages.slice(0, boundaryIdx);
  const revertedCount = boundaryIdx < 0 ? 0 : messages.length - boundaryIdx;
  const [learnOpen, setLearnOpen] = useState(false);
  // Context tracker readout (shared/src/display.ts — TUI parity): undefined
  // until the session's first usage lands.
  const tracker = contextTracker(usage);
  // Mentions resolve against the session's workspace root (a code session).
  const openFileRoot = active?.cwd ?? workspaceRoot;

  // ---- `#file` mention picker (opencode2 completion) --------------------
  // The draft's `#token` is derived from the input cursor; matches come from
  // the workspace-scoped find endpoint. Only available with a workspaceRoot
  // (the Workspace section) — chat sessions have no root.
  const [mention, setMention] = useState<MentionUi>(EMPTY_MENTION);
  const [cursor, setCursor] = useState(0);
  const mentionReq = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  // Maximized image preview (composer thumbnails + transcript thumbnails).
  const [lightbox, setLightbox] = useState<MediaAttachment | null>(null);
  // Composer file drop — enabled only when an attach handler is provided
  // (chat section). A depth counter avoids flicker as the pointer crosses
  // child elements inside the form.
  const dragDepth = useRef(0);
  const [dropActive, setDropActive] = useState(false);
  const canDropFiles = onAddAttachments !== undefined;
  const onComposerDragEnter = (e: ReactDragEvent<HTMLFormElement>): void => {
    if (!canDropFiles || !e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    dragDepth.current += 1;
    setDropActive(true);
  };
  const onComposerDragOver = (e: ReactDragEvent<HTMLFormElement>): void => {
    if (!canDropFiles || !e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };
  const onComposerDragLeave = (): void => {
    if (!canDropFiles) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDropActive(false);
  };
  const onComposerDrop = (e: ReactDragEvent<HTMLFormElement>): void => {
    if (!canDropFiles) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDropActive(false);
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length > 0) onAddAttachments?.(files);
  };

  // External seeds (revert/fork/edit) replace the draft out from under the
  // tracked cursor — keep it in range so mention detection isn't confused.
  useEffect(() => {
    if (cursor > draft.length) setCursor(draft.length);
  }, [cursor, draft.length]);

  useEffect(() => {
    if (workspaceRoot === undefined || workspaceRoot.length === 0) {
      setMention((m) => (m.open ? EMPTY_MENTION : m));
      return;
    }
    const at = Math.max(0, Math.min(cursor, draft.length));
    const trigger = mentionTrigger(draft, at);
    if (trigger === null) {
      setMention((m) => (m.open ? EMPTY_MENTION : m));
      return;
    }
    const { pathQuery } = splitMentionQuery(trigger.raw);
    setMention((m) =>
      m.open && m.raw === trigger.raw
        ? m
        : { open: true, raw: trigger.raw, pathQuery, results: [], selected: 0, loading: true },
    );
    const token = ++mentionReq.current;
    const handle = setTimeout(() => {
      void client
        .findFiles(workspaceRoot, pathQuery, 20)
        .then((found) => {
          if (token !== mentionReq.current) return;
          setMention((m) =>
            m.open && m.raw === trigger.raw ? { ...m, results: found.results, selected: 0, loading: false } : m,
          );
        })
        .catch((err: unknown) => {
          if (token !== mentionReq.current) return;
          setMention((m) =>
            m.open && m.raw === trigger.raw
              ? { ...m, results: [], loading: false, error: err instanceof Error ? err.message : String(err) }
              : m,
          );
        });
    }, 150);
    return () => clearTimeout(handle);
  }, [draft, cursor, workspaceRoot, client]);

  const moveMention = (delta: number): void => {
    setMention((m) => {
      const count = m.results.length;
      if (count === 0) return m;
      return { ...m, selected: ((m.selected + delta) % count + count) % count };
    });
  };

  const pickMention = (entry: MentionEntry): void => {
    const at = Math.max(0, Math.min(cursor, draft.length));
    const trigger = mentionTrigger(draft, at);
    if (trigger === null) {
      setMention(EMPTY_MENTION);
      return;
    }
    if (entry.type === "dir") {
      // Drilling in keeps the full path so the query filters inside it.
      const next = applyMention(draft, at, trigger, entry);
      setDraft(next.text);
      setCursor(next.cursor);
      requestAnimationFrame(() => inputRef.current?.setSelectionRange(next.cursor, next.cursor));
      return;
    }
    // Files show the shortest unique leaf; the full path rides the map.
    const token = mentionDisplayToken(entry.path, Object.keys(mentionPaths));
    const range = splitMentionQuery(trigger.raw).range;
    const next = applyMention(draft, at, trigger, { path: token, type: "file" }, range);
    setMentionPaths((paths) => ({ ...paths, [token]: entry.path }));
    setDraft(next.text);
    setCursor(next.cursor);
    setMention(EMPTY_MENTION);
    requestAnimationFrame(() => inputRef.current?.setSelectionRange(next.cursor, next.cursor));
  };

  const onMentionKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (!mention.open) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      moveMention(1);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      moveMention(-1);
      return;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      const entry = mention.results[mention.selected];
      if (entry !== undefined) {
        e.preventDefault();
        pickMention(entry);
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setMention(EMPTY_MENTION);
    }
  };

  return (
    <main className="chat">
      <div className="messages" role="log" aria-label="Conversation" aria-live="polite" aria-relevant="additions text">
        {visible.length === 0 && revertedCount === 0 && !waiting && <p className="dim empty">No messages yet.</p>}
        {visible.map((m) => (
           <article key={m.id} className={`message ${m.role}`} aria-label={`${m.role === "user" ? "You" : "Assistant"} message`}>
            {m.role === "assistant" && thinkingText(m).length > 0 && <ThinkingNode text={thinkingText(m)} />}
            {m.role === "assistant" && toolCalls(m).length > 0 && (
              <ToolNodes calls={toolCalls(m)} subagents={subagents} client={client} onOpenWorkspace={onOpenWorkspace} />
            )}
            {/* Attachments render ABOVE the message body (composer-hub order). */}
            {m.role === "user" && <AttachmentParts message={m} client={client} onOpenImage={setLightbox} />}
            {/* Assistant bodies render markdown; user input is text + `#file` chips. */}
            {m.role === "assistant" ? (
              <Markdown text={messageText(m)} />
            ) : (
              <MessageText
                text={messageText(m)}
                {...(openFileRoot !== undefined ? { root: openFileRoot } : {})}
                {...(onOpenFile !== undefined ? { onOpenFile } : {})}
              />
            )}
            {m.role === "user" && (onForkMessage !== undefined || onRevertMessage !== undefined) && (
              <UserMessageActions message={m} onFork={onForkMessage} onRevert={onRevertMessage} />
            )}
           </article>
        ))}
        {revertedCount > 0 && onRestoreRevert !== undefined && (
          <div className="revert-banner" role="status">
            <Undo2 size={13} aria-hidden="true" />
            <span>
              {revertedCount} message{revertedCount === 1 ? "" : "s"} reverted — sending a new message commits this
            </span>
            <Button size="sm" variant="outline" onClick={onRestoreRevert} disabled={revertBusy === true}>
              Restore
            </Button>
          </div>
        )}
        {/* Queued messages (message-queue feature): admitted inputs waiting
            for the session to go idle — future transcript entries, rendered
            dimmed with a queued chip and per-node actions (opencode's
            followup-dock actions, Cursor's queued-node placement). A
            send-now flip re-chips the node "sending…" IN PLACE (no
            vanish-then-reshow gap) until it promotes into a real message. */}
        {queuedInputs.map((input) => {
          const sending = sendingIds.includes(input.id);
          return (
            <article key={input.id} className="message user queued" aria-label={sending ? "Sending message" : "Queued message"}>
              <QueuedAttachments input={input} client={client} onOpenImage={setLightbox} />
              <MessageText
                text={input.payload.text}
                {...(openFileRoot !== undefined ? { root: openFileRoot } : {})}
                {...(onOpenFile !== undefined ? { onOpenFile } : {})}
              />
              <div className="queued-row">
                <Chip className={sending ? "sending" : "warning"}>
                  <Hourglass size={11} aria-hidden="true" /> {sending ? "sending…" : "queued"}
                </Chip>
                <span className="queued-spacer" />
                {!sending && onSendQueued !== undefined && (
                  <Button size="sm" variant="secondary" onClick={() => onSendQueued(input)}>
                    Send now
                  </Button>
                )}
                {!sending && onEditQueued !== undefined && (
                  <Button size="sm" variant="secondary" onClick={() => onEditQueued(input)}>
                    Edit
                  </Button>
                )}
                {!sending && onCancelQueued !== undefined && (
                  <Button size="sm" variant="ghost" onClick={() => onCancelQueued(input)}>
                    Cancel
                  </Button>
                )}
              </div>
            </article>
          );
        })}
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
      {error !== null && <div className="error" role="alert">{error}</div>}
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
        className={dropActive ? "composer drag-over" : "composer"}
        onDragEnter={onComposerDragEnter}
        onDragOver={onComposerDragOver}
        onDragLeave={onComposerDragLeave}
        onDrop={onComposerDrop}
        onSubmit={(e) => {
          e.preventDefault();
          // Leaf mention tokens expand to full paths for the server.
          onSubmit(expandMentionPaths(draft, mentionPaths).trim());
        }}
      >
        {mention.open && (
          <MentionPicker
            results={mention.results}
            selected={mention.selected}
            loading={mention.loading}
            query={mention.pathQuery}
            {...(mention.error !== undefined ? { error: mention.error } : {})}
            onPick={pickMention}
            onHover={(i) => setMention((m) => ({ ...m, selected: i }))}
          />
        )}
        {onRemoveAttachment !== undefined && (
          <AttachmentChips
            attachments={attachments}
            client={client}
            onRemove={onRemoveAttachment}
            onOpenImage={setLightbox}
            disabled={attachmentsBusy}
          />
        )}
        <div className="composer-input-row">
          <input
            ref={inputRef}
            value={draft}
            placeholder={active === null ? startPlaceholder : "Message…"}
            onChange={(e) => {
              setDraft(e.target.value);
              setCursor(e.target.selectionStart ?? e.target.value.length);
            }}
            onKeyDown={onMentionKeyDown}
            onClick={(e) => {
              if (!mention.open) setCursor(e.currentTarget.selectionStart ?? draft.length);
            }}
            onKeyUp={(e) => {
              if (!mention.open) setCursor(e.currentTarget.selectionStart ?? draft.length);
            }}
            aria-label="message"
          />
          {onAddAttachments !== undefined && <AttachButton onFiles={onAddAttachments} disabled={attachmentsBusy} />}
          {runActive && active !== null ? (
            // Stop replaces send while the model is responding; the partial
            // reply stays in history after the interrupt.
            <Button
              variant="danger"
              size="lg"
              onClick={() => void client.interrupt(active.id)}
              aria-label="stop generating"
            >
              Stop
            </Button>
          ) : (
            <Button type="submit" variant="primary" size="lg" disabled={draft.trim().length === 0}>
              Send
            </Button>
          )}
        </div>
        <div className="composer-row composer-status">
          {active !== null && typeof active.cwd === "string" && active.cwd.length > 0 ? (
            <Chip interactive hint={`${active.cwd} — switch workspace`} onClick={onSwitchWorkspace}>
              <FolderGlyph />
              <span className="chip-label">{hubContextLabel(active)}</span>
            </Chip>
          ) : (
            <Chip
              hint={active === null ? "Draft — the session is created with your first message" : undefined}
            >
              <FolderGlyph />
              <span className="chip-label">{hubContextLabel(active)}</span>
            </Chip>
          )}
          {queuedInputs.length > sendingIds.length && (
            // The queued indicator (message-queue feature): a count chip in
            // the hub status row — the nodes themselves live at the
            // transcript tail. Send-now flips don't count (they're leaving
            // the queue).
            <Chip className="warning" hint="Messages waiting in the queue">
              <Hourglass size={11} aria-hidden="true" />
              <span className="chip-label">{queuedInputs.length - sendingIds.length} queued</span>
            </Chip>
          )}
          {tracker !== undefined && (
            // The context tracker (pi/opencode parity): the session's live
            // context usage as a static chip — `45k (23%)`, tone-shifted at
            // the 70/90% thresholds; the tooltip carries the exact numbers.
            <Chip
              className={tracker.tone !== "dim" ? tracker.tone : undefined}
              hint={contextChipTitle(usage)}
            >
              <Gauge size={11} aria-hidden="true" />
              <span className="chip-label">{tracker.label}</span>
            </Chip>
          )}
          <span className="composer-spacer" />
          {list !== null && !list.providers.some((p) => p.connected && p.id !== "stub") && (
            <span className="hint">no provider connected</span>
          )}
          {providersFetching && <span className="dim">updating…</span>}
          {onLearn !== undefined && (
            <Chip
              interactive
              hint="Learn a skill — distill a workflow, docs, or this conversation into a reusable skill"
              onClick={() => setLearnOpen(true)}
            >
              <GraduationCap size={11} aria-hidden="true" />
              <span className="chip-label">Learn</span>
            </Chip>
          )}
          {agentLocked ? (
            // Webui Chat section: the chat agent is pinned (creation + next
            // message) — a static chip replaces the picker. The Workspace
            // section keeps the live picker.
            <Chip hint="The Chat section always runs the chat agent — the all-in-one orchestrator">
              <span className="dim">agent</span>
              <span className="chip-label">chat</span>
            </Chip>
          ) : (
            <AgentPicker
              client={client}
              agents={agents}
              active={active}
              configDefaultAgent={configDefaultAgent}
              refreshAgents={refreshAgents}
            />
          )}
          <ModelPicker
            client={client}
            list={list}
            active={active}
            configDefault={configDefault}
            preferZdr={preferZdr}
            refreshProviders={refreshProviders}
          />
        </div>
      </form>
      {learnOpen && onLearn !== undefined && (
        <LearnModal
          onSubmitLearn={(request) => {
            setLearnOpen(false);
            onLearn(request);
          }}
          onClose={() => setLearnOpen(false)}
        />
      )}
      {lightbox !== null && <ImageLightbox attachment={lightbox} client={client} onClose={() => setLightbox(null)} />}
    </main>
  );
}

/**
 * The learn modal (hermes /learn parity, no slash command): describe what to
 * learn — sources (paths, URLs), requirements, or nothing to distill THIS
 * conversation. Submitting hands the request to the caller, which composes
 * the standards-guided learn prompt and sends it as a normal user turn.
 * Built on the shared <Modal> (overlay/esc/backdrop/focus-trap included).
 */
function LearnModal({
  onSubmitLearn,
  onClose,
}: {
  onSubmitLearn: (request: string) => void;
  onClose: () => void;
}) {
  const [request, setRequest] = useState("");
  return (
    <Modal
      open
      onClose={onClose}
      title={
        <>
          <GraduationCap size={14} aria-hidden="true" style={{ verticalAlign: "-2px" }} /> Learn a skill
        </>
      }
      ariaLabel="Learn a skill"
    >
      <form
        className="agent-form"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmitLearn(request.trim());
        }}
      >
        <Field label="What would you like to learn?" hint="(leave empty to distill this conversation)">
          <Textarea
            value={request}
            onChange={(e) => setRequest(e.target.value)}
            rows={5}
            autoFocus
            maxLength={8000}
            placeholder="e.g. the release workflow we just did — or ~/projects/acme-sdk, focus on the auth flow — or https://docs.example.com/api"
          />
        </Field>
        <p className="section-lede">
          The agent gathers the sources with its tools and saves the skill via skills.save — it shows up on the
          Skills page when done.
        </p>
        <div className="agents-actions">
          <Button type="submit" variant="primary">
            Learn it
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Modal>
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
       <IconButton
         className="message-action"
         label={copied ? "Copied" : "Copy message"}
         hint={copied ? "Copied" : "Copy message"}
         onClick={() => void copy()}
       >
         {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
       </IconButton>
      {onFork !== undefined && (
         <IconButton
           className="message-action"
           label="Fork from here"
           hint="Fork from here — new session with the earlier history, composer prefilled"
           onClick={() => onFork(message)}
         >
           <GitFork size={13} aria-hidden="true" />
         </IconButton>
      )}
      {onRevert !== undefined && (
         <IconButton
           className="message-action"
           label="Revert to here"
           hint="Revert — undo this message, everything after it, and their file changes"
           onClick={() => onRevert(message)}
         >
           <Undo2 size={13} aria-hidden="true" />
         </IconButton>
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
  const bodyId = useId();
  const lineCount = text.split("\n").length;
  return (
    <div className="thinking-node">
      <button
        type="button"
        className="thinking-toggle"
         onClick={() => setOpen((v) => !v)}
         aria-expanded={open}
         aria-controls={bodyId}
      >
        <Chevron open={open} />
        <span>
          thought ({lineCount} line{lineCount === 1 ? "" : "s"})
        </span>
      </button>
      {open && (
         <div id={bodyId} className="thinking-body">
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
  onOpenWorkspace,
}: {
  calls: ToolCallView[];
  subagents?: SubagentState;
  client: BaiClient;
  /** "Open workspace" action for workspace.create results (App navigation). */
  onOpenWorkspace?: (wsPath: string) => void;
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
        // workspace.create success: an inline "Open workspace" action on the
        // row — the result's registered folder path navigates to the
        // workspace route (App's selectWorkspace). Only with a landed,
        // non-error result (nothing to open before that).
        const canOpenWs =
          onOpenWorkspace !== undefined &&
          c.name === "workspace.create" &&
          typeof c.workspace === "string" &&
          c.result !== undefined &&
          c.result.isError !== true;
        return (
          <div key={c.callId} className={`tool-node tool-${status}${canOpenWs ? " tool-node-has-action" : ""}`}>
            <button
              type="button"
              className="tool-toggle"
              onClick={() => toggle(c.callId)}
              aria-expanded={open}
              aria-controls={`tool-body-${c.callId}`}
            >
              <ToolStatusIcon status={status} asking={asking} />
              {/* Skill loads get their own glyph — scannable among the
                  other tool calls (the digest carries the skill name). */}
              {c.name.startsWith("skills.") && <Zap size={12} aria-hidden="true" className="tool-glyph skill" />}{" "}
              {c.name}
              {c.argsPreview.length > 0 && <span className="tool-args"> {c.argsPreview}</span>}
              {isTask && agent !== undefined && <span className="subagent-agent">@{agent}</span>}
              {asking && <span className="subagent-asking"> · needs approval</span>}
              {!asking && live && <span className="dim"> · working…</span>}
              {permVerdict !== undefined && <span className="dim"> · {permVerdict}</span>}
            </button>
            {canOpenWs && (
              <button
                type="button"
                className="tool-open-ws"
                onClick={() => onOpenWorkspace(c.workspace as string)}
                aria-label={`Open workspace ${c.workspace}`}
              >
                <FolderOpen size={12} aria-hidden="true" />
                Open workspace
              </button>
            )}
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
                 <div id={`tool-body-${c.callId}`} className={`tool-body ${c.result?.isError === true ? "tool-body-error" : ""}`}>
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
