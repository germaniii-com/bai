import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BaiClient, followGlobal, followSession } from "@bai/api/client";
import type { Message, Session } from "@bai/shared";
import { applyEvent, messageText } from "./state";
import { useProviders } from "./use-providers";
import { Settings } from "./settings";
import { ModelPicker } from "./model-picker";

type View = "chat" | "settings";

/**
 * Sessions sidebar + chat pane + settings, mobile-first. Provider/account
 * state is shared with the settings view and refreshes live from the
 * firehose — changes made in the TUI (ctrl+p) or on the phone appear here
 * without a reload.
 */
export function App() {
  const client = useMemo(
    () => new BaiClient({ baseURL: window.location.origin }),
    [],
  );
  const [view, setView] = useState<View>("chat");
  const [sessions, setSessions] = useState<Session[]>([]);
  const [active, setActive] = useState<Session | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [runActive, setRunActive] = useState(false);
  const [sentPending, setSentPending] = useState(false);
  const streamCtrl = useRef<AbortController | null>(null);
  const { list, refresh: refreshProviders } = useProviders(client);

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
      },
    });
    return () => ctrl.abort();
  }, [client]);

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
      <aside className="sidebar">
        <div className="brand">
          bai <span className="dim">web</span>
        </div>
        <div className="nav">
          <button className={view === "chat" ? "nav-btn active" : "nav-btn"} onClick={() => setView("chat")}>
            chat
          </button>
          <button className={view === "settings" ? "nav-btn active" : "nav-btn"} onClick={() => setView("settings")}>
            providers
          </button>
        </div>
        <button
          className="new-session"
          onClick={() => {
            setView("chat");
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
              onClick={() => {
                setView("chat");
                setActive(s);
              }}
            >
              <span className="title">{s.title.length > 0 ? s.title : "(untitled)"}</span>
              <span className="dim">{s.workbench}</span>
            </button>
          ))}
        </nav>
      </aside>

      {view === "settings" ? (
        <main className="settings-pane">
          <Settings client={client} list={list} refresh={refreshProviders} />
        </main>
      ) : (
        <main className="chat">
          <div className="chat-head">
            {list !== null ? (
              <ModelPicker client={client} list={list} active={active} refreshProviders={refreshProviders} />
            ) : (
              <span className="dim">model: …</span>
            )}
            {list !== null && !list.providers.some((p) => p.connected && p.id !== "stub") && (
              <span className="hint">no provider connected — add one under “providers”</span>
            )}
          </div>
          <div className="messages">
            {messages.length === 0 && !waiting && <p className="dim empty">No messages yet.</p>}
            {messages.map((m) => (
              <div key={m.id} className={`message ${m.role}`}>
                <p>{messageText(m)}</p>
              </div>
            ))}
            {waiting && (
              <div className="message assistant">
                <div className="typing" aria-label="assistant is thinking" role="status">
                  <span className="dot" />
                  <span className="dot" />
                  <span className="dot" />
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
