import { Box, Text, useInput, useWindowSize } from "ink";
import { useCallback, useEffect, useState } from "react";
import { followSession, type BaiClient } from "@bai/api/client";
import type { Message, Session } from "@bai/shared";
import { ChatView } from "./views/chat";
import { SessionsView } from "./views/sessions";
import { PlaceholderView } from "./views/placeholder";
import { applyEvent } from "./state/sync";

export type UiState = "chat" | "sessions" | "gallery" | "jobs" | "settings";

/**
 * Root component: view-state enum + focus routing. Overlay dialogs intercept
 * keys before global bindings (the Crush pattern); global bindings here are
 * ctrl-prefixed so the chat input never fights them.
 */
export function App({ client, version }: { client: BaiClient; version: string }) {
  const { rows } = useWindowSize();
  const [view, setView] = useState<UiState>("chat");
  const [sessions, setSessions] = useState<Session[]>([]);
  const [active, setActive] = useState<Session | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [error, setError] = useState<string | null>(null);

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

  // Open the durable session stream whenever a session becomes active.
  useEffect(() => {
    if (active === null) return;
    const ctrl = new AbortController();
    setMessages([]);
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

  useInput((ch, key) => {
    if (!key.ctrl) return;
    if (ch === "s") setView("sessions");
    else if (ch === "g") setView("gallery");
    else if (ch === "j") setView("jobs");
    else if (ch === "o") setView("settings");
    else if (ch === "c" && key.return === false) {
      // ctrl+c handled by ink (exitOnCtrlC)
    }
  });

  return (
    // Fixed root height = terminal viewport: views flex inside it and the
    // composer/footer stay pinned to the bottom regardless of content size.
    <Box flexDirection="column" height={rows > 0 ? rows : undefined}>
      <Box borderStyle="round" paddingX={1}>
        <Text bold color="cyan">
          bai
        </Text>
        <Text dimColor> v{version}</Text>
        <Text dimColor> · {active ? active.title || active.id : "no session"}</Text>
      </Box>

      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        {view === "chat" && (
          <ChatView
            client={client}
            session={active}
            messages={messages}
            onSessionCreated={(s) => {
              setActive(s);
              void refreshSessions();
            }}
          />
        )}
        {view === "sessions" && (
          <SessionsView
            client={client}
            sessions={sessions}
            onPick={(s) => {
              setActive(s);
              setView("chat");
            }}
            onChanged={refreshSessions}
          />
        )}
        {view === "gallery" && <PlaceholderView title="Gallery" phase={5} />}
        {view === "jobs" && <PlaceholderView title="Jobs" phase={5} />}
        {view === "settings" && <PlaceholderView title="Settings" phase={2} />}
      </Box>

      <Box paddingX={1} flexDirection="column">
        {error !== null && <Text color="red">error: {error}</Text>}
        <Text dimColor>
          ctrl+s sessions · ctrl+g gallery · ctrl+j jobs · ctrl+o settings · ctrl+c quit
        </Text>
      </Box>
    </Box>
  );
}
