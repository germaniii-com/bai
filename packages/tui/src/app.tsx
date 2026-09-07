import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import { followGlobal, followSession, type BaiClient } from "@bai/api/client";
import type { Message, PermissionRequest, ProviderListResponse, QuestionRequest, Session } from "@bai/shared";
import { ChatView } from "./views/chat";
import { SessionsView } from "./views/sessions";
import { PlaceholderView } from "./views/placeholder";
import { AgentManager } from "./views/agent-manager";
import { SubagentDialog } from "./views/subagent-dialog";
import { applyAskIndexEvent, askIndexFrom, askUiFor, emptyAskUi, type AskIndex, type AskUiState } from "./state/asks";
import { ProviderFlow } from "./components/provider-flow";
import { applyChildAskEvent, applyEvent, applyPermissionEvent, applyQuestionEvent } from "./state/sync";
import {
  applySubagentEvent,
  emptySubagentState,
  cycleSubagentIndex,
  subagentFocusIndex,
  subagentRows,
  trackSubagents,
  type SubagentState,
} from "./state/subagents";
import { currentModelLabel, needsSetup } from "./state/providers";

export type UiState = "chat" | "gallery" | "jobs" | "settings";

/**
 * Input mode, vim-style. NORMAL (default): vim motions over the transcript
 * plus the ctrl command family. INPUT: plain typing into the composer —
 * app-level ctrl commands are dead there (editing chords ctrl+w/j/k and the
 * ctrl+c safety hatch excepted). esc always returns to NORMAL.
 */
export type Mode = "normal" | "input";

/**
 * Which overlay the ctrl-bindings opened; ProviderFlow starts at this step.
 * ctrl+p → full wizard (provider → account → model), ctrl+l → flat model list
 * across connected providers, ctrl+a → the agent/tool switcher, ctrl+s → the
 * session picker.
 */
type DialogOpen =
  | { kind: "providers" }
  | { kind: "all-models" }
  | { kind: "agents" }
  | { kind: "sessions" }
  | { kind: "subagents"; index: number };

/**
 * Root component: view-state enum + focus routing. Overlay dialogs intercept
 * keys before global bindings (the Crush pattern); global bindings here are
 * ctrl-prefixed so the chat input never fights them. ctrl+c and esc-as-back
 * are handled before the dialog defer — ctrl+c must stay global (quit hatch)
 * and esc only means "back" outside dialogs and chat. `version` stays in the
 * prop contract (CLI plumbing) but has no header to render on anymore.
 */
