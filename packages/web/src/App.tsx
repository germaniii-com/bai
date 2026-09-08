import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChartColumn, Cpu, Folder, Image, MessageCircle, Palette, SlidersHorizontal, Terminal, Video, Wrench, Zap } from "lucide-react";
import { BaiClient, eventMux, followSession } from "@bai/api/client";
import type { Input, MediaGenConfig, Message, PermissionRequest, QuestionRequest, Session, SessionUsage, ThemeColors, ThemeId } from "@bai/shared";
import { resolveThemeId, isThemeId, slugifyThemeId, themeContrastFailures, THEME_COLORS, buildLearnRequest, type CustomTheme, type CustomThemeInput } from "@bai/shared";
import { applyEvent, applyChildAskEvent, applyPermissionEvent, applyQuestionEvent, applyQueuedInputEvent, emptyQueuedInputs, queuedInputsFromSnapshot, messageText } from "./state";
import { applyFileWatch, emptyFileWatch, type FileWatchState } from "./state-files";
import { applySubagentEvent, emptySubagentState, trackSubagents, type SubagentState } from "./state-subagents";
import { useProviders } from "./use-providers";
import { useAgents } from "./use-agents";
import { useTools } from "./use-tools";
import { useSkills } from "./use-skills";
import { SettingsNav, SettingsPane, type SettingsSection } from "./settings";
import { parseRoute, routeToPath, type Route } from "./router";
import { ThemeProvider } from "./theme";
import { ThemeSelectorModal } from "./theme-picker";
import { WorkspaceNav, FolderGlyph } from "./workspace";
import { FileTree } from "./file-tree";
import { FileView } from "./file-view";
import { ChatPane } from "./chat-pane";
import { AgentsNav, AgentsPane, AgentCreateForm } from "./agents";
import { ToolsNav, ToolsPane, ToolCreateForm, toolTemplateCode } from "./tools";
import { SkillsNav, SkillsPane, SkillCreateForm, SkillLearnForm } from "./skills";
import { AnalyticsPane } from "./analytics";
import { ShellPane } from "./shell";
import { AskPanel, type PendingAsk } from "./ask-panel";
import { Toast, type Notice } from "./toast";

/**
 * Master-rail sections. Image/Video are Phase 5 placeholders — the rail
 * renders them disabled (same stance as the TUI's placeholder views);
 * chat, workspace, and settings are reachable.
 */
type Section = "chat" | "workspace" | "agents" | "tools" | "skills" | "analytics" | "image" | "video" | "shell" | "settings";

/**
 * Sections that render without the nested sidebar (single-pane views — no
 * contextual nav content, so the main pane gets the full width). Add or
 * remove section names here to change which views hide the sidebar.
 */
const SIDEBAR_HIDDEN: Section[] = ["shell", "analytics"];

/**
 * Two-level navigation, mobile-first: master icon rail (workbenches +
 * settings) → contextual nested panel (sessions for chat, workspaces for
 * the workspace view, General + providers for settings) → main pane.
 * Workspace sessions are `workbench: "code"` sessions rooted at the
 * workspace folder path (cwd) — the same chat surface in the center, plus
 * a read-only file tree on the right. Provider/account state is shared
 * with the settings pane and refreshes live from the firehose — changes
 * made in the TUI (ctrl+p) or on the phone appear here without a reload.
 */
