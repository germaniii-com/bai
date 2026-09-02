import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import { followGlobal, followSession, type BaiClient } from "@bai/api/client";
import type { Message, ProviderListResponse, Session } from "@bai/shared";
import { ChatView } from "./views/chat";
import { SessionsView } from "./views/sessions";
import { PlaceholderView } from "./views/placeholder";
import { AgentManager } from "./views/agent-manager";
import { ProviderFlow } from "./components/provider-flow";
import { applyEvent } from "./state/sync";
import { currentModelLabel, currentProviderId, needsSetup } from "./state/providers";

export type UiState = "chat" | "sessions" | "gallery" | "jobs" | "settings";

/**
 * Input mode, vim-style. NORMAL (default): vim motions over the transcript
 * plus the ctrl command family. INPUT: plain typing into the composer —
 * app-level ctrl commands are dead there (editing chords ctrl+w/j/k and the
 * ctrl+c safety hatch excepted). esc always returns to NORMAL.
 */
export type Mode = "normal" | "input";

/**
 * Which overlay the ctrl-bindings opened; ProviderFlow starts at this step.
 * ctrl+p → full wizard, ctrl+a → current provider's accounts, ctrl+l → flat
 * model list across connected providers.
 */
type DialogOpen =
  | { kind: "providers" }
  | { kind: "accounts"; providerId: string }
  | { kind: "all-models" }
  | { kind: "agents" };

/**
 * Root component: view-state enum + focus routing. Overlay dialogs intercept
 * keys before global bindings (the Crush pattern); global bindings here are
 * ctrl-prefixed so the chat input never fights them. ctrl+c and esc-as-back
 * are handled before the dialog defer — ctrl+c must stay global (quit hatch)
 * and esc only means "back" outside dialogs and chat.
 */