export function App({ client }: { client: BaiClient; version: string }) {
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
  const [configAgentDefault, setConfigAgentDefault] = useState<string | undefined>(undefined);
  // config models.preferZdr — the pickers float ZDR-capable models first.
  const [configPreferZdr, setConfigPreferZdr] = useState<boolean | undefined>(undefined);
  const [dialog, setDialog] = useState<DialogOpen | null>(null);
  const [runActive, setRunActive] = useState(false);
  // Composer seed for the fork flow: the forked message's text lands in the
  // new session's composer once it becomes active (ChatView applies it on
  // mount and calls onComposerSeedConsumed — never re-applied on revisit).
  const [composerSeed, setComposerSeed] = useState<{ sessionId: string; text: string } | null>(null);
  // Pending permission asks for the active session (queue — normally one).
  // Set by permission.asked events / the snapshot's pendingPermissions;
  // cleared by permission.replied. Rendered INLINE in the chat view (the
  // prompt takes the composer's slot — opencode's placement); first reply
  // wins across devices (a loser's prompt clears via permission.replied).
  const [pendingAsks, setPendingAsks] = useState<PermissionRequest[]>([]);
  // Pending permission asks from the active session's SUBAGENTS (fed from
  // the firehose) — they render in the same inline slot, tagged with the
  // child's name.
  const [pendingChildAsks, setPendingChildAsks] = useState<PermissionRequest[]>([]);
  // Pending agent→user question blocks (the `question` tool) — same pattern.
  const [pendingQuestions, setPendingQuestions] = useState<QuestionRequest[]>([]);
  // Inline prompt UI state (stage, typed buffers, question progress) —
  // hoisted here and reset when the head ask's id changes, so opening a
  // ctrl-chord dialog (which unmounts the chat view) never loses
  // mid-answer progress. React's adjust-state-during-render pattern: the
  // id change IS the reset.
  const headAsk = pendingAsks[0] ?? pendingChildAsks[0] ?? pendingQuestions[0];
  const headAskId = headAsk !== undefined ? (headAsk.id as string) : undefined;
  const [askUiState, setAskUiState] = useState<{ id: string | undefined; ui: AskUiState }>(() => ({
    id: undefined,
    ui: emptyAskUi(),
  }));
  if (askUiState.id !== headAskId) {
    setAskUiState({ id: headAskId, ui: headAsk !== undefined ? askUiFor(headAsk) : emptyAskUi() });
  }
  const setAskUi = useCallback((update: (prev: AskUiState) => AskUiState) => {
    setAskUiState((t) => ({ ...t, ui: update(t.ui) }));
  }, []);
  // Any pending ask for the active session — drives the footer counter and
  // the composer swap in the chat view.
  const askPending = pendingAsks.length > 0 || pendingChildAsks.length > 0 || pendingQuestions.length > 0;
  const askTotal = pendingAsks.length + pendingChildAsks.length + pendingQuestions.length;
  // Global ask index (session → pending count, ALL sessions) — the ctrl+s
  // sessions-list indicator. Seeded from GET /api/permission on mount and
  // on every server.hello (the firehose is live-only; drops heal there),
  // kept live by the firehose's ask/reply events (state/asks.ts).
  const [askIndex, setAskIndex] = useState<AskIndex>(new Map());
  const refreshAskIndex = useCallback(async () => {
    try {
      setAskIndex(askIndexFrom(await client.pendingAsks()));
    } catch {
      // Advisory; the next server.hello re-seeds.
    }
  }, [client]);
  // Agent/tool catalog version — bumped by live events so the manager
  // dialog refetches while open (file edits from any surface).
  const [catalogTick, setCatalogTick] = useState(0);
  // Input mode (NORMAL default). App owns it because it gates the global
  // ctrl bindings; ChatView switches it via onEnterInput/onExitInput.
  const [mode, setMode] = useState<Mode>("normal");
  // Live subagent tracking for the inspector bar (children of the active
  // session, fed from the firehose — state/subagents.ts).
  const [subagents, setSubagents] = useState<SubagentState>(emptySubagentState);
  // Latest tracked state readable from stale closures (openSubagentDialog).
  const subagentsRef = useRef<SubagentState>(emptySubagentState);
  subagentsRef.current = subagents;
  const dialogOpenRef = useRef(false);
  // Only real ctrl-chord dialogs gate the globals now — pending asks do
  // NOT: the inline prompt leaves the transcript, ctrl-chords, view
  // switching, and esc-back fully usable (the whole point of going inline).
  dialogOpenRef.current = dialog !== null;
  // Latest active session readable from the firehose handler's stale closure
  // (the firehose subscribes once and must not resubscribe on every switch).
  const activeRef = useRef<Session | null>(null);
  activeRef.current = active;
  // ctrl+c double-press arming (mirrors the chat composer's esc arming):
  // first press arms, second interrupts a running drain or quits.
  const [quitArmed, setQuitArmed] = useState(false);
  const quitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // On-demand provider list: fetched on first ctrl+p/ctrl+l, kept fresh
  // afterwards.
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

  // Tiny startup fetch: the header's default-model/agent labels come from
  // config (no catalog touch, no models.dev refresh). The full provider
  // list — 200+ providers, thousands of models — loads only when ctrl+p
  // needs it.
  const refreshConfig = useCallback(async () => {
    try {
      const config = await client.getConfig();
      setConfigDefault(config.models.default);
      setConfigAgentDefault(config.agents?.default);
      setConfigPreferZdr(config.models.preferZdr);
    } catch {
      // Advisory; the label falls back to the session model or stub/echo.
    }
  }, [client]);

  useEffect(() => {
    void refreshSessions();
    void refreshConfig();
    void refreshAskIndex();
  }, [refreshSessions, refreshConfig, refreshAskIndex]);

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

  // The inline prompt replaces the composer while an ask is pending
  // (opencode's placement): typing is inert then — force NORMAL so the
  // header indicator and the key routing agree. The draft survives: the
  // chat view stays mounted, its editor state untouched.
  useEffect(() => {
    if (askPending) setMode("normal");
  }, [askPending]);

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
          void refreshAskIndex();
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
        // Subagent inspector: children of the active session stream their
        // activity through the firehose (state/subagents.ts).
        setSubagents((prev) => applySubagentEvent(prev, evt, activeRef.current?.id));
        // A subagent's permission ask feeds the same inline prompt a
        // parent ask gets — otherwise the child would sit blocked with
        // no visible way to answer.
        if (evt.type === "permission.asked" || evt.type === "permission.replied") {
          setPendingChildAsks((list) =>
            applyChildAskEvent(list, evt, (id) => subagentsRef.current.children.has(id)),
          );
        }
        // Global ask index (sessions-list indicator): every ask/reply
        // event, any session.
        setAskIndex((prev) => applyAskIndexEvent(prev, evt));
      },
    });
    return () => ctrl.abort();
  }, [client, refreshProviders, refreshSessions, refreshConfig, refreshAskIndex]);

  // Rebuild the tracked child set whenever the active session or the
  // session list changes (switch, refresh, archive) — live activity for
  // children already tracked survives the rebuild.
  const activeId = active?.id;
  useEffect(() => {
    setSubagents((prev) => trackSubagents(prev, sessions, activeId));
  }, [activeId, sessions]);

  // Open the durable session stream whenever a session becomes active.
  useEffect(() => {
    setError(null); // a session switch drops the previous session's error line
    if (active === null) {
      // Draft state (ctrl+s → n, or before the first message): a NEW
      // session — the previous session's transcript and its asks/questions
      // must not linger. The global ask index still shows the blocked
      // session in the ctrl+s list; picking it re-seeds from the snapshot.
      setMessages([]);
      setRunActive(false);
      setPendingAsks([]);
      setPendingChildAsks([]);
      setPendingQuestions([]);
      return;
    }
    const ctrl = new AbortController();
    setMessages([]);
    setRunActive(false); // a mid-run switch can't see the earlier run.started
    setPendingAsks([]); // session switch: the new session's asks arrive below
    setPendingChildAsks([]); // subagent asks of the previous parent are gone
    setPendingQuestions([]);
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
        // Asks/questions raised before this surface connected (snapshot is
        // the authoritative answer; replayed events would double-add).
        setPendingAsks(snap.pendingPermissions ?? []);
        setPendingQuestions(snap.pendingQuestions ?? []);
        await followSession(client, active.id, {
          from: snap.afterSeq,
          signal: ctrl.signal,
          onEvent: (evt) => {
            applyEvent(setMessages, evt);
            // Run lifecycle drives the waiting indicator (and surfaces
            // provider failures, which otherwise die silently). A fresh
            // run.started clears the previous run's failure line — the
            // user acted on it by sending again.
            if (evt.type === "run.started") {
              setRunActive(true);
              setError(null);
            } else if (evt.type === "run.finished") {
              setRunActive(false);
              if (evt.payload.error !== undefined) setError(`run failed: ${evt.payload.error}`);
            } else if (evt.type === "permission.asked" || evt.type === "permission.replied") {
              setPendingAsks((list) => applyPermissionEvent(list, evt));
            } else if (evt.type === "question.asked" || evt.type === "question.replied" || evt.type === "question.rejected") {
              setPendingQuestions((list) => applyQuestionEvent(list, evt));
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
  // NORMAL anyway (they open via ctrl chords). The same openers are shared
  // with the composer hub's clickable chips (bottom row = the ctrl family).
  const openProvidersDialog = useCallback(() => {
    setDialog({ kind: "providers" });
    void refreshProviders();
  }, [refreshProviders]);
  const openModelsDialog = useCallback(() => {
    setDialog({ kind: "all-models" });
    void refreshProviders();
  }, [refreshProviders]);
  const openAgentsDialog = useCallback(() => {
    setDialog({ kind: "agents" });
  }, []);
  const openSessionsDialog = useCallback(() => {
    setDialog({ kind: "sessions" });
  }, []);
  useInput((ch, key) => {
    // esc is "back": out of any non-chat view. Dialogs handle their own esc
    // (per-level back-out) and chat uses it for focus/interrupt/mode-exit.
    if (key.escape && view !== "chat" && !dialogOpenRef.current) {
      setView("chat");
      return;
    }
    if (!key.ctrl || dialogOpenRef.current) return;
    if (ch === "p") openProvidersDialog();
    else if (ch === "l") openModelsDialog();
    else if (ch === "a") openAgentsDialog();
    else if (ch === "s") openSessionsDialog();
    else if (ch === "g") setView("gallery");
    else if (ch === "o") setView("settings");
  }, { isActive: mode === "normal" });

  const closeDialog = useCallback(() => {
    setDialog(null);
    void refreshProviders();
    void refreshSessions();
  }, [refreshProviders, refreshSessions]);

  const modelLabel = currentModelLabel(active, providers, configDefault);

  /**
   * Open the subagent output dialog: at `sessionId` when the task result
   * links its child, else the first running/asking child, else the first
   * tracked one. The dialog is also the review surface for a child's
   * pending permission ask (subagents are not in the session picker).
   */
  const openSubagentDialog = useCallback(
    (sessionId: string | undefined): void => {
      const index = subagentFocusIndex(subagentRows(subagentsRef.current), sessionId);
      if (index < 0) return;
      setDialog({ kind: "subagents", index });
    },
    [],
  );
  // The effective agent: the session's selection, else the config default
  // (agents.default), else the built-in build agent — the same tiers the
  // drain resolves. Live — switches ride session.updated / config.updated
  // from any surface.
  const activeAgent =
    active !== null && typeof (active.meta as Record<string, unknown>).agent === "string"
      ? ((active.meta as Record<string, unknown>).agent as string)
      : (configAgentDefault ?? "build");
  const setupHint = needsSetup(providers);

  // The footer renders ONLY the conditional status lines above — this count
  // must mirror that render exactly (the chat view bottom-anchors its hub
  // chip hit-testing to rows - footerRows).
  const footerRows =
    (error !== null ? 1 : 0) +
    (setupHint ? 1 : 0) +
    (askPending ? 1 : 0) +
    (quitArmed ? 1 : 0);

  return (
    // Fixed root height = terminal viewport: views flex inside it and the
    // composer/footer stay pinned to the bottom regardless of content size.
    // No header: the composer hub (chat view) is the single source of
    // context — session/workspace info, mode, agent, model, and the command
    // hints all live in its status/commands rows.
    <Box flexDirection="column" height={rows > 0 ? rows : undefined}>
      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        {dialog !== null && dialog.kind === "sessions" ? (
          // Session picker dialog (ctrl+s): pick → open the session and
          // close; n → draft state (no session until the first prompt);
          // esc → back to the chat underneath.
          <SessionsView
            sessions={sessions.filter((s) => s.meta.parent === undefined)}
            activeId={active?.id}
            askIndex={askIndex}
            onPick={(s) => {
              setDialog(null);
              setActive(s);
            }}
            onNew={() => {
              setDialog(null);
              setActive(null);
              setMode("input");
            }}
            onDone={closeDialog}
          />
        ) : dialog !== null && dialog.kind === "subagents" ? (
          // Subagent output dialog (click a task node / enter on a focused
          // message): the child's live transcript; ←/→ cycles subagents,
          // ↑ (at top) or esc exits, a pending ask reviews inline.
          <SubagentDialog
            client={client}
            children={subagentRows(subagents)}
            index={dialog.index}
            onNavigate={(delta) =>
              setDialog({ kind: "subagents", index: cycleSubagentIndex(dialog.index, delta, subagentRows(subagents).length) })
            }
            onExit={() => setDialog(null)}
          />
        ) : dialog !== null && dialog.kind !== "agents" && providers !== null ? (
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
              preferZdr={configPreferZdr}
              initialStep={dialog}
              onDone={closeDialog}
              onRefresh={() => void refreshProviders()}
            />
          </Box>
        ) : dialog !== null ? (
          dialog.kind === "agents" ? (
            <AgentManager
              client={client}
              active={active}
              defaultAgent={configAgentDefault}
              catalogTick={catalogTick}
              onDone={closeDialog}
            />
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
                mode={mode}
                modelLabel={modelLabel}
                agent={activeAgent}
                footerRows={footerRows}
                onEnterInput={() => setMode("input")}
                onExitInput={() => setMode("normal")}
                onSessionCreated={(s) => {
                  setActive(s);
                  void refreshSessions();
                }}
                onForkCreated={(s, seedText) => {
                  setComposerSeed({ sessionId: s.id, text: seedText });
                  setActive(s);
                  void refreshSessions();
                }}
                composerSeed={composerSeed}
                onComposerSeedConsumed={() => setComposerSeed(null)}
                onOpenSubagent={openSubagentDialog}
                onOpenModels={openModelsDialog}
                onOpenAgents={openAgentsDialog}
                onOpenSessions={openSessionsDialog}
                subagents={subagents}
                pendingAsks={pendingAsks}
                pendingChildAsks={pendingChildAsks}
                pendingQuestions={pendingQuestions}
                askUi={askUiState.ui}
                setAskUi={setAskUi}
              />
            )}
            {view === "gallery" && <PlaceholderView title="Gallery" phase={5} />}
            {view === "jobs" && <PlaceholderView title="Jobs" phase={5} />}
            {view === "settings" && <PlaceholderView title="Settings" phase={2} />}
          </>
        )}
      </Box>

      {/* Slim footer: status/warning lines only (errors, provider setup,
          pending asks, ctrl+c arming). The keybinding hints live in the
          composer hub's commands row now. Every line here is conditional —
          footerRows below MUST mirror this render exactly: the chat view
          derives its chip hit-testing row from it. */}
      <Box paddingX={1} flexDirection="column">
        {error !== null && <Text color="red">error: {error}</Text>}
        {setupHint && <Text color="yellow">no provider connected · ctrl+p to set one up</Text>}
        {askPending && (
          // opencode's footer counter: asks block their session's run, so
          // the count stays visible from ANY view (the prompt itself lives
          // in the chat view).
          <Text color="yellow">
            △ {askTotal} pending ask{askTotal === 1 ? "" : "s"}
          </Text>
        )}
        {quitArmed && (
          <Text color="yellow">
            {runActive ? "ctrl+c again to interrupt" : "ctrl+c again to quit"}
          </Text>
        )}
      </Box>
    </Box>
  );
}