export function App() {
  const client = useMemo(
    () => new BaiClient({ baseURL: window.location.origin }),
    [],
  );
  // The boot route — parsed once; the lazy initializers below seed every
  // nav state from it, so refresh / deep links / back-forward restore the
  // exact screen (route-based navigation — src/router.ts).
  const [bootRoute] = useState(() => parseRoute(window.location.pathname, window.location.search));
  const [section, setSection] = useState<Section>(bootRoute.section);
  // The settings section (User | General | Model Providers) — the nested
  // sidebar's entries; each renders one scrollable heading-content page.
  const [settingsSection, setSettingsSection] = useState<SettingsSection>(
    bootRoute.section === "settings" ? bootRoute.settingsSection : "general",
  );
  const [workspaces, setWorkspaces] = useState<string[]>([]);
  const [workspacePath, setWorkspacePath] = useState<string | null>(
    bootRoute.section === "workspace" ? bootRoute.wsPath : null,
  );
  const [workspaceSessions, setWorkspaceSessions] = useState<Session[]>([]);
  // Workspace center-pane view: the chat surface or the file viewer. The
  // [Chat | Files] segmented control above the pane switches it; opening a
  // file from the tree flips it to "files" automatically.
  const [workspaceView, setWorkspaceView] = useState<"chat" | "files">(
    bootRoute.section === "workspace" ? bootRoute.view : "chat",
  );
  // Open file tabs (workspace-scoped paths, in open order) + the active one.
  // Reset when the workspace changes — tabs belong to a workspace.
  const [openFiles, setOpenFiles] = useState<string[]>([]);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  // Live agent file-changes (firehose-fed): paths with unseen edits (tab
  // dots) and a refresh trigger the viewer/tree watch for re-listing.
  const [changedFiles, setChangedFiles] = useState<Set<string>>(new Set());
  const [fsRevision, setFsRevision] = useState(0);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [active, setActive] = useState<Session | null>(null);
  // Deep-linked / popstate-applied session id awaiting resolution via
  // client.getSession (one direct fetch — no waiting for the session
  // lists). Null when nothing is pending; the sync effect holds the URL
  // steady while an id is in flight.
  const [pendingSessionId, setPendingSessionId] = useState<string | null>(
    bootRoute.section === "chat" || bootRoute.section === "workspace" ? bootRoute.sessionId : null,
  );
  const [messages, setMessages] = useState<Message[]>([]);
  // Bumped when the page is restored from bfcache — re-runs the active
  // session effect (the pagehide abort killed its stream).
  const [bfcacheEpoch, setBfcacheEpoch] = useState(0);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [runActive, setRunActive] = useState(false);
  const [sentPending, setSentPending] = useState(false);
  // Pending permission asks for the active session (queue — normally one).
  // Seeded from the snapshot (asks raised before connect) and kept live by
  // permission.asked / permission.replied. First reply wins across devices.
  const [pendingAsks, setPendingAsks] = useState<PermissionRequest[]>([]);
  // Pending permission asks from the active session's SUBAGENTS (fed from
  // the firehose) — they pop the same modal, tagged with the child's name.
  const [pendingChildAsks, setPendingChildAsks] = useState<PermissionRequest[]>([]);
  // Latest session lists/active readable from the firehose closure (the
  // firehose subscribes once; the lists change independently).
  const knownSessionsRef = useRef<Session[]>([]);
  knownSessionsRef.current = [...sessions, ...workspaceSessions];
  const activeRef = useRef<Session | null>(null);
  activeRef.current = active;
  // File-change detection state (firehose closure — refs, not state, so the
  // single firehose subscription never resubscribes).
  const fileWatchRef = useRef<FileWatchState>(emptyFileWatch);
  const openFilesRef = useRef<string[]>([]);
  openFilesRef.current = openFiles;
  // Pending agent→user question blocks (the `question` tool) — same pattern.
  const [pendingQuestions, setPendingQuestions] = useState<QuestionRequest[]>([]);
  // Queued messages for the active session (message-queue feature): admitted
  // inputs waiting for the session to go idle, plus send-now flips marked
  // "sending" in place until they promote. Seeded from the snapshot and kept
  // live by input.admitted/promoted/cancelled/updated; the queued nodes
  // render at the transcript tail with actions.
  const [queuedState, setQueuedState] = useState(emptyQueuedInputs());
  // The active session's latest provider-reported usage — the composer hub's
  // context tracker chip. Seeded from the snapshot (meta.lastUsage) and kept
  // live by the durable run.usage events (one per provider turn; the
  // compaction clearing event renders `?` until the next turn).
  const [usage, setUsage] = useState<SessionUsage | null>(null);
  // Live subagent tracking for the chat pane's task nodes (TUI parity):
  // children of the active session, fed from the firehose — live status
  // (asking/running) and the child session ids the inline transcripts open.
  const [subagents, setSubagents] = useState<SubagentState>(emptySubagentState);
  // The merged, prioritized pending ask (parent permission > subagent
  // permission > question — the modal era's ordering), rendered INLINE in
  // the chat pane between the transcript and the composer. First reply
  // wins across devices; a loser's panel clears via the replied event.
  const headPermission = pendingAsks[0] ?? pendingChildAsks[0];
  const headFromChild = pendingAsks.length === 0 && headPermission !== undefined;
  const headQuestion = headPermission === undefined ? pendingQuestions[0] : undefined;
  const askTotal = pendingAsks.length + pendingChildAsks.length + pendingQuestions.length;
  const pendingAsk: PendingAsk | undefined =
    headPermission !== undefined
      ? {
          kind: "permission",
          request: headPermission,
          ...(headFromChild
            ? {
                context: `subagent @${knownSessionsRef.current.find(
                  (s) => s.id === headPermission.sessionId && typeof s.meta.agent === "string",
                )?.meta.agent ?? "subagent"}`,
              }
            : {}),
        }
      : headQuestion !== undefined
        ? { kind: "question", request: headQuestion }
        : undefined;
  const streamCtrl = useRef<AbortController | null>(null);
  const { list, refresh: refreshProviders, fetching: providersFetching } = useProviders(client);
  // Default model + agent + workspace list from config — a tiny startup
  // fetch so the header's picker buttons show the real defaults before the
  // (heavy, on-demand) provider list ever loads. Same pattern as the TUI's
  // header.
  const [configDefault, setConfigDefault] = useState<string | undefined>(undefined);
  const [configDefaultAgent, setConfigDefaultAgent] = useState<string | undefined>(undefined);
  // Settings-section snapshot (User name, ZDR preference, media-gen defaults)
  // — firehose-refreshed via config.updated like the defaults above.
  const [configUserName, setConfigUserName] = useState<string | undefined>(undefined);
  const [configPreferZdr, setConfigPreferZdr] = useState<boolean | undefined>(undefined);
  const [configImageGen, setConfigImageGen] = useState<MediaGenConfig | undefined>(undefined);
  const [configVideoGen, setConfigVideoGen] = useState<MediaGenConfig | undefined>(undefined);
  // First successful config load — gates the URL sync effect (the workspace
  // path's validity, hence the canonical URL, is unknown before it).
  const [configLoaded, setConfigLoaded] = useState(false);
  // config theme — the UI theme id; applied by ThemeProvider (data-theme on
  // <html>) and synced from any surface via config.updated.
  const [configTheme, setConfigTheme] = useState<string | undefined>(undefined);
  // Custom themes (~/.config/bai/themes/*.json) — fetched at boot, when the
  // config names a non-builtin theme, and after saves/deletes in the picker.
  const [customThemes, setCustomThemes] = useState<CustomTheme[]>([]);
  const [themePickerOpen, setThemePickerOpen] = useState(false);
  // Agents/tools mutation feedback — a bottom-right toast (auto-dismisses;
  // click to dismiss). Settings keeps its inline banner.
  const [notice, setNotice] = useState<Notice | null>(null);
  /** Toast feedback from the agents/tools panes (kind defaults to success). */
  const pushNotice = useCallback((message: string, kind: "success" | "error" | "info" = "success") => {
    setNotice({ message, kind });
  }, []);
  // Independent catalogs: agents and tools each own their fetch/refresh —
  // updated by firehose events (agents.updated / tools.updated), section
  // engagement, and reconnect healing.
  const { agents, refresh: refreshAgents } = useAgents(client);
  const { tools, refresh: refreshTools } = useTools(client);
  const { skills, refresh: refreshSkills } = useSkills(client);
  // Selections per section; stale ids (deleted elsewhere) resolve to null
  // against the live lists — the settings pattern.
  const [selectedAgent, setSelectedAgent] = useState<string | null>(
    bootRoute.section === "agents" ? bootRoute.name : null,
  );
  const [selectedTool, setSelectedTool] = useState<string | null>(
    bootRoute.section === "tools" ? bootRoute.name : null,
  );
  const [selectedSkill, setSelectedSkill] = useState<string | null>(
    bootRoute.section === "skills" ? bootRoute.name : null,
  );
  // Creation flows: true while the create form (pre-filled, editable name)
  // is open in the main pane — no file is written until the form submits.
  const [creatingAgent, setCreatingAgent] = useState(bootRoute.section === "agents" && bootRoute.creating);
  const [creatingTool, setCreatingTool] = useState(bootRoute.section === "tools" && bootRoute.creating);
  const [creatingSkill, setCreatingSkill] = useState(bootRoute.section === "skills" && bootRoute.creating);
  // The Skills page's "Learn with AI" form (swapped in over the create form).
  const [skillLearnOpen, setSkillLearnOpen] = useState(false);

  const refreshCustomThemes = useCallback(async () => {
    try {
      setCustomThemes(await client.listCustomThemes());
    } catch {
      // Advisory; the picker still shows the built-ins.
    }
  }, [client]);

  const refreshConfig = useCallback(async () => {
    try {
      const config = await client.getConfig();
      setConfigDefault(config.models.default);
      setConfigDefaultAgent(config.agents?.default);
      setConfigUserName(config.user?.name);
      setConfigPreferZdr(config.models.preferZdr);
      setConfigImageGen(config.imageGen);
      setConfigVideoGen(config.videoGen);
      setConfigTheme(config.theme);
      setWorkspaces(config.workspaces ?? []);
      setConfigLoaded(true);
      // A non-builtin theme id means a custom theme file — its palette must
      // be loaded for the surfaces to render it (boot-with-custom, or a
      // theme created on another surface).
      if (config.theme !== undefined && !isThemeId(config.theme)) void refreshCustomThemes();
      } catch {
        // Advisory; the label falls back to the session model or stub/echo.
        // Corrections still run — best-known state beats a frozen URL.
        setConfigLoaded(true);
      }
  }, [client, refreshCustomThemes]);

  useEffect(() => {
    void refreshConfig();
    void refreshCustomThemes();
  }, [refreshConfig, refreshCustomThemes]);

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
      // Chat section lists general chat sessions only — workspace sessions
      // (workbench "code") live in the workspace view.
      setSessions(await client.listSessions(50, 0, { workbench: "chat" }));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [client]);

  useEffect(() => {
    void refreshSessions();
  }, [refreshSessions]);

  const refreshWorkspaceSessions = useCallback(async () => {
    if (workspacePath === null) {
      setWorkspaceSessions([]);
      return;
    }
    try {
      setWorkspaceSessions(await client.listSessions(50, 0, { cwd: workspacePath }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [client, workspacePath]);

  useEffect(() => {
    void refreshWorkspaceSessions();
  }, [refreshWorkspaceSessions]);

  // Live refresh of session state (e.g. model picked from another surface).
  // The firehose rides the shared EventMux — ONE global SSE connection for
  // the whole page (this sync engine + useProviders' watcher used to open
  // two identical connections).
  useEffect(() => {
    const unsubscribe = eventMux(client).subscribe((evt) => {
        // Universal healing (§8.4): the firehose's first frame on every
        // (re)connect refreshes the snapshots — live events missed during a
        // drop (e.g. a background title change) can't linger.
        if (evt.type === "server.hello") {
          void refreshSessions();
          void refreshWorkspaceSessions();
          void refreshConfig();
          void refreshAgents();
          void refreshTools();
          // File-change detection is live-only — events missed during a
          // firehose drop never replay. Heal the viewer and tree on every
          // (re)connect: one refetch of the active file + expanded dirs.
          setFsRevision((n) => n + 1);
        }
        // Live file-change detection (workspace viewer): patch parts (git
        // workspaces, covers bash) + fs.write/fs.edit results (fallback)
        // from ANY session — the firehose is global. Open tabs get change
        // dots; the viewer and tree refresh via fsRevision.
        const changedFiles = applyFileWatch(fileWatchRef.current, evt, {
          root: wsRootRef.current,
          sessionCwd: (id) => sessionCwdRef.current(id),
        });
        if (changedFiles.length > 0) {
          setChangedFiles((prev) => {
            const next = new Set(prev);
            let touched = false;
            for (const p of changedFiles) {
              if (openFilesRef.current.includes(p) && !next.has(p)) {
                next.add(p);
                touched = true;
              }
            }
            return touched ? next : prev;
          });
          setFsRevision((n) => n + 1);
        }
        if (evt.type === "session.updated") {
          const payload = evt.payload as { session?: Session };
          if (payload.session !== undefined) {
            const updated = payload.session;
            setActive((current) => (current?.id === updated.id ? updated : current));
            // Server-side title changes (fallback + LLM refine) must reach
            // both sidebars without a refetch.
            setSessions((list) => list.map((s) => (s.id === updated.id ? updated : s)));
            setWorkspaceSessions((list) => list.map((s) => (s.id === updated.id ? updated : s)));
          }
        }
        // Sessions created on other surfaces (TUI, phone) appear live in
        // whichever lists are loaded.
        if (evt.type === "session.created") {
          void refreshSessions();
          void refreshWorkspaceSessions();
        }
        // Config changes from ANY surface (TUI, phone) update the header
        // label and the workspace list without a reload.
        if (evt.type === "config.updated") {
          void refreshConfig();
        }
        // Agent/tool files changed anywhere (TUI manager, disk, web editor):
        // each catalog refreshes independently.
        if (evt.type === "agents.updated") {
          void refreshAgents();
        }
        if (evt.type === "tools.updated") {
          void refreshTools();
        }
        if (evt.type === "skills.updated") {
          void refreshSkills();
        }
        // A subagent's permission ask pops the same modal a parent ask
        // gets — otherwise the child would sit blocked with no dialog.
        if (evt.type === "permission.asked" || evt.type === "permission.replied") {
          const parentId = activeRef.current?.id;
          setPendingChildAsks((list) =>
            applyChildAskEvent(list, evt, (id) =>
              knownSessionsRef.current.some((s) => s.id === id && parentId !== undefined && s.meta.parent === parentId),
            ),
          );
        }
        // Subagent tracking (TUI parity): every firehose event may advance
        // a tracked child's live activity (run lifecycle, permission asks,
        // streamed tool/text parts).
        setSubagents((prev) => applySubagentEvent(prev, evt, activeRef.current?.id));
    });
    return unsubscribe;
  }, [client, refreshConfig, refreshSessions, refreshWorkspaceSessions, refreshAgents, refreshTools, refreshSkills]);

  // The active session's ID — the session stream effect keys on this (not
  // the object reference) so session.updated patches don't tear it down.
  const activeId = active?.id;

  useEffect(() => {
    streamCtrl.current?.abort();
    setError(null); // a session switch drops the previous session's error banner
    setSubagents(emptySubagentState); // the previous session's children are gone
    if (activeId === undefined) {
      // Draft state (+ new session): a NEW session — the previous
      // session's transcript and its asks/questions must not linger.
      setMessages([]);
      setRunActive(false);
      setSentPending(false);
      setPendingAsks([]);
      setPendingChildAsks([]);
    setPendingQuestions([]);
    setQueuedState(emptyQueuedInputs());
    setUsage(null); // draft state: no session, no usage
    return;
  }
  const ctrl = new AbortController();
  streamCtrl.current = ctrl;
  setMessages([]); // switching sessions: drop the old transcript immediately
  setRunActive(false); // a mid-run switch can't see the earlier run.started
  setSentPending(false);
  setPendingAsks([]); // session switch: the new session's asks arrive below
  setPendingChildAsks([]); // subagent asks of the previous parent are gone
  setPendingQuestions([]);
  setQueuedState(emptyQueuedInputs());
  void (async () => {
    try {
      // Snapshot first, then follow the durable stream from its frontier.
      // followSession resumes from the cursor on drops (idle timeouts,
      // restarts) — replaying from 0 would duplicate the snapshot instead.
      const snap = await client.historySnapshot(activeId);
      if (ctrl.signal.aborted) return; // switched again mid-fetch — stale
      setMessages(snap.messages);
      // A run may already be draining (mid-run switch, or the snapshot was
      // taken right after our own submit) — its run.started predates the
      // cursor, so the snapshot is the only reliable signal.
      setRunActive(snap.runActive === true);
      // The context tracker seeds from meta.lastUsage (no wait for the next
      // turn); live run.usage events take over from here.
      setUsage(snap.usage ?? null);
        // Asks/questions raised before this surface connected (snapshot is
        // the authoritative answer; replayed events would double-add).
        setPendingAsks(snap.pendingPermissions ?? []);
        setPendingQuestions(snap.pendingQuestions ?? []);
        // Queued messages pending at snapshot time (the replayed
        // input.* events cover anything admitted after the cursor).
        // Admitted steer inputs seed as "sending" — they promote at the
        // next boundary.
        setQueuedState(queuedInputsFromSnapshot(snap.pendingInputs));
        await followSession(client, activeId, {
          from: snap.afterSeq,
          signal: ctrl.signal,
          onEvent: (evt) => {
            applyEvent(setMessages, evt);
            // Run lifecycle drives the waiting indicator (and surfaces
            // provider failures, which otherwise die silently). A fresh
            // run.started clears the previous run's failure banner — the
            // user acted on it by sending again; a stale failure must not
            // shadow the new run.
            if (evt.type === "run.started") {
              setRunActive(true);
              setError(null);
            } else if (evt.type === "run.finished") {
              setRunActive(false);
              if (evt.payload.error !== undefined) setError(`run failed: ${evt.payload.error}`);
            } else if (evt.type === "run.retry") {
              // Transient provider failure — the run loop is retrying with
              // backoff. Cosmetic toast; the final failure still surfaces
              // via run.finished {error}.
              pushNotice(`API error, retrying (${evt.payload.attempt}/${evt.payload.maxAttempts})…`, "info");
            } else if (evt.type === "run.usage") {
              // The context tracker's live feed (one event per provider
              // turn; the compaction clearing event carries no tokens).
              setUsage(evt.payload.usage);
            } else if (evt.type === "permission.asked" || evt.type === "permission.replied") {
              setPendingAsks((list) => applyPermissionEvent(list, evt));
            } else if (evt.type === "question.asked" || evt.type === "question.replied" || evt.type === "question.rejected") {
              setPendingQuestions((list) => applyQuestionEvent(list, evt));
            } else if (
              evt.type === "input.admitted" ||
              evt.type === "input.promoted" ||
              evt.type === "input.cancelled" ||
              evt.type === "input.updated"
            ) {
              setQueuedState((state) => applyQueuedInputEvent(state, evt));
            }
          },
          onDrop: () => {}, // silent reconnect; the cursor guarantees no gaps
        });
      } catch (err) {
        if (!ctrl.signal.aborted) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    // Renderer destruction does NOT cancel streaming fetches — without this,
    // every reload leaks its session stream into the browser's per-origin
    // connection budget (the same pagehide discipline the EventMux applies).
    const onPageHide = (): void => ctrl.abort();
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      ctrl.abort();
    };
    // Keyed on the session ID, not the object reference: a session.updated
    // patch (title refine, compaction, renames from other surfaces) must
    // NOT tear down the stream and wipe/reseed the transcript + queued
    // state — metadata flows through the firehose patch instead.
  }, [activeId, client, bfcacheEpoch]);

  // Bfcache restore: the pagehide abort killed the stream — a fresh snapshot
  // re-establishes it (the DB is the buffer; nothing was lost).
  useEffect(() => {
    const onShow = (e: PageTransitionEvent): void => {
      if (e.persisted) setBfcacheEpoch((n) => n + 1);
    };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);

  // Rebuild the tracked child set whenever the active session or either
  // session list changes (switch, refresh, archive) — live activity for
  // children already tracked survives the rebuild (TUI parity).
  useEffect(() => {
    setSubagents((prev) => trackSubagents(prev, [...sessions, ...workspaceSessions], activeId));
  }, [activeId, sessions, workspaceSessions]);

  // Stale-selection fallbacks: a workspace removed from config (config.updated)
  // resolves back to no selection. Settings sections are static — no fallback
  // needed there (the old provider-id selection is gone with the drill-down).
  const effectiveWorkspacePath =
    workspacePath !== null && workspaces.includes(workspacePath) ? workspacePath : null;
  const effectiveAgentId = agents.some((a) => a.name === selectedAgent) ? selectedAgent : null;
  const effectiveToolId = tools.some((t) => t.name === selectedTool) ? selectedTool : null;
  const effectiveSkillId = skills.some((s) => s.name === selectedSkill) ? selectedSkill : null;
  // The active session's resolved agent (meta → config default → build) —
  // the learn chip's in-session-vs-spawn decision.
  const activeAgentName =
    typeof (active?.meta as { agent?: unknown } | undefined)?.agent === "string"
      ? (active?.meta as { agent: string }).agent
      : (configDefaultAgent ?? "build");
  const activeAgent = agents.find((a) => a.name === activeAgentName);
  const canAuthorSkills =
    activeAgent !== undefined && (activeAgent.tools.includes("*") || activeAgent.tools.includes("skills.save"));
  // File-watch closure inputs: the viewed root and the session-cwd lookup
  // (patch paths are relative to the OWNING session's cwd — subagents
  // inherit the parent's; unknown sessions fall back to the viewed root).
  const wsRootRef = useRef<string | null>(null);
  wsRootRef.current = effectiveWorkspacePath;
  const sessionCwdRef = useRef<(id: string) => string | undefined>(() => undefined);
  sessionCwdRef.current = (id: string) =>
    knownSessionsRef.current.find((s) => s.id === id)?.cwd ?? activeRef.current?.cwd ?? undefined;

  /** Engagement refetches (TUI parity): fresh catalog data on section entry. */
  const engageSection = useCallback((next: Section): void => {
    if (next === "settings") {
      // On-demand + refetch on engagement (TUI ctrl+p parity): the provider
      // list never loads at startup, and every engagement pulls fresh data.
      // The General pane's agent select rides the same engagement refetch.
      void refreshProviders();
      void refreshAgents();
    }
    if (next === "workspace") {
      // Engagement refetch: fresh session list for the selected workspace.
      void refreshWorkspaceSessions();
    }
    if (next === "agents") {
      // Engagement refetch: agents changed anywhere → fresh list.
      void refreshAgents();
    }
    if (next === "tools") {
      // Engagement refetch: tools changed anywhere → fresh list.
      void refreshTools();
    }
    if (next === "skills") {
      // Engagement refetch: skills changed anywhere → fresh list.
      void refreshSkills();
    }
  }, [refreshProviders, refreshAgents, refreshWorkspaceSessions, refreshTools, refreshSkills]);

  // Deep-link engagement: landing directly on Settings (refresh, shared
  // link) must fetch the catalogs the pane renders — the provider list is
  // on-demand and would otherwise stay unloaded until the first click. The
  // other sections' catalogs fetch on mount via their own hooks/effects.
  useEffect(() => {
    if (bootRoute.section === "settings") engageSection("settings");
  }, [bootRoute, engageSection]);

  /**
   * Apply a parsed route to the nav-state cluster (the URL→state direction —
   * pushRoute and popstate both land here). `session` carries an
   * already-known Session for the route's id (sidebar clicks, fork) so no
   * refetch is needed; id-only routes park the id in `pendingSessionId` for
   * the resolution effect below. Settings/agents/tools routes leave the
   * session cluster untouched — the open session persists in memory (the
   * URL picks it back up on return), matching the pre-router behavior.
   */
  const applyRouteStates = useCallback(
    (route: Route, session?: Session | null): void => {
      setSection(route.section);
      if (route.section === "settings") setSettingsSection(route.settingsSection);
      if (route.section === "workspace") {
        setWorkspacePath(route.wsPath);
        setWorkspaceView(route.view);
      }
      if (route.section === "agents") {
        setSelectedAgent(route.name);
        setCreatingAgent(route.creating);
      }
      if (route.section === "tools") {
        setSelectedTool(route.name);
        setCreatingTool(route.creating);
      }
      if (route.section === "skills") {
        setSelectedSkill(route.name);
        setCreatingSkill(route.creating);
      }
      if (session !== undefined) {
        // Explicit session (sidebar click, fork, kept on section switch).
        setActive(session);
        setPendingSessionId(null);
      } else if (route.section === "chat" || route.section === "workspace") {
        if (route.sessionId !== null) {
          // Id-only route: resolve via getSession unless it's already open.
          if (activeRef.current?.id !== route.sessionId) {
            // Drop a mismatched open session now — the routed one replaces
            // it when the fetch lands (old navigate() coherence).
            const want = route.section === "chat" ? "chat" : "code";
            if (activeRef.current !== null && activeRef.current.workbench !== want) setActive(null);
            setPendingSessionId(route.sessionId);
          }
        } else {
          // Explicit draft route ("+ new session", back to a draft).
          setActive(null);
          setPendingSessionId(null);
        }
      }
      engageSection(route.section);
    },
    [engageSection],
  );

  /**
   * User-initiated navigation: push a history entry, then apply the route.
   * Re-applying the current location (e.g. clicking the active session)
   * must not spam the history stack.
   */
  const pushRoute = useCallback(
    (route: Route, session?: Session | null): void => {
      const path = routeToPath(route);
      if (path !== window.location.pathname + window.location.search) {
        window.history.pushState(null, "", path);
      }
      applyRouteStates(route, session);
    },
    [applyRouteStates],
  );

  const navigate = (next: Section): void => {
    // Keep the open session coherent with the section — a chat session in
    // the workspace view (or vice versa) would read as a context mixup —
    // and carry it into the route so the URL keeps identifying it.
    switch (next) {
      case "chat": {
        const keep = activeRef.current?.workbench === "chat" ? activeRef.current : null;
        pushRoute({ section: "chat", sessionId: keep?.id ?? null }, keep);
        break;
      }
      case "workspace": {
        const keep = activeRef.current?.workbench === "code" ? activeRef.current : null;
        pushRoute(
          {
            section: "workspace",
            wsPath: keep !== null ? (keep.cwd ?? null) : workspacePath,
            view: workspaceView,
            sessionId: keep?.id ?? null,
          },
          keep,
        );
        break;
      }
      case "settings":
        pushRoute({ section: "settings", settingsSection });
        break;
      case "agents":
        pushRoute({ section: "agents", name: effectiveAgentId, creating: false });
        break;
      case "tools":
        pushRoute({ section: "tools", name: effectiveToolId, creating: false });
        break;
      case "skills":
        pushRoute({ section: "skills", name: effectiveSkillId, creating: false });
        break;
      case "analytics":
        pushRoute({ section: "analytics" });
        break;
      case "shell":
        pushRoute({ section: "shell" });
        break;
      // Image/Video are disabled rail placeholders — never navigable (D9).
      case "image":
      case "video":
        break;
    }
  };

  // Deep-linked / popstate-applied session ids resolve here — one direct
  // fetch (no waiting for the session lists). A hit activates the session
  // (the active-effect below then loads its history + stream); a miss
  // clears the pending id (the sync effect strips the dead id from the
  // URL). Coherence: the session must belong to the route's section — a
  // chat session under /chat, a code session rooted at the viewed
  // workspace (the workspace path may still be validating at boot —
  // effectiveWorkspacePath null — in which case the cwd check rides on the
  // config landing).
  useEffect(() => {
    if (pendingSessionId === null) return;
    const id = pendingSessionId;
    let cancelled = false;
    void (async () => {
      try {
        const session = await client.getSession(id);
        if (cancelled) return;
        setPendingSessionId((current) => (current === id ? null : current));
        if (session === undefined) return; // dead id — URL gets corrected
        // Workspace coherence rides the RAW workspace path while the config
        // is still loading (effectiveWorkspacePath null) and turns strict
        // once it lands — a stale slug never adopts a foreign session.
        const coherent =
          section === "chat"
            ? session.workbench === "chat"
            : section === "workspace" &&
              session.workbench === "code" &&
              session.cwd === (effectiveWorkspacePath ?? workspacePath);
        if (coherent) setActive(session);
      } catch {
        if (!cancelled) setPendingSessionId(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pendingSessionId, client, section, effectiveWorkspacePath, workspacePath]);

  // The nav state as a Route — the canonical URL projection.
  const canonicalPath = routeToPath(
    section === "settings"
      ? { section: "settings", settingsSection }
      : section === "agents"
        ? { section: "agents", name: effectiveAgentId, creating: creatingAgent }
        : section === "tools"
          ? { section: "tools", name: effectiveToolId, creating: creatingTool }
          : section === "skills"
            ? { section: "skills", name: effectiveSkillId, creating: creatingSkill }
            : section === "analytics"
            ? { section: "analytics" }
            : section === "shell"
              ? { section: "shell" }
              : section === "workspace"
            ? {
                section: "workspace",
                wsPath: effectiveWorkspacePath,
                view: workspaceView,
                // Only a session rooted at the VIEWED workspace identifies
                // in the URL — a foreign code session (transient
                // incoherence) must not read as this workspace's session.
                sessionId:
                  active?.workbench === "code" && active.cwd === effectiveWorkspacePath
                    ? active.id
                    : null,
              }
            : { section: "chat", sessionId: active?.workbench === "chat" ? active.id : null },
  );

  // Keep the address bar on the canonical projection of the nav state.
  // Replace-only: user-initiated navigation pushes via pushRoute; this
  // effect only corrects (boot "/", draft→created session, dead ids, stale
  // workspace paths) without polluting the history stack. Skipped while a
  // deep-linked session id is resolving (the URL's id is still
  // authoritative) and until the first config load (the workspace path's
  // validity — hence the canonical URL — is unknown before it).
  useEffect(() => {
    if (pendingSessionId !== null || !configLoaded) return;
    if (canonicalPath === window.location.pathname + window.location.search) return;
    window.history.replaceState(null, "", canonicalPath);
  }, [canonicalPath, pendingSessionId, configLoaded]);

  // Browser back/forward: apply the location to the nav-state cluster (no
  // push — the history entry already exists). Engagement refetches ride
  // along so back/forward shows fresh catalogs, matching clicks.
  useEffect(() => {
    const onPop = (): void => {
      applyRouteStates(parseRoute(window.location.pathname, window.location.search));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [applyRouteStates]);

  const selectWorkspace = (path: string | null): void => {
    // Open tabs belong to a workspace — a switch drops them and returns to
    // the chat surface.
    setOpenFiles([]);
    setActiveFile(null);
    // Keep the open session only when it belongs to the chosen workspace.
    const keep = path !== null && activeRef.current?.cwd === path ? activeRef.current : null;
    pushRoute({ section: "workspace", wsPath: path, view: "chat", sessionId: keep?.id ?? null }, keep);
  };

  /** Tree file click: open (or focus) a tab and flip to the Files view. */
  const openFile = (path: string): void => {
    setOpenFiles((prev) => (prev.includes(path) ? prev : [...prev, path]));
    setActiveFile(path);
    setWorkspaceView("files");
  };

  /** The file's fresh content was seen (active auto-refresh or tab click). */
  const clearChangedFile = (path: string): void => {
    setChangedFiles((prev) => {
      if (!prev.has(path)) return prev;
      const next = new Set(prev);
      next.delete(path);
      return next;
    });
  };

  /** Tab click: activate + acknowledge its changes (the dot clears). */
  const selectFileTab = (path: string): void => {
    setActiveFile(path);
    clearChangedFile(path);
  };

  /** Tab ✕: drop the tab; a closed ACTIVE tab activates its neighbor. */
  const closeFileTab = (path: string): void => {
    const idx = openFiles.indexOf(path);
    const next = openFiles.filter((p) => p !== path);
    setOpenFiles(next);
    clearChangedFile(path);
    if (activeFile === path) setActiveFile(next[idx] ?? next[idx - 1] ?? null);
  };

  /** Validate-then-persist happened in the nav; here: append + save config. */
  const addWorkspace = async (path: string): Promise<void> => {
    if (!workspaces.includes(path)) {
      await client.putConfig({ workspaces: [...workspaces, path] });
    }
    // Immediate refresh (config.updated also refreshes via the firehose —
    // this covers dropped live events).
    await refreshConfig();
    // Select the freshly added workspace — the user added it to work in it.
    selectWorkspace(path);
  };

  /** Write a starter agent file for the (form-validated) name, then select it. */
  const createAgent = async (name: string): Promise<void> => {
    await client.putAgent(name, {
      description: "What this agent is for.",
      prompt: `You are ${name}, an agent inside bai.\n\nDescribe the agent's role, tone, and workflow here. The body is the system prompt.`,
      tools: ["fs.read", "fs.list"],
    });
    // Refresh BEFORE routing: the canonical URL validates the selection
    // against the live list — routing first would flicker through /agents.
    await refreshAgents();
    pushRoute({ section: "agents", name, creating: false });
  };

  /** Write a starter tool file for the (form-validated) name, then select it. */
  const createTool = async (name: string): Promise<void> => {
    await client.putTool(name, toolTemplateCode(name));
    await refreshTools();
    pushRoute({ section: "tools", name, creating: false });
  };

  /** Write a starter SKILL.md for the (form-validated) name, then select it. */
  const createSkill = async (name: string): Promise<void> => {
    await client.putSkill(name, {
      description: `What the ${name} skill does, in one sentence.`,
      body: `# ${name}\n\nDescribe the workflow here: when to use it, the steps to follow, and how to verify the result.\n\nSupporting files can live in references/, templates/, scripts/, and assets/ — the agent reads them on demand via skills.view(name, path).`,
    });
    await refreshSkills();
    pushRoute({ section: "skills", name, creating: false });
  };

  const submit = async (override?: string): Promise<void> => {
    const text = (override ?? draft).trim();
    if (text.length === 0) return;
    if (override === undefined) setDraft("");
    // Message-queue default (Cursor-style): a submit while the session is
    // draining QUEUES instead of steering — the queued node (fed by the
    // input.admitted event) is the feedback, so the typing dots stay off.
    const queuing = runActive;
    if (!queuing) setSentPending(true);
    setError(null); // a new send supersedes the previous run's failure banner
    try {
      let session = active;
      if (session === null) {
        // First message lazily creates the session — workspace sessions are
        // code-workbench sessions rooted at the workspace folder path. The
        // server titles it (fallback + LLM refine) from this first prompt.
        session =
          section === "workspace" && effectiveWorkspacePath !== null
            ? await client.createSession({ workbench: "code", cwd: effectiveWorkspacePath })
            : await client.createSession({ workbench: "chat" });
        setActive(session);
        if (section === "workspace") void refreshWorkspaceSessions();
        else void refreshSessions();
      }
      await client.submitPrompt(session.id, { text, ...(queuing ? { queue: true } : {}) });
    } catch (err) {
      setSentPending(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  /**
   * Learn (hermes /learn parity, no slash command): run the standards-guided
   * learn request as a normal user turn. In THIS session when its agent can
   * author skills (the orchestrator); otherwise spawn a dedicated learn
   * session and navigate to it. An empty request distills the current
   * conversation — only meaningful in-session, so the spawn path requires
   * the user to describe the source.
   */
  const learn = async (request: string): Promise<void> => {
    const trimmed = request.trim();
    if (canAuthorSkills) {
      await submit(buildLearnRequest(trimmed));
      return;
    }
    if (trimmed.length === 0) {
      setError("The current agent can't author skills — describe what to learn and it runs in a fresh learn session.");
      return;
    }
    try {
      const session = await client.learnSkill({ request: trimmed });
      pushNotice("started a learn session (the current agent can't author skills)", "info");
      pushRoute({ section: "chat", sessionId: session.id });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  // --- queued-message actions (message-queue feature) ---------------------
  /** Send now: flip the queued input to steer — it promotes at the next safe boundary. */
  const sendQueued = async (input: Input): Promise<void> => {
    if (active === null || active.id !== input.sessionId) return;
    try {
      await client.sendInputNow(active.id, input.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  /** Cancel: drop the queued input — it never runs. */
  const cancelQueued = async (input: Input): Promise<void> => {
    if (active === null || active.id !== input.sessionId) return;
    try {
      await client.cancelInput(active.id, input.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  /** Edit: cancel the queued input and put its text back into the composer. */
  const editQueued = (input: Input): void => {
    void cancelQueued(input);
    setDraft(input.payload.text);
  };

  // --- per-user-message actions (revert / fork, opencode parity) ----------
  const [revertBusy, setRevertBusy] = useState(false);

  /**
   * Run a revert-family mutation, absorbing the post-interrupt busy window:
   * a running drain aborts asynchronously, so the first request can still
   * meet the 409 — retry briefly before surfacing the error.
   */
  const withBusyRetry = async (fn: () => Promise<void>): Promise<void> => {
    for (let attempt = 0; ; attempt++) {
      try {
        await fn();
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (attempt < 4 && message.includes("busy")) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          continue;
        }
        setError(message);
        return;
      }
    }
  };

  /** Revert to a user message: hide it + everything after, roll back files, and put its text back into the composer. */
  const revertToMessage = (m: Message): void => {
    if (active === null || revertBusy) return;
    setRevertBusy(true);
    setError(null);
    if (runActive) void client.interrupt(active.id);
    void withBusyRetry(async () => {
      setActive(await client.revertSession(active.id, m.id));
      setDraft(messageText(m));
      // The rollback rewrote files on disk — the viewer/tree re-list.
      setFsRevision((n) => n + 1);
    }).finally(() => setRevertBusy(false));
  };

  /** Fork at a message: switch to the new session, composer seeded with the message text. */
  const forkAtMessage = (m: Message): void => {
    if (active === null || revertBusy) return;
    setRevertBusy(true);
    setError(null);
    if (runActive) void client.interrupt(active.id);
    void withBusyRetry(async () => {
      const forked = await client.forkSession(active.id, m.id);
      setDraft(messageText(m));
      // A fork is real navigation — push it so back returns to the origin
      // session (the replace-only sync would lose it from the stack).
      pushRoute(
        section === "workspace"
          ? { section: "workspace", wsPath: effectiveWorkspacePath, view: workspaceView, sessionId: forked.id }
          : { section: "chat", sessionId: forked.id },
        forked,
      );
      void refreshSessions();
    }).finally(() => setRevertBusy(false));
  };

  /** Undo a pending revert: the hidden messages reappear (they were never deleted). */
  const restoreRevert = (): void => {
    if (active === null || revertBusy) return;
    setRevertBusy(true);
    setError(null);
    void withBusyRetry(async () => {
      setActive(await client.unrevertSession(active.id));
      // The restore rewrote files on disk — the viewer/tree re-list.
      setFsRevision((n) => n + 1);
    }).finally(() => setRevertBusy(false));
  };

  // The ask panel lives inside ChatPane — visible in the chat section and
  // in an engaged workspace; everywhere else the nav badge carries the
  // count so a blocked run is never visible.
  const askPanelVisible = section === "chat" || (section === "workspace" && effectiveWorkspacePath !== null);

  // Shell and Analytics are single-pane sections — no nested nav content,
  // so the sidebar is hidden and the pane gets the width (SIDEBAR_HIDDEN,
  // top of file). Computed before the JSX: inside the aside's children TS
  // narrows `section`, which would flag this same comparison as
  // unreachable there.
  const showNestedPanel = !SIDEBAR_HIDDEN.includes(section);

  // Effective theme: a custom theme (config id matching a loaded theme
  // file) applies its palette inline; built-ins resolve through the catalog
  // (unknown ids fall back to the default). ThemeProvider applies it to
  // <html> and caches it for the next boot's inline script.
  const customTheme = configTheme !== undefined ? customThemes.find((t) => t.id === configTheme) : undefined;
  const theme = customTheme !== undefined && configTheme !== undefined ? configTheme : resolveThemeId(configTheme);
  // The active PALETTE as data (themes.ts single source of truth) — feeds
  // the Monaco editor directly, so theme switches re-skin it on the fly
  // with no dependency on applied CSS. Custom themes carry their own
  // colors; built-ins resolve through the catalog (theme is a ThemeId
  // whenever customTheme is undefined).
  const themeColors: ThemeColors = customTheme?.colors ?? THEME_COLORS[theme as ThemeId];

  /** Persist a theme pick; config.updated syncs the TUI (and this tab). */
  const selectTheme = async (next: string): Promise<void> => {
    try {
      await client.putConfig({ theme: next });
      await refreshConfig();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  /** Save a custom theme from the picker's form, then select it. */
  const saveCustomTheme = async (input: CustomThemeInput): Promise<CustomTheme> => {
    const failures = themeContrastFailures(input.colors);
    if (failures.length > 0) {
      throw new Error(`Theme does not meet WCAG AA contrast: ${failures.map((failure) => `${failure.role} (${failure.ratio.toFixed(2)}:1)`).join(", ")}`);
    }
    const id = slugifyThemeId(input.name);
    const saved = await client.putCustomTheme(id, input);
    await refreshCustomThemes();
    await selectTheme(id);
    return saved;
  };

  // The chat surface element — shared by the Chat section and the
  // workspace's Chat view (identical props; one source of truth).
  const chatPane = (
    <ChatPane
      client={client}
      list={list}
      active={active}
      configDefault={configDefault}
      configDefaultAgent={configDefaultAgent}
      preferZdr={configPreferZdr}
      agents={agents}
      refreshAgents={refreshAgents}
      refreshProviders={refreshProviders}
      providersFetching={providersFetching}
      messages={messages}
      draft={draft}
      setDraft={setDraft}
      onSubmit={() => void submit()}
      runActive={runActive}
      waiting={waiting}
      error={error}
      onSwitchWorkspace={() => navigate("workspace")}
      subagents={subagents}
      pendingAsk={pendingAsk}
      askQueued={Math.max(0, askTotal - 1)}
      onAskDone={
        headFromChild
          ? () => setPendingChildAsks((list) => list.slice(1))
          : headPermission !== undefined
            ? () => setPendingAsks((list) => list.slice(1))
            : () => setPendingQuestions((list) => list.slice(1))
      }
      startPlaceholder={
        section === "workspace" ? "Describe a task for this workspace…" : "Start a chat…"
      }
      onForkMessage={forkAtMessage}
      onRevertMessage={revertToMessage}
      onRestoreRevert={restoreRevert}
      revertBusy={revertBusy}
      queuedInputs={queuedState.inputs}
      sendingIds={queuedState.sendingIds}
      onSendQueued={(input) => void sendQueued(input)}
      onCancelQueued={(input) => void cancelQueued(input)}
      onEditQueued={editQueued}
      usage={usage}
      // Learn chip: only with an open session (drafts use the Skills page's
      // Learn form — a fresh learn session there has the same effect).
      onLearn={active !== null ? (request) => void learn(request) : undefined}
    />
  );

  return (
    <ThemeProvider theme={theme} customColors={customTheme?.colors}>
    <a className="skip-link" href="#main-content">Skip to main content</a>
    <div className="app">
      {/* Pending asks render INLINE inside the chat pane (no overlay, no
          dim) — the app stays fully navigable while a run is blocked. The
          Chat nav item carries a count badge when the user is elsewhere. */}
      <MasterNav
        section={section}
        onNavigate={navigate}
        askBadge={askPanelVisible ? 0 : askTotal}
        onThemePicker={() => setThemePickerOpen(true)}
      />

      {/* Shell and Analytics are single-pane sections — no nested nav
          content, so the sidebar is hidden and the pane gets the width. */}
      {showNestedPanel && (
      <aside className="nested-panel">
        <div className="nested-title">
          {section === "settings"
            ? "Settings"
            : section === "workspace"
              ? "Workspace"
              : section === "agents"
                ? "Agents"
                : section === "tools"
                  ? "Tools"
                  : "Chat"}
         </div>
        {section === "chat" && (
          <>
            {/* Draft state: no session row exists until the first message is
                sent (submit() creates it) — opencode's new-chat pattern. */}
            <button className="new-session" onClick={() => pushRoute({ section: "chat", sessionId: null })}>
              + new session
            </button>
            <nav className="session-list">
              {sessions.filter((s) => s.meta.parent === undefined).map((s) => (
                <button
                  key={s.id}
                   className={active?.id === s.id ? "session active" : "session"}
                   aria-current={active?.id === s.id ? "page" : undefined}
                   title={s.title.length > 0 ? s.title : "Untitled session"}
                  onClick={() => pushRoute({ section: "chat", sessionId: s.id }, s)}
                >
                  <span className="title">{s.title.length > 0 ? s.title : "(untitled)"}</span>
                  <span className="dim">{s.workbench}</span>
                </button>
              ))}
            </nav>
          </>
        )}
        {section === "workspace" && effectiveWorkspacePath === null && (
          <WorkspaceNav
            client={client}
            workspaces={workspaces}
            selected={effectiveWorkspacePath}
            onSelect={selectWorkspace}
            onAdd={addWorkspace}
          />
        )}
        {section === "workspace" && effectiveWorkspacePath !== null && (
          <>
            {/* Active-mode head: the selected workspace's title + path.
                Clicking it swaps the panel back to the picker list. */}
            <button
              type="button"
              className="workspace-item workspace-active-head"
              title={`${effectiveWorkspacePath} — switch workspace`}
               onClick={() => selectWorkspace(null)}
               aria-label={`Switch workspace from ${wsBasename(effectiveWorkspacePath)}`}
            >
              <span className="ws-item-head">
                <FolderGlyph />
                <span className="title">{wsBasename(effectiveWorkspacePath)}</span>
              </span>
              <span className="dim path">{effectiveWorkspacePath}</span>
              <span className="switch" aria-hidden="true">
                ⇄
              </span>
            </button>
            {/* Draft state: the code session (rooted at this workspace) is
                created by submit() on the first message. */}
            <button
              className="new-session"
              onClick={() =>
                pushRoute({ section: "workspace", wsPath: effectiveWorkspacePath, view: workspaceView, sessionId: null })
              }
            >
              + new session
            </button>
            <nav className="session-list">
              {workspaceSessions.length === 0 && (
                <p className="dim">No sessions in this workspace yet.</p>
              )}
              {workspaceSessions.filter((s) => s.meta.parent === undefined).map((s) => (
                <button
                  key={s.id}
                   className={active?.id === s.id ? "session active" : "session"}
                   aria-current={active?.id === s.id ? "page" : undefined}
                  onClick={() =>
                    pushRoute(
                      { section: "workspace", wsPath: effectiveWorkspacePath, view: workspaceView, sessionId: s.id },
                      s,
                    )
                  }
                >
                  <span className="title">{s.title.length > 0 ? s.title : "(untitled)"}</span>
                </button>
              ))}
            </nav>
          </>
        )}
        {section === "settings" && (
          <SettingsNav
            selected={settingsSection}
            onSelect={(next) => pushRoute({ section: "settings", settingsSection: next })}
          />
        )}
        {section === "agents" && (
          <AgentsNav
            agents={agents}
            selected={effectiveAgentId}
            onSelect={(name) => pushRoute({ section: "agents", name, creating: false })}
            onCreate={() => pushRoute({ section: "agents", name: null, creating: true })}
            busy={false}
          />
        )}
        {section === "tools" && (
          <ToolsNav
            tools={tools}
            selected={effectiveToolId}
            onSelect={(name) => pushRoute({ section: "tools", name, creating: false })}
            onCreate={() => pushRoute({ section: "tools", name: null, creating: true })}
            busy={false}
          />
        )}
        {section === "skills" && (
          <SkillsNav
            skills={skills}
            selected={effectiveSkillId}
            onSelect={(name) => pushRoute({ section: "skills", name, creating: false })}
            onCreate={() => pushRoute({ section: "skills", name: null, creating: true })}
            busy={false}
          />
        )}
      </aside>
      )}

      {section === "settings" ? (
          <main id="main-content" className="settings-pane">
          <SettingsPane
            client={client}
            list={list}
            refresh={refreshProviders}
            fetching={providersFetching}
            section={settingsSection}
            agents={agents}
            userName={configUserName}
            preferZdr={configPreferZdr}
            defaultAgent={configDefaultAgent}
            imageGen={configImageGen}
            videoGen={configVideoGen}
            theme={theme}
            onOpenThemePicker={() => setThemePickerOpen(true)}
          />
        </main>
      ) : section === "agents" ? (
        <main id="main-content" className="agents-pane">
          {creatingAgent ? (
            <AgentCreateForm
              existing={agents.map((a) => a.name)}
              onSubmit={createAgent}
              onCancel={() => setCreatingAgent(false)}
            />
          ) : (
            <AgentsPane
              client={client}
              agents={agents}
              selectedId={effectiveAgentId}
              activeSessionId={active?.id ?? null}
              refresh={refreshAgents}
              onNotice={pushNotice}
            />
          )}
        </main>
      ) : section === "tools" ? (
        <main id="main-content" className="agents-pane">
          {creatingTool ? (
            <ToolCreateForm
              existing={tools.map((t) => t.name)}
              onSubmit={createTool}
              onCancel={() => setCreatingTool(false)}
            />
          ) : (
            <ToolsPane
              client={client}
              tools={tools}
              selectedId={effectiveToolId}
              refresh={refreshTools}
              onNotice={pushNotice}
              themeColors={themeColors}
            />
          )}
        </main>
      ) : section === "skills" ? (
        <main id="main-content" className="agents-pane">
          {creatingSkill ? (
            skillLearnOpen ? (
              <SkillLearnForm
                client={client}
                list={list}
                refreshProviders={refreshProviders}
                preferZdr={configPreferZdr}
                configDefault={configDefault}
                onLearned={async (sessionId) => {
                  setSkillLearnOpen(false);
                  setCreatingSkill(false);
                  pushNotice("learn session started — watch it distill the skill", "info");
                  pushRoute({ section: "chat", sessionId });
                }}
                onBack={() => setSkillLearnOpen(false)}
              />
            ) : (
              <SkillCreateForm
                existing={skills.map((s) => s.name)}
                onSubmit={createSkill}
                onCancel={() => setCreatingSkill(false)}
                onLearn={() => setSkillLearnOpen(true)}
              />
            )
          ) : (
            <SkillsPane
              client={client}
              skills={skills}
              selectedId={effectiveSkillId}
              refresh={refreshSkills}
              onNotice={pushNotice}
            />
          )}
        </main>
      ) : section === "analytics" ? (
        <main id="main-content" className="settings-pane">
          <AnalyticsPane client={client} themeColors={themeColors} />
        </main>
      ) : section === "shell" ? (
        <main id="main-content" className="shell-main">
          <ShellPane client={client} themeColors={themeColors} />
        </main>
      ) : section === "workspace" && effectiveWorkspacePath === null ? (
        <main id="main-content" className="chat">
          <p className="dim empty">Select or add a workspace to start.</p>
        </main>
      ) : (
        <>
          {section === "workspace" ? (
            // Workspace center: the [Chat | Files] switch on top, then the
            // chat surface or the tabbed file viewer. The file tree (right
            // aside) opens files into the viewer.
            <div className="workspace-center">
              <div className="pane-switch-header">
                <div className="pane-switch" role="tablist" aria-label="Workspace view">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={workspaceView === "chat"}
                    className={workspaceView === "chat" ? "active" : undefined}
                    onClick={() =>
                      pushRoute({
                        section: "workspace",
                        wsPath: effectiveWorkspacePath,
                        view: "chat",
                        sessionId: active?.id ?? null,
                      })
                    }
                  >
                    Chat
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={workspaceView === "files"}
                    className={workspaceView === "files" ? "active" : undefined}
                    onClick={() =>
                      pushRoute({
                        section: "workspace",
                        wsPath: effectiveWorkspacePath,
                        view: "files",
                        sessionId: active?.id ?? null,
                      })
                    }
                  >
                    Files
                  </button>
                </div>
              </div>
              {workspaceView === "files" && effectiveWorkspacePath !== null ? (
                <FileView
                  client={client}
                  root={effectiveWorkspacePath}
                  openFiles={openFiles}
                  activeFile={activeFile}
                  themeColors={themeColors}
                  changedFiles={changedFiles}
                  fsRevision={fsRevision}
                  onFileSeen={clearChangedFile}
                  onSelectTab={selectFileTab}
                  onCloseTab={closeFileTab}
                />
              ) : (
                chatPane
              )}
            </div>
          ) : (
            chatPane
          )}
          {section === "workspace" && effectiveWorkspacePath !== null && (
            <FileTree
              client={client}
              root={effectiveWorkspacePath}
              onOpenFile={openFile}
              activePath={workspaceView === "files" ? activeFile : null}
              refreshToken={fsRevision}
            />
          )}
        </>
      )}

      {/* Theme picker (germaniii.com's preview-card grid) — opened from the
          nav's palette button or Settings → General; custom themes
          (~/.config/bai/themes/*.json) render as cards and the "+ Custom
          Theme" card opens the creation form. */}
      <ThemeSelectorModal
        isOpen={themePickerOpen}
        onClose={() => setThemePickerOpen(false)}
        currentTheme={theme}
        onSelect={(next) => void selectTheme(next)}
        customThemes={customThemes}
        onSaveCustom={saveCustomTheme}
      />

      {/* Agents/tools mutation feedback — bottom-right toast. */}
      <Toast notice={notice} onDismiss={() => setNotice(null)} />
    </div>
    </ThemeProvider>
  );
}

/**
 * Master rail: brand mark, workbench sections (Image/Video disabled until
 * their phases land), theme picker + Settings pinned at the bottom.
 * Icons via lucide-react (the one icon dependency).
 */
function MasterNav({
  section,
  onNavigate,
  askBadge = 0,
  onThemePicker,
}: {
  section: Section;
  onNavigate: (s: Section) => void;
  /** Pending-ask count for the Chat badge (0 = hidden). */
  askBadge?: number;
  /** Open the theme picker modal (the palette button above Settings). */
  onThemePicker: () => void;
}) {
  return (
      <nav className="master-nav" aria-label="Primary">
        {/* Same asset as the favicon (public/icon.svg) — one logo, one truth. */}
        <img src="/icon.svg" alt="bai" className="brand-mark" />
      <div className="master-items">
        <MasterItem section="chat" label="Chat" active={section === "chat"} onNavigate={onNavigate} badge={askBadge}>
          <MessageCircle className="nav-icon" aria-hidden="true" />
        </MasterItem>
        <MasterItem section="workspace" label="Workspace" active={section === "workspace"} onNavigate={onNavigate}>
          <Folder className="nav-icon" aria-hidden="true" />
        </MasterItem>
        <MasterItem section="image" label="Image Gen" disabled onNavigate={onNavigate}>
          <Image className="nav-icon" aria-hidden="true" />
        </MasterItem>
        <MasterItem section="video" label="Video Gen" disabled onNavigate={onNavigate}>
          <Video className="nav-icon" aria-hidden="true" />
        </MasterItem>
        {/* Workbenches above the line, agent machinery below it. */}
        <div className="nav-divider" role="separator" aria-label="workbenches / agents" />
        <MasterItem section="agents" label="Agents" active={section === "agents"} onNavigate={onNavigate}>
          <Cpu className="nav-icon" aria-hidden="true" />
        </MasterItem>
        <MasterItem section="tools" label="Tools" active={section === "tools"} onNavigate={onNavigate}>
          <Wrench className="nav-icon" aria-hidden="true" />
        </MasterItem>
        <MasterItem section="skills" label="Skills" active={section === "skills"} onNavigate={onNavigate}>
          <Zap className="nav-icon" aria-hidden="true" />
        </MasterItem>
        <MasterItem section="analytics" label="Analytics" active={section === "analytics"} onNavigate={onNavigate}>
          <ChartColumn className="nav-icon" aria-hidden="true" />
        </MasterItem>
      </div>
      <div className="master-spacer" />
      <button type="button" className="master-item" aria-label="Choose a theme" onClick={onThemePicker}>
        <Palette className="nav-icon" aria-hidden="true" />
        <span className="nav-label">Theme</span>
      </button>
      {/* Shell sits directly above Settings — a pinned utility like Theme. */}
      <MasterItem section="shell" label="Shell" active={section === "shell"} onNavigate={onNavigate}>
        <Terminal className="nav-icon" aria-hidden="true" />
      </MasterItem>
      <MasterItem section="settings" label="Settings" active={section === "settings"} onNavigate={onNavigate}>
        <SlidersHorizontal className="nav-icon" aria-hidden="true" />
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
  badge = 0,
  children,
}: {
  section: Section;
  label: string;
  active?: boolean;
  disabled?: boolean;
  onNavigate: (s: Section) => void;
  /** Pending-ask count badge (Chat only; 0 = hidden). */
  badge?: number;
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
      {badge > 0 && (
        <span className="nav-badge" aria-label={`${badge} pending ask${badge === 1 ? "" : "s"}`}>
          {badge}
        </span>
      )}
    </button>
  );
}

function basename(p: string): string {
  const parts = p.split("/").filter((s) => s.length > 0);
  return parts[parts.length - 1] ?? p;
}

/** Local alias — the sessions panel head shows the workspace's basename. */
const wsBasename = basename;
