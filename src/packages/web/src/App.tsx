import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BaiClient, followSession } from "@bai/api/client";
import type { Message, Session } from "@bai/shared";
import { applyEvent, messageText } from "./state";

/**
 * Phase-0 shell: sessions sidebar + chat pane, mobile-first. The sync engine
 * (bootstrap → firehose reducers → session cursor stream → hello healing)
 * hardens in Phase 2; the session stream is already cursor-based.
 */
export function App() {
  const client = useMemo(
    () => new BaiClient({ baseURL: window.location.origin }),
    [],
  );
  const [sessions, setSessions] = useState<Session[]>([]);
  const [active, setActive] = useState<Session | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const streamCtrl = useRef<AbortController | null>(null);

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

  useEffect(() => {
    streamCtrl.current?.abort();
    if (active === null) {
      setMessages([]);
      return;
    }
    const ctrl = new AbortController();
    streamCtrl.current = ctrl;
    setMessages([]); // switching sessions: drop the old transcript immediately
    void (async () => {
      try {
        // Snapshot first, then follow the durable stream from its frontier.
        // followSession resumes from the cursor on drops (idle timeouts,
        // restarts) — replaying from 0 would duplicate the snapshot instead.
        const snap = await client.historySnapshot(active.id);
        if (ctrl.signal.aborted) return; // switched again mid-fetch — stale
        setMessages(snap.messages);
        await followSession(client, active.id, {
          from: snap.afterSeq,
          signal: ctrl.signal,
          onEvent: (evt) => applyEvent(setMessages, evt),
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
    try {
      const session =
        active ?? (await client.createSession({ title: text.slice(0, 60), workbench: "chat" }));
      if (active === null) {
        setActive(session);
        void refreshSessions();
      }
      await client.submitPrompt(session.id, { text });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          bai <span className="dim">web</span>
        </div>
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
      </aside>

      <main className="chat">
        <div className="messages">
          {messages.length === 0 && <p className="dim empty">No messages yet.</p>}
          {messages.map((m) => (
            <div key={m.id} className={`message ${m.role}`}>
              <p>{messageText(m)}</p>
            </div>
          ))}
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
          <button type="submit" disabled={draft.trim().length === 0}>
            send
          </button>
        </form>
      </main>
    </div>
  );
}