export function App({ client, version }: { client: BaiClient; version: string }) {
  const { rows } = useWindowSize();
  const { exit } = useApp();
  const [view, setView] = useState<UiState>("chat");
  const [sessions, setSessions] = useState<Session[]>([]);
  const [active, setActive] = useState<Session | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [providers, setProviders] = useState<ProviderListResponse | null>(null);
  const [providersFetching, setProvidersFetching] = useState(false);
  const [configDefault, setConfigDefault] = useState<string | undefined>(undefined);
  const [dialog, setDialog] = useState<DialogOpen | null>(null);
  const [runActive, setRunActive] = useState(false);
  // Agent/tool catalog version — bumped by live events so the manager
  // dialog refetches while open (file edits from any surface).
  const [catalogTick, setCatalogTick] = useState(0);
  // Input mode (NORMAL default). App owns it because it gates the global
  // ctrl bindings; ChatView switches it via onEnterInput/onExitInput.
  const [mode, setMode] = useState<Mode>("normal");
  const dialogOpenRef = useRef(false);
  dialogOpenRef.current = dialog !== null;
  // ctrl+c double-press arming (mirrors the chat composer's esc arming):
  // first press arms, second interrupts a running drain or quits.
  const [quitArmed, setQuitArmed] = useState(false);
  const quitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // On-demand provider list: fetched on first ctrl+p/ctrl+l/ctrl+a, kept
  // fresh afterwards.
  const providersLoadedRef = useRef(false);
  providersLoadedRef.current = providers !== null;

  const refreshSessions = useCallback(async () => {
    try {
      setSessions(await client.listSessions());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [client]);

  const refreshProviders = useCallback(async () => {
    setProvidersFetching(true);
    try {
      setProviders(await client.providers());
    } catch {
      // Provider list is advisory; the footer hint covers the empty case.
    } finally {
      setProvidersFetching(false);
    }
  }, [client]);

  // Tiny startup fetch: the header's default-model label comes from config
  // (no catalog touch, no models.dev refresh). The full provider list —
  // 200+ providers, thousands of models — loads only when ctrl+p needs it.
  const refreshConfig = useCallback(async () => {
    try {
      setConfigDefault((await client.getConfig()).models.default);
    } catch {
      // Advisory; the label falls back to the session model or stub/echo.
    }
  }, [client]);

  useEffect(() => {
    void refreshSessions();
    void refreshConfig();
  }, [refreshSessions, refreshConfig]);

  // ctrl+c arming expires like the composer's esc arming — a stale press
  // must never quit (or interrupt) a later session of events.
  const disarmQuit = useCallback(() => {
    setQuitArmed(false);
    if (quitTimer.current !== null) {
      clearTimeout(quitTimer.current);
      quitTimer.current = null;
    }
  }, []);
  useEffect(() => disarmQuit, [disarmQuit]); // unmount

  // ctrl+a: accounts of the provider backing the current model. Needs the
  // provider list (on-demand, like ctrl+p); an unknown/stub provider falls
  // back to the full wizard.
  const openAccounts = useCallback(async () => {
    try {
      const list = providers ?? (await client.providers());
      setProviders(list);
      const providerId = currentProviderId(active, list, configDefault);
      setDialog(
        list.providers.some((p) => p.id === providerId)
          ? { kind: "accounts", providerId }
          : { kind: "providers" },
      );
    } catch {
      // Advisory; the footer hint covers the empty case.
    }
  }, [providers, client, active, configDefault]);

  // Live refresh: account/config changes from ANY surface (TUI, web, phone)
  // update this one within a heartbeat — no restart, no manual refresh.
  // The provider list itself stays on-demand: events refresh it only after
  // it has been loaded once (i.e. the user engaged the picker).
  useEffect(() => {
    const ctrl = new AbortController();
    void followGlobal(client, {
      signal: ctrl.signal,
      onEvent: (evt) => {
        // Universal healing (§8.4): the firehose's first frame on every
        // (re)connect refreshes the snapshots — live events missed during a
        // drop can't linger.
        if (evt.type === "server.hello") {
          void refreshSessions();
          void refreshConfig();
          if (providersLoadedRef.current) void refreshProviders();
        }
        if (evt.type === "provider.updated") {
          if (providersLoadedRef.current) void refreshProviders();
        }
        if (evt.type === "config.updated") {
          void refreshConfig();
          if (providersLoadedRef.current) void refreshProviders();
          void refreshSessions();
        }
        if (evt.type === "agents.updated" || evt.type === "tools.updated") {
          setCatalogTick((t) => t + 1);
        }
        if (evt.type === "session.updated") {
          const payload = evt.payload as { session?: Session };
          if (payload.session !== undefined) {
            const updated = payload.session;
            setActive((current) => (current?.id === updated.id ? updated : current));
            // Server-side title changes (fallback + LLM refine) must reach
            // the sessions list without a refetch.
            setSessions((list) => list.map((s) => (s.id === updated.id ? updated : s)));
          }
        }
      },
    });
    return () => ctrl.abort();
  }, [client, refreshProviders, refreshSessions, refreshConfig]);

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

  // ctrl+c is global in BOTH modes (even over dialogs — dialogs ignore ctrl
  // keys): first press arms, second interrupts a running drain or quits.
  // exitOnCtrlC is off (index.tsx), so this is the only ctrl+c path. Kept on
  // its own always-active handler — the safety hatch never mode-gates.
  useInput((ch, key) => {
    if (!(key.ctrl && ch === "c")) return;
    if (quitArmed) {
      disarmQuit();
      if (runActive && active !== null) void client.interrupt(active.id);
      else exit();
    } else {
      setQuitArmed(true);
      if (quitTimer.current !== null) clearTimeout(quitTimer.current);
      quitTimer.current = setTimeout(disarmQuit, 2500);
    }
  });

  // NORMAL-mode globals: esc-as-back + the ctrl command family. Gated off in
  // INPUT mode — typing must never trigger app commands (the point of the
  // mode split). Dialogs handle their own keys and are only reachable from
  // NORMAL anyway (they open via ctrl chords).
  useInput((ch, key) => {
    // esc is "back": out of any non-chat view. Dialogs handle their own esc
    // (per-level back-out) and chat uses it for focus/interrupt/mode-exit.
    if (key.escape && view !== "chat" && !dialogOpenRef.current) {
      setView("chat");
      return;
    }
    if (!key.ctrl || dialogOpenRef.current) return;
    if (ch === "p") {
      setDialog({ kind: "providers" });
      void refreshProviders();
    } else if (ch === "l") {
      // Flat model picker across connected providers — no provider step.
      setDialog({ kind: "all-models" });
      void refreshProviders();
    } else if (ch === "a") {
      void openAccounts();
    } else if (ch === "e") {
      setDialog({ kind: "agents" });
    } else if (ch === "s") setView("sessions");
    else if (ch === "g") setView("gallery");
    else if (ch === "o") setView("settings");
  }, { isActive: mode === "normal" });

  const closeDialog = useCallback(() => {
    setDialog(null);
    void refreshProviders();
    void refreshSessions();
  }, [refreshProviders, refreshSessions]);

  const modelLabel = currentModelLabel(active, providers, configDefault);
  const setupHint = needsSetup(providers);
  // Exact footer line count — ChatView needs it to compute the thinking
  // spinner's terminal row for click-to-toggle hit testing.
  const footerLines =
    1 + (error !== null ? 1 : 0) + (setupHint ? 1 : 0) + (quitArmed ? 1 : 0);

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
        <Text dimColor> · </Text>
        <Text bold color={mode === "normal" ? "cyan" : "green"}>
          {mode === "normal" ? "NORMAL" : "INPUT"}
        </Text>
      </Box>

      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        {dialog !== null && dialog.kind !== "agents" && providers !== null ? (
          // Re-open with the list already loaded: render it instantly and
          // surface the engagement refetch as a hint — the dialog state
          // survives and the list updates in place when the fetch lands.
          // ProviderFlow unmounts between openings, so its step state
          // restarts at `initialStep` each time.
          <Box flexDirection="column">
            {providersFetching && <Text dimColor>updating providers…</Text>}
            <ProviderFlow
              client={client}
              list={providers}
              active={active}
              initialStep={dialog}
              onDone={closeDialog}
              onRefresh={() => void refreshProviders()}
            />
          </Box>
        ) : dialog !== null ? (
          dialog.kind === "agents" ? (
            <AgentManager client={client} active={active} catalogTick={catalogTick} onDone={closeDialog} />
          ) : (
            <Text dimColor>loading providers…</Text>
          )
        ) : (
          <>
            {view === "chat" && (
              <ChatView
                client={client}
                session={active}
                messages={messages}
                runActive={runActive}
                footerLines={footerLines}
                mode={mode}
                onEnterInput={() => setMode("input")}
                onExitInput={() => setMode("normal")}
                onSessionCreated={(s) => {
                  setActive(s);
                  void refreshSessions();
                }}
              />
            )}
            {view === "sessions" && (
              <SessionsView
                sessions={sessions}
                onPick={(s) => {
                  setActive(s);
                  setView("chat");
                }}
                onNew={() => {
                  // Draft state (opencode parity): no session row exists
                  // until the first prompt is submitted — land in the chat
                  // composer ready to type.
                  setActive(null);
                  setView("chat");
                  setMode("input");
                }}
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
        {quitArmed && (
          <Text color="yellow">
            {runActive ? "ctrl+c again to interrupt" : "ctrl+c again to quit"}
          </Text>
        )}
        <Text dimColor>
          {mode === "normal"
            ? `${runActive ? "esc stop · " : ""}i input · j/k history · enter/space thought · ctrl+p providers · ctrl+l models · ctrl+a accounts · ctrl+e agents · ctrl+t thoughts · ctrl+s sessions · ctrl+g gallery · ctrl+o settings · ctrl+c quit`
            : "enter send · esc normal · ctrl+j/k newline · ctrl+w word"}
        </Text>
      </Box>
    </Box>
  );
}
