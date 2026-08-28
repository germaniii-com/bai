import { Box, Text, useInput, useWindowSize } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import { followGlobal, followSession, type BaiClient } from "@bai/api/client";
import type { Message, ProviderListResponse, Session } from "@bai/shared";
import { ChatView } from "./views/chat";
import { SessionsView } from "./views/sessions";
import { PlaceholderView } from "./views/placeholder";
import { ProviderFlow } from "./components/provider-flow";
import { applyEvent } from "./state/sync";
import { currentModelLabel, needsSetup } from "./state/providers";

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
  const [providers, setProviders] = useState<ProviderListResponse | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [runActive, setRunActive] = useState(false);
  const dialogOpenRef = useRef(false);
  dialogOpenRef.current = dialogOpen;

  const refreshSessions = useCallback(async () => {
    try {
      setSessions(await client.listSessions());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [client]);

  const refreshProviders = useCallback(async () => {
    try {
      setProviders(await client.providers());
    } catch {
      // Provider list is advisory; the footer hint covers the empty case.
    }
  }, [client]);

  useEffect(() => {
    void refreshSessions();
    void refreshProviders();
  }, [refreshSessions, refreshProviders]);

  // Live refresh: account/config changes from ANY surface (TUI, web, phone)
  // update this one within a heartbeat — no restart, no manual refresh.
  useEffect(() => {
    const ctrl = new AbortController();
    void followGlobal(client, {
      signal: ctrl.signal,
      onEvent: (evt) => {
        if (evt.type === "provider.updated") void refreshProviders();
        if (evt.type === "config.updated") {
          void refreshProviders();
          void refreshSessions();
        }
        if (evt.type === "session.updated") {
          const payload = evt.payload as { session?: Session };
          if (payload.session !== undefined) {
            setActive((current) => (current?.id === payload.session?.id ? payload.session ?? null : current));
          }
        }
      },
    });
    return () => ctrl.abort();
  }, [client, refreshProviders, refreshSessions]);

  // Open the durable session stream whenever a session becomes active.
  useEffect(() => {
    if (active === null) {
      setRunActive(false);
      return;
    }
    const ctrl = new AbortController();
    setMessages([]);
    setRunActive(false); // a mid-run switch can't see the earlier run.started
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

  useInput((ch, key) => {
    if (!key.ctrl || dialogOpenRef.current) return;
    if (ch === "p") {
      setDialogOpen(true);
      void refreshProviders();
    } else if (ch === "s") setView("sessions");
    else if (ch === "g") setView("gallery");
    else if (ch === "j") setView("jobs");
    else if (ch === "o") setView("settings");
    else if (ch === "c" && key.return === false) {
      // ctrl+c handled by ink (exitOnCtrlC)
    }
  });

  const closeDialog = useCallback(() => {
    setDialogOpen(false);
    void refreshProviders();
    void refreshSessions();
  }, [refreshProviders, refreshSessions]);

  const modelLabel = currentModelLabel(active, providers);
  const setupHint = needsSetup(providers);

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
        <Text dimColor> · </Text>
        <Text color="magenta">{modelLabel}</Text>
      </Box>

      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        {dialogOpen && providers !== null ? (
          <ProviderFlow
            client={client}
            list={providers}
            active={active}
            onDone={closeDialog}
            onRefresh={() => void refreshProviders()}
          />
        ) : dialogOpen ? (
          <Text dimColor>loading providers…</Text>
        ) : (
          <>
            {view === "chat" && (
              <ChatView
                client={client}
                session={active}
                messages={messages}
                runActive={runActive}
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
          </>
        )}
      </Box>

      <Box paddingX={1} flexDirection="column">
        {error !== null && <Text color="red">error: {error}</Text>}
        {setupHint && <Text color="yellow">no provider connected · ctrl+p to set one up</Text>}
        <Text dimColor>
          ctrl+p providers · ctrl+s sessions · ctrl+g gallery · ctrl+j jobs · ctrl+o settings · ctrl+c quit
        </Text>
      </Box>
    </Box>
  );
}
