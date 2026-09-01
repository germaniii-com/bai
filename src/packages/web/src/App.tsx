import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { BaiClient, followGlobal, followSession } from "@bai/api/client";
import type { Message, Session } from "@bai/shared";
import { applyEvent, messageText, thinkingText } from "./state";
import { useProviders } from "./use-providers";
import { SettingsNav, SettingsPane } from "./settings";
import { ModelPicker } from "./model-picker";

/**
 * Master-rail sections. Workspace/Image/Video are Phase 3/5 placeholders —
 * the rail renders them disabled (same stance as the TUI's placeholder
 * views); only chat and settings are reachable.
 */
type Section = "chat" | "workspace" | "image" | "video" | "settings";

/**
 * Two-level navigation, mobile-first: master icon rail (workbenches +
 * settings) → contextual nested panel (sessions for chat, General +
 * providers for settings) → main pane. Provider/account state is shared
 * with the settings pane and refreshes live from the firehose — changes
 * made in the TUI (ctrl+p) or on the phone appear here without a reload.
 */
export function App() {
  const client = useMemo(
    () => new BaiClient({ baseURL: window.location.origin }),
    [],
  );
  const [section, setSection] = useState<Section>("chat");
  const [settingsProviderId, setSettingsProviderId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [active, setActive] = useState<Session | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [runActive, setRunActive] = useState(false);
  const [sentPending, setSentPending] = useState(false);
  const streamCtrl = useRef<AbortController | null>(null);
  const { list, refresh: refreshProviders, fetching: providersFetching } = useProviders(client);
  // Default model from config — a tiny startup fetch so the header's model
  // button shows the real default before the (heavy, on-demand) provider
  // list ever loads. Same pattern as the TUI's header label.
  const [configDefault, setConfigDefault] = useState<string | undefined>(undefined);

  const refreshConfig = useCallback(async () => {
    try {
      setConfigDefault((await client.getConfig()).models.default);
    } catch {
      // Advisory; the label falls back to the session model or stub/echo.
    }
  }, [client]);

  useEffect(() => {
    void refreshConfig();
  }, [refreshConfig]);

  // Waiting-for-reply indicator: from submit (optimistic) or run start until
  // the assistant's first text lands; run.finished clears it on errors too.
  const last = messages[messages.length - 1];
  const hasVisibleReply = last !== undefined && last.role === "assistant" && messageText(last).length > 0;
  useEffect(() => {
    if (runActive || hasVisibleReply) setSentPending(false);
  }, [runActive, hasVisibleReply]);
  const waiting = (sentPending || runActive) && !hasVisibleReply;

  const refreshSessions = useCallback(async () => {
    try {
      setSessions(await client.listSessions());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [client]);

  useEffect(() => {
    void refreshSessions();
  }, [refreshSessions]);

  // Live refresh of session state (e.g. model picked from another surface).
  useEffect(() => {
    const ctrl = new AbortController();
    void followGlobal(client, {
      signal: ctrl.signal,
      onEvent: (evt) => {
        if (evt.type === "session.updated") {
          const payload = evt.payload as { session?: Session };
          if (payload.session !== undefined) {
            setActive((current) => (current?.id === payload.session?.id ? payload.session ?? null : current));
          }
        }
        // Config changes from ANY surface (TUI, phone) update the header
        // label without a reload.
        if (evt.type === "config.updated") {
          void refreshConfig();
        }
      },
    });
    return () => ctrl.abort();
  }, [client, refreshConfig]);

  useEffect(() => {
    streamCtrl.current?.abort();
    if (active === null) {
      setMessages([]);
      setRunActive(false);
      return;
    }
    const ctrl = new AbortController();
    streamCtrl.current = ctrl;
    setMessages([]); // switching sessions: drop the old transcript immediately
    setRunActive(false); // a mid-run switch can't see the earlier run.started
    setSentPending(false);
    void (async () => {
      try {
        // Snapshot first, then follow the durable stream from its frontier.
        // followSession resumes from the cursor on drops (idle timeouts,
        // restarts) — replaying from 0 would duplicate the snapshot instead.
        const snap = await client.historySnapshot(active.id);
        if (ctrl.signal.aborted) return; // switched again mid-fetch — stale
        setMessages(snap.messages);
        // A run may already be draining (mid-run switch, or the snapshot was
        // taken right after our own submit) — its run.started predates the
        // cursor, so the snapshot is the only reliable signal.
        setRunActive(snap.runActive === true);
        await followSession(client, active.id, {
          from: snap.afterSeq,
          signal: ctrl.signal,
          onEvent: (evt) => {
            applyEvent(setMessages, evt);
            // Run lifecycle drives the waiting indicator (and surfaces
            // provider failures, which otherwise die silently).
            if (evt.type === "run.started") setRunActive(true);
            else if (evt.type === "run.finished") {
              setRunActive(false);
              if (evt.payload.error !== undefined) setError(`run failed: ${evt.payload.error}`);
            }
          },
          onDrop: () => {}, // silent reconnect; the cursor guarantees no gaps
        });
      } catch (err) {
        if (!ctrl.signal.aborted) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => ctrl.abort();
  }, [active, client]);

  // Stale-selection fallback: a provider deleted from another surface
  // (firehose provider.updated) resolves back to General.
  const providerExists = list?.providers.some((p) => p.id === settingsProviderId) ?? false;
  const effectiveSettingsId = providerExists ? settingsProviderId : null;

  const navigate = (next: Section): void => {
    if (next === "settings") {
      // On-demand + refetch on engagement (TUI ctrl+p parity): the provider
      // list never loads at startup, and every engagement pulls fresh data.
      void refreshProviders();
    }
    setSection(next);
  };

  const submit = async (): Promise<void> => {
    const text = draft.trim();
    if (text.length === 0) return;
    setDraft("");
    setSentPending(true);
    try {
      const session =
        active ?? (await client.createSession({ title: text.slice(0, 60), workbench: "chat" }));
      if (active === null) {
        setActive(session);
        void refreshSessions();
      }
      await client.submitPrompt(session.id, { text });
    } catch (err) {
      setSentPending(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="app">
      <MasterNav section={section} onNavigate={navigate} />

      <aside className="nested-panel">
        <div className="nested-title">{section === "settings" ? "Settings" : "Chat"}</div>
        {section === "chat" && (
          <>
            <button
              className="new-session"
              onClick={() => {
                void client.createSession({ workbench: "chat" }).then((s) => {
                  void refreshSessions();
                  setActive(s);
                });
              }}
            >
              + new session
            </button>
            <nav className="session-list">
              {sessions.map((s) => (
                <button
                  key={s.id}
                  className={active?.id === s.id ? "session active" : "session"}
                  onClick={() => setActive(s)}
                >
                  <span className="title">{s.title.length > 0 ? s.title : "(untitled)"}</span>
                  <span className="dim">{s.workbench}</span>
                </button>
              ))}
            </nav>
          </>
        )}
        {section === "settings" && (
          <SettingsNav
            list={list}
            fetching={providersFetching}
            selected={effectiveSettingsId}
            onSelect={setSettingsProviderId}
          />
        )}
      </aside>

      {section === "settings" ? (
        <main className="settings-pane">
          <SettingsPane
            client={client}
            list={list}
            refresh={refreshProviders}
            selectedId={effectiveSettingsId}
          />
        </main>
      ) : (
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
              void submit();
            }}
          >
            <input
              value={draft}
              placeholder={active === null ? "Start a chat…" : "Message…"}
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
      )}
    </div>
  );
}

/**
 * Master rail: brand mark, workbench sections (Workspace/Image/Video
 * disabled until their phases land), Settings pinned at the bottom.
 * Icons are inline SVG — no icon dependency.
 */
function MasterNav({ section, onNavigate }: { section: Section; onNavigate: (s: Section) => void }) {
  return (
      <nav className="master-nav" aria-label="Primary">
        {/* Same asset as the favicon (public/icon.svg) — one logo, one truth. */}
        <img src="/icon.svg" alt="bai" className="brand-mark" />
      <div className="master-items">
        <MasterItem section="chat" label="Chat" active={section === "chat"} onNavigate={onNavigate}>
          <Icon>
            <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
          </Icon>
        </MasterItem>
        <MasterItem section="workspace" label="Workspace" disabled onNavigate={onNavigate}>
          <Icon>
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </Icon>
        </MasterItem>
        <MasterItem section="image" label="Image Gen" disabled onNavigate={onNavigate}>
          <Icon>
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <polyline points="21 15 16 10 5 21" />
          </Icon>
        </MasterItem>
        <MasterItem section="video" label="Video Gen" disabled onNavigate={onNavigate}>
          <Icon>
            <path d="M23 7l-7 5 7 5V7z" />
            <rect x="1" y="5" width="15" height="14" rx="2" />
          </Icon>
        </MasterItem>
      </div>
      <div className="master-spacer" />
      <MasterItem section="settings" label="Settings" active={section === "settings"} onNavigate={onNavigate}>
        <Icon>
          <line x1="4" y1="21" x2="4" y2="14" />
          <line x1="4" y1="10" x2="4" y2="3" />
          <line x1="12" y1="21" x2="12" y2="12" />
          <line x1="12" y1="8" x2="12" y2="3" />
          <line x1="20" y1="21" x2="20" y2="16" />
          <line x1="20" y1="12" x2="20" y2="3" />
          <line x1="1" y1="14" x2="7" y2="14" />
          <line x1="9" y1="8" x2="15" y2="8" />
          <line x1="17" y1="16" x2="23" y2="16" />
        </Icon>
      </MasterItem>
    </nav>
  );
}

function MasterItem({
  section,
  label,
  active = false,
  disabled = false,
  onNavigate,
  children,
}: {
  section: Section;
  label: string;
  active?: boolean;
  disabled?: boolean;
  onNavigate: (s: Section) => void;
  children: ReactNode;
}) {
  const className = disabled ? "master-item" : active ? "master-item active" : "master-item";
  if (disabled) {
    // Phase placeholders: non-interactive, dimmed, "soon" badge (the TUI's
    // PlaceholderView stance — D9 honesty).
    return (
      <button type="button" className={className} disabled title={`${label} — coming in a later phase`}>
        {children}
        <span className="nav-label">{label}</span>
        <span className="soon">soon</span>
      </button>
    );
  }
  return (
    <button
      type="button"
      className={className}
      aria-current={active ? "page" : undefined}
      onClick={() => onNavigate(section)}
    >
      {children}
      <span className="nav-label">{label}</span>
    </button>
  );
}

/** Stroke icon wrapper — inherits currentColor, sized by CSS. */
function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      className="nav-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
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
