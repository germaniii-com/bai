import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Bot, ChartColumn, ChevronLeft, ChevronRight, Clock, FileText, Folder, Image, Menu, MessageCircle, Palette, Search, SlidersHorizontal, SquarePen, Terminal, Video, Wrench, Zap } from "lucide-react";
import { BaiClient, eventMux, followSession } from "@bai/api/client";
import type { AttachmentRef, Input, JobsConfig, MediaGenConfig, Message, PermissionRequest, PlanFile, QuestionRequest, Session, SessionUsage, ThemeColors, ThemeId, TodoItem } from "@bai/shared";
import { resolveThemeId, isThemeId, slugifyThemeId, themeContrastFailures, THEME_COLORS, buildLearnRequest, collapseMentions, deriveFolderAliases, mentionDisplayToken, resolveAliasPath, toMentionPath, type CustomTheme, type CustomThemeInput } from "@bai/shared";
import { applyEvent, applyChildAskEvent, applyNotesEvent, applyPermissionEvent, applyPlansEvent, applyQuestionEvent, applyQueuedInputEvent, applyTodosEvent, emptyQueuedInputs, queuedInputsFromSnapshot, todosFromSession, messageText } from "./state";
import { applyFileWatch, emptyFileWatch, type FileWatchState } from "./state-files";
import { applySubagentEvent, emptySubagentState, trackSubagents, type SubagentState } from "./state-subagents";
import { useHistoryPager } from "./use-history-pager";
import { usePagedSessions } from "./use-paged-sessions";
import { useProviders } from "./use-providers";
import { useAgents } from "./use-agents";
import { useTools } from "./use-tools";
import { useSkills } from "./use-skills";
import { useAutomations } from "./use-automations";
import { SettingsNav, SettingsPane, type SettingsSection } from "./settings";
import { ADVANCED_NAV_IDS, NAV_ITEMS, visibleNavIds } from "./nav-items";
import { parseRoute, routeToPath, type Route } from "./router";
import { ThemeProvider } from "./theme";
import { ThemeSelectorModal } from "./theme-picker";
import { WorkspaceNav } from "./workspace";
import { FileTree } from "./file-tree";
import { AddWorkspaceModal } from "./add-workspace-modal";
import { TodosPanel } from "./todos-panel";
import { PlansPanel } from "./plans-panel";
import { NotesPanel } from "./notes-panel";
import { FileView } from "./file-view";
import { ChatPane } from "./chat-pane";
import { AgentsNav, AgentsPane } from "./agents";
import { ToolsNav, ToolsPane } from "./tools";
import { SkillsNav, SkillsPane, SkillLearnForm } from "./skills";
import { AutomationsNav, AutomationsPane } from "./automations";
import { AnalyticsPane } from "./analytics";
import { ImagePane } from "./image";
import { VideoPane } from "./video";
import { ShellPane } from "./shell";
import { AskPanel, type PendingAsk } from "./ask-panel";
import { Toast, type Notice } from "./toast";
import { TooltipLayer } from "./tooltip";
import { useLongPress } from "./use-long-press";
import { useMediaQuery } from "./use-media-query";
import { Button, Chip, ContextMenu, Drawer, IconButton, ListItem, NavItem, SubNavCreate, SubNavToggle, Tabs, TextInput, type ContextMenuItem } from "./components";

/**
 * Master-rail sections. Image/Video are Phase 5 placeholders — the rail
 * renders them disabled (same stance as the TUI's placeholder views);
 * chat, workspace, and settings are reachable.
 */
type Section = "chat" | "workspace" | "agents" | "tools" | "skills" | "automations" | "analytics" | "image" | "video" | "shell" | "settings";

/**
 * Sections that render without the nested sidebar (single-pane views — no
 * contextual nav content, so the main pane gets the full width). Add or
 * remove section names here to change which views hide the sidebar.
 */
const SIDEBAR_HIDDEN: Section[] = ["shell", "analytics", "image", "video"];

/** Workspace right-rail resize bounds + per-device persistence key. */
const WORKSPACE_SIDEBAR_MIN = 180;
const WORKSPACE_SIDEBAR_MAX = 560;
const WORKSPACE_SIDEBAR_DEFAULT = 240;
const WORKSPACE_SIDEBAR_KEY = "bai.workspaceSidebarWidth";

/** Clamp a requested rail width to the allowed range (NaN → default). */
function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return WORKSPACE_SIDEBAR_DEFAULT;
  return Math.min(WORKSPACE_SIDEBAR_MAX, Math.max(WORKSPACE_SIDEBAR_MIN, Math.round(width)));
}

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
  // The settings section (General | Model Providers | …) — the nested
  // sidebar's entries; each renders one scrollable heading-content page.
  // User name lives under General (no separate User section).
  const [settingsSection, setSettingsSection] = useState<SettingsSection>(
    bootRoute.section === "settings" ? bootRoute.settingsSection : "general",
  );
  const [workspaces, setWorkspaces] = useState<string[]>([]);
  // Extra folders attached per workspace (config.workspaceFolders).
  const [workspaceFolders, setWorkspaceFolders] = useState<Record<string, string[]>>({});
  // The multi-select "Add folders to workspace" modal.
  const [addFoldersOpen, setAddFoldersOpen] = useState(false);
  // File-tree right-click menu + the pending "Add to Chat" mention insert.
  const [treeMenu, setTreeMenu] = useState<{ x: number; y: number; abs: string; kind: "file" | "dir" | "root" } | null>(null);
  // Session-row long-press menu (iOS has no reliable contextmenu).
  const [sessionMenu, setSessionMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  // Mobile workspace rail drawer (replaces the hidden right column on phones).
  const [railOpen, setRailOpen] = useState(false);
  const [railTab, setRailTab] = useState<"files" | "todos" | "notes" | "plans">("files");
  // Mobile subnav drawer (sessions / settings / agents list…) — replaces the
  // horizontal strip under the master row; toggled from the right edge of
  // MasterNav (opposite the brand mark).
  const [subnavOpen, setSubnavOpen] = useState(false);
  // One content tree: desktop keeps the nested column; ≤640px uses the Drawer.
  const isNarrow = useMediaQuery("(max-width: 640px)");
  const [pendingMention, setPendingMention] = useState<{ path: string; type: "file" | "dir"; nonce: number } | null>(null);
  const [archivedWorkspaces, setArchivedWorkspaces] = useState<string[]>([]);
  const [workspacePath, setWorkspacePath] = useState<string | null>(
    bootRoute.section === "workspace" ? bootRoute.wsPath : null,
  );
  // Paged session lists (UI): newest window first, older pages on demand via
  // a keyset cursor. Filter inputs are deferred so typing doesn't thrash the
  // server; the filter runs server-side so it matches rows beyond the loaded
  // window. `roots` excludes child (subagent) sessions, keeping pages dense.
  const [chatSessionFilter, setChatSessionFilter] = useState("");
  const deferredChatFilter = useDeferredValue(chatSessionFilter);
  const [wsSessionFilter, setWsSessionFilter] = useState("");
  const deferredWsFilter = useDeferredValue(wsSessionFilter);
  const {
    sessions,
    setSessions,
    hasMore: chatSessionsHasMore,
    loadingMore: chatSessionsLoadingMore,
    loadMore: loadMoreChatSessions,
    refresh: refreshSessions,
  } = usePagedSessions(client, { workbench: "chat", q: deferredChatFilter });
  const {
    sessions: workspaceSessions,
    setSessions: setWorkspaceSessions,
    hasMore: wsSessionsHasMore,
    loadingMore: wsSessionsLoadingMore,
    loadMore: loadMoreWsSessions,
    refresh: refreshWorkspaceSessions,
  } = usePagedSessions(client, {
    cwd: workspacePath ?? undefined,
    q: deferredWsFilter,
    enabled: workspacePath !== null,
  });
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
  const [active, setActive] = useState<Session | null>(null);
  // Sessions with unseen activity (new messages, a finished run, an ask) —
  // their sidebar label renders emphasized ("bold") until opened. Fed by the
  // global firehose and cleared when the session becomes active.
  const [unreadSessions, setUnreadSessions] = useState<Set<string>>(new Set());
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
  // Composer `#file` alias map (leaf token → full workspace-relative path).
  // Owned here with the draft so seed flows (revert/fork/edit) collapse the
  // stored full paths back to leaves and rehydrate the map.
  const [draftMentions, setDraftMentions] = useState<Record<string, string>>({});
  // Uploaded attachments for the next send (owned here with the draft).
  const [draftAttachments, setDraftAttachments] = useState<AttachmentRef[]>([]);
  const [attachmentsBusy, setAttachmentsBusy] = useState(false);
  // Bumped by the sidebar's "+ New Chat"/"+ New session" buttons — the
  // composer hub focuses its input whenever the token changes.
  const [composerFocusToken, setComposerFocusToken] = useState(0);
  // Attachments are a chat-only affordance (cwd-less sessions) — drop any
  // pending chips when leaving the chat section.
  useEffect(() => {
    if (section !== "chat") setDraftAttachments([]);
  }, [section]);
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
  // The active session's agent-maintained task list (the `todo` tool) —
  // seeded from meta.todos and kept live by durable `todos.updated` events;
  // rendered in the workspace right rail below the file tree.
  const [todos, setTodos] = useState<TodoItem[]>([]);
  // The active session's notes (notes.md) and plan files, both session-scoped
  // and file-backed. Seeded on session switch and kept live by durable
  // notes.updated / plans.updated events.
  const [notes, setNotes] = useState("");
  const [plans, setPlans] = useState<PlanFile[]>([]);
  // Open plan tabs + the active one (mutually exclusive with activeFile — a
  // plan opens the editable editor in the Files view).
  const [openPlans, setOpenPlans] = useState<string[]>([]);
  const [activePlan, setActivePlan] = useState<string | null>(null);
  // Workspace right-rail width (the drag handle on its left edge) — a
  // per-device UI preference persisted in localStorage, clamped to sane bounds.
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    try {
      const raw = window.localStorage.getItem(WORKSPACE_SIDEBAR_KEY);
      return raw !== null ? clampSidebarWidth(Number(raw)) : WORKSPACE_SIDEBAR_DEFAULT;
    } catch {
      return WORKSPACE_SIDEBAR_DEFAULT;
    }
  });
  const [resizingSidebar, setResizingSidebar] = useState(false);
  const sidebarWidthRef = useRef(sidebarWidth);
  sidebarWidthRef.current = sidebarWidth;
  // Live subagent tracking for the chat pane's task nodes (TUI parity):
  // children of the active session, fed from the firehose — live status
  // (asking/running) and the child session ids the inline transcripts open.
  const [subagents, setSubagents] = useState<SubagentState>(emptySubagentState);
  // Latest tracked children readable from the firehose closure (the
  // subscription is created once; the child-ask gate keys on tracked
  // children, not the paged session list).
  const subagentsRef = useRef<SubagentState>(emptySubagentState);
  subagentsRef.current = subagents;
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
  /** config router.enabled — the Model Providers "Run as router" toggle. */
  const [configRouterEnabled, setConfigRouterEnabled] = useState<boolean | undefined>(undefined);
  /** config ui.advancedMode — the General pane's nav toggle (unset = basic). */
  const [configAdvancedMode, setConfigAdvancedMode] = useState<boolean | undefined>(undefined);
  /** config ui.showBuiltins — show built-in agents/tools/skills in their lists. */
  const [configShowBuiltins, setConfigShowBuiltins] = useState<boolean | undefined>(undefined);
  /** config ui.hiddenNav — section ids hidden from the rail. */
  const [configHiddenNav, setConfigHiddenNav] = useState<string[] | undefined>(undefined);
  const [configImageGen, setConfigImageGen] = useState<MediaGenConfig | undefined>(undefined);
  const [configVideoGen, setConfigVideoGen] = useState<MediaGenConfig | undefined>(undefined);
  const [configJobs, setConfigJobs] = useState<JobsConfig | undefined>(undefined);
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
  const { automations, refresh: refreshAutomations } = useAutomations(client);
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
  const [selectedAutomation, setSelectedAutomation] = useState<string | null>(
    bootRoute.section === "automations" ? bootRoute.name : null,
  );
  // Creation flows: true while the create form (pre-filled, editable name)
  // is open in the main pane — no file is written until the form submits.
  const [creatingAgent, setCreatingAgent] = useState(bootRoute.section === "agents" && bootRoute.creating);
  const [creatingTool, setCreatingTool] = useState(bootRoute.section === "tools" && bootRoute.creating);
  const [creatingSkill, setCreatingSkill] = useState(bootRoute.section === "skills" && bootRoute.creating);
  const [creatingAutomation, setCreatingAutomation] = useState(
    bootRoute.section === "automations" && bootRoute.creating,
  );
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
      setConfigRouterEnabled(config.router?.enabled);
      setConfigAdvancedMode(config.ui?.advancedMode);
      setConfigShowBuiltins(config.ui?.showBuiltins);
      setConfigHiddenNav(config.ui?.hiddenNav);
      setConfigImageGen(config.imageGen);
      setConfigVideoGen(config.videoGen);
      setConfigJobs(config.jobs);
      setConfigTheme(config.theme);
      setWorkspaces(config.workspaces ?? []);
      setWorkspaceFolders(config.workspaceFolders ?? {});
      setArchivedWorkspaces(config.archivedWorkspaces ?? []);
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
          void refreshAutomations();
          // File-change detection is live-only — events missed during a
          // firehose drop never replay. Heal the viewer and tree on every
          // (re)connect: one refetch of the active file + expanded dirs.
          setFsRevision((n) => n + 1);
          // Notes/plans are file-backed and out-of-band: heal them for the
          // active session too, so a drop can't leave stale panels.
          const healedSessionId = activeRef.current?.id;
          if (healedSessionId !== undefined) {
            void client
              .getNotes(healedSessionId)
              .then((n) => setNotes(n ?? ""))
              .catch(() => {});
            void client.listPlans(healedSessionId).then(setPlans).catch(() => {});
          }
        }
        // Live file-change detection (workspace viewer): patch parts (git
        // workspaces, covers bash) + fs.write/fs.edit results (fallback)
        // from ANY session — the firehose is global. Open tabs get change
        // dots; the viewer and tree refresh via fsRevision.
        const changedFiles = applyFileWatch(fileWatchRef.current, evt, {
          roots: wsRootsRef.current,
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
        // Unread marker: activity on a session the user is NOT currently
        // viewing flags its sidebar row (emphasized label) until opened. The
        // active session is cleared by the effect below. Types are the
        // meaningful "something happened" signals — metadata edits, new
        // messages, a finished run, and blocking asks.
        const activitySessionId = evt.sessionId;
        if (
          activitySessionId !== undefined &&
          activitySessionId !== activeRef.current?.id &&
          (evt.type === "session.updated" ||
            evt.type === "message.created" ||
            evt.type === "run.finished" ||
            evt.type === "permission.asked" ||
            evt.type === "question.asked")
        ) {
          setUnreadSessions((prev) => {
            if (prev.has(activitySessionId)) return prev;
            const next = new Set(prev);
            next.add(activitySessionId);
            return next;
          });
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
        if (evt.type === "automations.updated") {
          void refreshAutomations();
        }
        // A subagent's permission ask pops the same modal a parent ask
        // gets — otherwise the child would sit blocked with no dialog.
        if (evt.type === "permission.asked" || evt.type === "permission.replied") {
          // Gate on TRACKED children (TUI parity) — the session lists are
          // paged, so a scan of loaded sessions would miss an ask from a
          // child beyond the current page.
          setPendingChildAsks((list) =>
            applyChildAskEvent(list, evt, (id) => subagentsRef.current.children.has(id)),
          );
        }
        // Subagent tracking (TUI parity): every firehose event may advance
        // a tracked child's live activity (run lifecycle, permission asks,
        // streamed tool/text parts).
        setSubagents((prev) => applySubagentEvent(prev, evt, activeRef.current?.id));
    });
    return unsubscribe;
  }, [client, refreshConfig, refreshSessions, refreshWorkspaceSessions, refreshAgents, refreshTools, refreshSkills, refreshAutomations]);

  // The active session's ID — the session stream effect keys on this (not
  // the object reference) so session.updated patches don't tear it down.
  const activeId = active?.id;
  // Opening a session acknowledges its activity — its row stops emphasizing.
  useEffect(() => {
    if (activeId === undefined) return;
    setUnreadSessions((prev) => {
      if (!prev.has(activeId)) return prev;
      const next = new Set(prev);
      next.delete(activeId);
      return next;
    });
  }, [activeId]);
  // Scroll-back pagination: newest 100 messages first; older pages prepend on
  // demand (chat pane scroll-to-top). Live events still flow through the
  // effect's own reducer into `setMessages`.
  const pager = useHistoryPager({ client, sessionId: activeId, setMessages });
  const { reset: resetPager, seed: seedPager } = pager;

  useEffect(() => {
    streamCtrl.current?.abort();
    setError(null); // a session switch drops the previous session's error banner
    setSubagents(emptySubagentState); // the previous session's children are gone
    resetPager();
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
    setTodos([]); // draft state: the previous session's todos are gone
    setNotes(""); // draft state: no notes/plans/plan tabs
    setPlans([]);
    setOpenPlans([]);
    setActivePlan(null);
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
  setTodos([]); // clear the previous session's list while the snapshot loads
  setNotes(""); // session-scoped notes/plans/plan tabs reset on switch
  setPlans([]);
  setOpenPlans([]);
  setActivePlan(null);
  void (async () => {
    try {
      // Snapshot first, then follow the durable stream from its frontier.
      // followSession resumes from the cursor on drops (idle timeouts,
      // restarts) — replaying from 0 would duplicate the snapshot instead.
      // Windowed to the newest page — older pages load on scroll-back via
      // the pager (`loadOlder`) using the snapshot's `nextCursor`.
      const snap = await client.historySnapshot(activeId, { limit: 100 });
      if (ctrl.signal.aborted) return; // switched again mid-fetch — stale
      setMessages(snap.messages);
      seedPager(snap.hasMore === true, snap.nextCursor ?? null);
      // A run may already be draining (mid-run switch, or the snapshot was
      // taken right after our own submit) — its run.started predates the
      // cursor, so the snapshot is the only reliable signal.
      setRunActive(snap.runActive === true);
      // The context tracker seeds from meta.lastUsage (no wait for the next
      // turn); live run.usage events take over from here.
      setUsage(snap.usage ?? null);
      // The todo list seeds from meta.todos (the snapshot doesn't carry it);
      // replayed/durable todos.updated events take over live.
      setTodos(todosFromSession(activeRef.current));
        // Notes + plans are files, not part of the session row: seed with a
        // direct fetch; durable notes.updated/plans.updated events take over.
        const [loadedNotes, loadedPlans] = await Promise.all([
          client.getNotes(activeId),
          client.listPlans(activeId),
        ]);
        if (ctrl.signal.aborted) return;
        setNotes(loadedNotes ?? "");
        setPlans(loadedPlans);
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
            } else if (evt.type === "todos.updated") {
              // The workspace todo panel's live feed (the todo tool replaces
              // the whole list each call).
              setTodos((list) => applyTodosEvent(list, evt));
            } else if (evt.type === "notes.updated") {
              // The Notes panel's live feed (the agent or another surface).
              setNotes((current) => applyNotesEvent(current, evt));
            } else if (evt.type === "plans.updated") {
              // The Plans panel's live feed (plan.write / editor).
              setPlans((list) => applyPlansEvent(list, evt));
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
    // resetPager/seedPager are stable (useCallback), so paging state changes
    // never re-run this effect.
  }, [activeId, client, bfcacheEpoch, resetPager, seedPager]);

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
  // Extra folders attached to the active workspace (stable reference while
  // config is unchanged — the mention effect keys on it).
  const workspaceExtras = useMemo(
    () => (effectiveWorkspacePath !== null ? (workspaceFolders[effectiveWorkspacePath] ?? []) : []),
    [effectiveWorkspacePath, workspaceFolders],
  );
  // External folders as file-tree roots (absolute path + derived `#alias`).
  const workspaceFolderNodes = useMemo(
    () => (effectiveWorkspacePath !== null ? deriveFolderAliases(effectiveWorkspacePath, workspaceExtras) : []),
    [effectiveWorkspacePath, workspaceExtras],
  );
  const effectiveAgentId = agents.some((a) => a.name === selectedAgent) ? selectedAgent : null;
  const effectiveToolId = tools.some((t) => t.name === selectedTool) ? selectedTool : null;
  const effectiveSkillId = skills.some((s) => s.name === selectedSkill) ? selectedSkill : null;
  const effectiveAutomationId = automations.some((a) => a.id === selectedAutomation) ? selectedAutomation : null;
  // config ui.showBuiltins (unset = shown): hide bai's built-in agents/tools/
  // bundled skills from the section lists, leaving the user's own resources.
  const showBuiltins = configShowBuiltins !== false;
  const navAgents = showBuiltins ? agents : agents.filter((a) => a.source !== "builtin");
  const navTools = showBuiltins ? tools : tools.filter((t) => t.origin !== "builtin");
  const navSkills = showBuiltins ? skills : skills.filter((s) => s.builtin !== true);
  // Reachable rail sections: advanced gating (ui.advancedMode) ∩ per-item
  // visibility (ui.hiddenNav). Settings/Theme are always reachable.
  const visibleNav = useMemo(
    () => visibleNavIds(configAdvancedMode === true, configHiddenNav ?? []),
    [configAdvancedMode, configHiddenNav],
  );
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
  // All viewed roots: the workspace root plus its external folders.
  const wsRootsRef = useRef<string[]>([]);
  wsRootsRef.current =
    effectiveWorkspacePath !== null ? [effectiveWorkspacePath, ...workspaceExtras] : [];
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
      // Engagement refetch: agents changed anywhere → fresh list. The
      // provider list feeds the model-override combobox.
      void refreshAgents();
      void refreshProviders();
    }
    if (next === "tools") {
      // Engagement refetch: tools changed anywhere → fresh list.
      void refreshTools();
    }
    if (next === "skills") {
      // Engagement refetch: skills changed anywhere → fresh list.
      void refreshSkills();
    }
    if (next === "automations") {
      // Engagement refetch: automations changed or fired → fresh list + state.
      // The provider list feeds the model-override combobox.
      void refreshAutomations();
      void refreshAgents();
      void refreshProviders();
    }
  }, [refreshProviders, refreshAgents, refreshWorkspaceSessions, refreshTools, refreshSkills, refreshAutomations]);

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
      if (route.section === "automations") {
        setSelectedAutomation(route.name);
        setCreatingAutomation(route.creating);
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

  /**
   * Open the chat/agent session that produced an image (the Image page's
   * "Open chat" action). Resolves the session so the right surface is used:
   * code sessions open in the workspace view, everything else in chat.
   */
  const openSession = useCallback(
    async (sessionId: string): Promise<void> => {
      const session = await client.getSession(sessionId).catch(() => undefined);
      if (session === undefined) return;
      if (session.workbench === "code") {
        pushRoute(
          { section: "workspace", wsPath: session.cwd ?? null, view: "chat", sessionId },
          session,
        );
      } else {
        pushRoute({ section: "chat", sessionId }, session);
      }
    },
    [client, pushRoute],
  );

  const navigate = (next: Section): void => {    // Keep the open session coherent with the section — a chat session in
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
      case "automations":
        pushRoute({ section: "automations", name: effectiveAutomationId, creating: false });
        break;
      case "analytics":
        pushRoute({ section: "analytics" });
        break;
      case "image":
        pushRoute({ section: "image" });
        break;
      case "video":
        pushRoute({ section: "video" });
        break;
      case "shell":
        pushRoute({ section: "shell" });
        break;
    }
  };

  // Keep the pane and the rail in agreement: if the active section is no
  // longer reachable (basic mode, or hidden in Settings → General), fall back
  // to the first visible workbench (then any visible section). Skipped for
  // Settings/other always-reachable views.
  useEffect(() => {
    if (!NAV_ITEMS.some((i) => i.id === section)) return;
    if (visibleNav.has(section)) return;
    const fallback =
      (["chat", "workspace", "image", "video"] as const).find((id) => visibleNav.has(id)) ??
      [...visibleNav][0];
    if (fallback !== undefined) navigate(fallback as Section);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section, visibleNav]);

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
            : section === "automations"
              ? { section: "automations", name: effectiveAutomationId, creating: creatingAutomation }
              : section === "analytics"
            ? { section: "analytics" }
            : section === "image"
              ? { section: "image" }
            : section === "video"
              ? { section: "video" }
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
    setOpenPlans([]);
    setActivePlan(null);
    // Keep the open session only when it belongs to the chosen workspace.
    const keep = path !== null && activeRef.current?.cwd === path ? activeRef.current : null;
    pushRoute({ section: "workspace", wsPath: path, view: "chat", sessionId: keep?.id ?? null }, keep);
  };

  /** Tree file click: open (or focus) a tab and flip to the Files view. */
  const openFile = (path: string): void => {
    setOpenFiles((prev) => (prev.includes(path) ? prev : [...prev, path]));
    setActiveFile(path);
    setActivePlan(null);
    setWorkspaceView("files");
  };

  /** Append a mention at the end of the draft (Files view / no caret). */
  const appendMentionToDraft = (mentionPath: string, type: "file" | "dir"): void => {
    const lead = draft.length > 0 && !/\s$/.test(draft) ? " " : "";
    if (type === "dir") {
      setDraft(`${draft}${lead}#${mentionPath}/ `);
      return;
    }
    const token = mentionDisplayToken(mentionPath, Object.keys(draftMentions));
    setDraftMentions((paths) => ({ ...paths, [token]: mentionPath }));
    setDraft(`${draft}${lead}#${token} `);
  };

  /**
   * File-tree "Add to Chat": mention a file/folder in the composer. With the
   * Chat view active the mention lands at the caret (ChatPane consumes a
   * pending request); otherwise append and switch to Chat.
   */
  const addMentionToChat = (abs: string, kind: "file" | "dir" | "root"): void => {
    if (effectiveWorkspacePath === null) return;
    const mentionPath = toMentionPath(effectiveWorkspacePath, workspaceExtras, abs);
    if (mentionPath === null) return;
    const type: "file" | "dir" = kind === "file" ? "file" : "dir";
    if (section === "workspace" && workspaceView === "chat") {
      setPendingMention({ path: mentionPath, type, nonce: Date.now() });
    } else {
      appendMentionToDraft(mentionPath, type);
      setWorkspaceView("chat");
    }
  };

  const treeMenuItems: ContextMenuItem[] =
    treeMenu === null
      ? []
      : [
          ...(treeMenu.kind === "file"
            ? [
                {
                  label: "Open",
                  icon: <FileText size={14} />,
                  onSelect: () => {
                    openFile(treeMenu.abs);
                    setTreeMenu(null);
                  },
                },
              ]
            : []),
          {
            label: "Add to Chat",
            icon: <MessageCircle size={14} />,
            onSelect: () => {
              addMentionToChat(treeMenu.abs, treeMenu.kind);
              setTreeMenu(null);
            },
          },
        ];

  /** Session long-press menu: Open (click already does this — explicit for a11y). */
  const sessionMenuItems: ContextMenuItem[] =
    sessionMenu === null
      ? []
      : [
          {
            label: "Open session",
            icon: <MessageCircle size={14} />,
            onSelect: () => {
              const s = sessions.find((x) => x.id === sessionMenu.id) ?? workspaceSessions.find((x) => x.id === sessionMenu.id);
              if (s !== undefined) {
                pushRoute(
                  section === "workspace"
                    ? { section: "workspace", wsPath: effectiveWorkspacePath, sessionId: s.id, view: workspaceView }
                    : { section: "chat", sessionId: s.id },
                  s,
                );
              }
              setSessionMenu(null);
            },
          },
        ];

  /**
   * Transcript `#file` chip click: make the owning workspace active (the
   * chip can be clicked from anywhere the session is rendered), then open
   * the file tab in the viewer. The mention path is workspace-relative;
   * normalize it to the same absolute form the file tree uses so the viewer
   * and the tree agree on the path.
   */
  const openMentionedFile = (root: string, path: string): void => {
    if (effectiveWorkspacePath !== root) selectWorkspace(root);
    // An external-folder mention (`#alias/rel`) resolves through the alias map
    // to its real root; otherwise the path is workspace-relative.
    const aliased =
      effectiveWorkspacePath !== null ? resolveAliasPath(effectiveWorkspacePath, workspaceExtras, path) : null;
    const abs =
      aliased !== null
        ? `${aliased.root.replace(/\/+$/, "")}/${aliased.rel}`.replace(/\/+$/, "")
        : path.startsWith("/")
          ? path
          : `${root.replace(/\/+$/, "")}/${path}`;
    openFile(abs);
  };

  /**
   * File-tree drag-and-drop: upload the dropped files into `dir` (an absolute
   * folder inside the active workspace), then refresh the tree/viewer and open
   * the last one (which flips to the Files view). Errors surface on the
   * banner; successful uploads still land.
   */
  const uploadToRoot = async (root: string, dir: string, files: File[]): Promise<void> => {
    if (files.length === 0) return;
    let last: string | undefined;
    for (const file of files) {
      try {
        const uploaded = await client.uploadWorkspaceFile(root, dir, { name: file.name, bytes: file });
        last = uploaded.path;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
    if (last === undefined) return;
    setFsRevision((n) => n + 1);
    openFile(last);
  };
  /** Drop target resolver: upload into whichever browsable root owns `dir`
   *  (the workspace root or one of its external folders). */
  const uploadDropped = (dir: string, files: File[]): void => {
    const roots = wsRootsRef.current;
    const root = roots.find((r) => dir === r || dir.startsWith(r.endsWith("/") ? r : `${r}/`)) ?? effectiveWorkspacePath;
    if (root === null) return;
    void uploadToRoot(root, dir, files);
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
    setActivePlan(null);
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

  // --- session plans / notes / checklist handlers ---

  /** Plans panel click: open (or focus) the plan's editable editor in Files. */
  const openPlan = (name: string): void => {
    setOpenPlans((prev) => (prev.includes(name) ? prev : [...prev, name]));
    setActivePlan(name);
    setActiveFile(null);
    setWorkspaceView("files");
  };

  /** Plan tab click. */
  const selectPlanTab = (name: string): void => {
    setActivePlan(name);
    setActiveFile(null);
  };

  /** Plan tab ✕: drop it; a closed ACTIVE plan activates its neighbor (or a file). */
  const closePlanTab = (name: string): void => {
    const idx = openPlans.indexOf(name);
    const next = openPlans.filter((p) => p !== name);
    setOpenPlans(next);
    if (activePlan === name) {
      const neighbor = next[idx] ?? next[idx - 1] ?? null;
      setActivePlan(neighbor);
      if (neighbor === null) setActiveFile(openFiles[openFiles.length - 1] ?? null);
    }
  };

  /** Create a plan (skeleton) then open it; the list refreshes via the event. */
  const createPlan = async (name: string): Promise<void> => {
    if (active === null) return;
    await client.putPlan(active.id, name, `# ${name}\n\n`);
    openPlan(name);
  };

  /** Delete a plan; close its tab. */
  const deletePlan = async (name: string): Promise<void> => {
    if (active === null) return;
    await client.deletePlan(active.id, name);
    closePlanTab(name);
  };

  /**
   * Build a plan: switch the session to the build agent and hand it the plan
   * to implement. The agent reads the plan with plan.read and works the
   * checklist; flip to the Chat view so the run is visible.
   */
  const buildPlan = async (name: string): Promise<void> => {
    if (active === null) return;
    try {
      await client.setSessionAgent(active.id, { agent: "build" });
      await client.submitPrompt(active.id, {
        text:
          `Implement the plan "${name}". Read it first with plan.read (call plan.read with name "${name}"), ` +
          "then execute its phases in order: keep the checklist (todo) updated as you complete each step and " +
          "verify your work before moving on.",
      });
      setWorkspaceView("chat");
      pushNotice(`building "${name}" with the build agent`, "info");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  /** Checklist edit: optimistic local update, then persist (event confirms). */
  const changeTodos = (list: TodoItem[]): void => {
    setTodos(list);
    if (active === null) return;
    void client.setTodos(active.id, list).catch((err) => {
      setError(err instanceof Error ? err.message : String(err));
    });
  };

  /** Persist the session note (NotesPanel debounces its autosave). */
  const saveNotes = async (content: string): Promise<void> => {
    if (active === null) return;
    await client.putNotes(active.id, content);
  };

  /**
   * Right-rail drag handle: pointer capture + pointermove. The rail sits on
   * the right, so dragging LEFT grows it. The width is clamped and persisted
   * to localStorage on release.
   */
  const startSidebarResize = (e: ReactPointerEvent<HTMLDivElement>): void => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sidebarWidthRef.current;
    setResizingSidebar(true);

    const onMove = (ev: PointerEvent): void => {
      const next = clampSidebarWidth(startWidth + (startX - ev.clientX));
      sidebarWidthRef.current = next;
      setSidebarWidth(next);
    };
    const finish = (): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      setResizingSidebar(false);
      try {
        window.localStorage.setItem(WORKSPACE_SIDEBAR_KEY, String(sidebarWidthRef.current));
      } catch {
        // Storage may be unavailable (private mode) — the width still applies.
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };

  /** Double-click resets the rail to its default width. */
  const resetSidebarWidth = (): void => {
    sidebarWidthRef.current = WORKSPACE_SIDEBAR_DEFAULT;
    setSidebarWidth(WORKSPACE_SIDEBAR_DEFAULT);
    try {
      window.localStorage.setItem(WORKSPACE_SIDEBAR_KEY, String(WORKSPACE_SIDEBAR_DEFAULT));
    } catch {
      // ignore
    }
  };

  /** Keyboard resize (a11y): ArrowLeft grows the right rail, ArrowRight shrinks it. */
  const onSidebarResizeKey = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const next = clampSidebarWidth(sidebarWidthRef.current + (e.key === "ArrowLeft" ? 16 : -16));
    sidebarWidthRef.current = next;
    setSidebarWidth(next);
    try {
      window.localStorage.setItem(WORKSPACE_SIDEBAR_KEY, String(next));
    } catch {
      // ignore
    }
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

  /**
   * Attach an extra folder to the active workspace (config only). Rejections
   * surface in the add-folder modal (its onAdd is awaited).
   */
  const addWorkspaceFolders = async (paths: string[]): Promise<void> => {
    const ws = effectiveWorkspacePath;
    if (ws === null) throw new Error("Select a workspace first.");
    const current = workspaceFolders[ws] ?? [];
    const additions: string[] = [];
    for (const path of paths) {
      // The workspace's own folder is the root itself — rejecting it keeps the
      // section from showing a redundant self-tree. Another REGISTERED
      // workspace is allowed: it is already reachable by absolute path, but
      // attaching it also surfaces it in this workspace's rail.
      if (path === ws) throw new Error(`${wsBasename(path)} is this workspace's main folder.`);
      if (current.includes(path) || additions.includes(path)) continue; // already attached — skip
      additions.push(path);
    }
    if (additions.length === 0) throw new Error("Those folders are already attached.");
    await client.putConfig({ workspaceFolders: { [ws]: [...current, ...additions] } });
    await refreshConfig();
    pushNotice(
      `added ${additions.length} folder${additions.length === 1 ? "" : "s"} to ${wsBasename(ws)}`,
      "success",
    );
  };

  /** Detach an extra folder (config only — the folder on disk is untouched). */
  const removeWorkspaceFolder = async (path: string): Promise<void> => {
    const ws = effectiveWorkspacePath;
    if (ws === null) return;
    const current = workspaceFolders[ws] ?? [];
    try {
      await client.putConfig({ workspaceFolders: { [ws]: current.filter((p) => p !== path) } });
      await refreshConfig();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  /**
   * Archive a workspace (the nav's ✕ after confirm): unregister it + archive
   * its sessions — they vanish from every list. config.updated refreshes the
   * lists; the stale-selection fallback returns an open view to the picker.
   */
  const removeWorkspace = async (path: string): Promise<void> => {
    try {
      await client.removeWorkspace(path);
      await refreshConfig();
      pushNotice(`archived workspace ${wsBasename(path)} — its sessions are hidden`, "success");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  /** Restore an archived workspace (the Archived tab's ↩): re-register + unarchive its sessions. */
  const restoreWorkspace = async (path: string): Promise<void> => {
    try {
      await client.restoreWorkspace(path);
      await refreshConfig();
      pushNotice(`restored workspace ${wsBasename(path)}`, "success");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  /**
   * Upload picked files for the composer `+` button. Each file goes to the
   * server immediately (so chips can preview), and the returned refs ride the
   * next submit. Failures surface on the error banner; successful uploads
   * still land. Cap 10 (the prompt schema's max).
   */
  const addAttachments = async (files: File[]): Promise<void> => {
    if (files.length === 0) return;
    setAttachmentsBusy(true);
    setError(null);
    const refs: AttachmentRef[] = [];
    for (const file of files) {
      try {
        refs.push(await client.uploadAttachment({ name: file.name, mime: file.type, bytes: file }));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
    if (refs.length > 0) {
      setDraftAttachments((prev) => [...prev, ...refs].slice(0, 10));
    }
    setAttachmentsBusy(false);
  };

  const removeAttachment = (id: string): void => {
    setDraftAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  const submit = async (override?: string, attachments: AttachmentRef[] = []): Promise<void> => {
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
        // Chat-section sessions pin the built-in chat agent (the all-in-one
        // orchestrator) at creation — webui-only; the TUI keeps its own
        // default resolution.
        session =
          section === "workspace" && effectiveWorkspacePath !== null
            ? await client.createSession({ workbench: "code", cwd: effectiveWorkspacePath })
            : await client.createSession({ workbench: "chat", agent: "chat" });
        setActive(session);
        if (section === "workspace") void refreshWorkspaceSessions();
        else void refreshSessions();
      } else if (section === "chat" && activeAgentName !== "chat") {
        // Pin-on-next-message: chat-section sessions created before the pin
        // (or switched away) converge on the chat agent at the next send.
        // The workspace section is untouched — code sessions keep their agent.
        await client.setSessionAgent(session.id, { agent: "chat" });
      }
      await client.submitPrompt(session.id, {
        text,
        ...(queuing ? { queue: true } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
      });
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

  /**
   * Seed the composer from stored text (revert / fork / edit-queued): collapse
   * `#full/path` tokens back to their leaf aliases and rehydrate the map, so
   * the input keeps the leaf display and still expands to the full path at
   * submit.
   */
  const seedDraft = useCallback((text: string): void => {
    const { text: collapsed, paths } = collapseMentions(text);
    setDraftMentions(paths);
    setDraft(collapsed);
    setDraftAttachments([]);
  }, []);

  /** Edit: cancel the queued input and put its text back into the composer. */
  const editQueued = (input: Input): void => {
    void cancelQueued(input);
    seedDraft(input.payload.text);
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
      seedDraft(messageText(m));
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
      seedDraft(messageText(m));
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

  // Section switch or widen → dismiss the mobile subnav drawer (content
  // returns to the desktop column; the open flag must not stick).
  useEffect(() => {
    setSubnavOpen(false);
  }, [section]);
  useEffect(() => {
    if (!isNarrow) setSubnavOpen(false);
  }, [isNarrow]);

  const nestedTitle =
    section === "settings"
      ? "Settings"
      : section === "workspace"
        ? "Workspace"
        : section === "agents"
          ? "Agents"
          : section === "tools"
            ? "Tools"
            : section === "skills"
              ? "Skills"
              : section === "automations"
                ? "Automations"
                : "Chat";

  /** Shared by the desktop column and the mobile Drawer (one content tree). */
  const nestedBody = (
    <>
        {section === "chat" && (
          <>
            {/* Draft state: no session row exists until the first message is
                sent (submit() creates it) — opencode's new-chat pattern.
                The action row pairs the create button with a search toggle;
                the server-side filter input only appears while searching. */}
            <SidebarActions
              createLabel="New Chat"
              onCreate={() => {
                // Focus the composer hub (the draft's input) on new chat.
                setComposerFocusToken((n) => n + 1);
                pushRoute({ section: "chat", sessionId: null });
                setSubnavOpen(false);
              }}
              searchLabel="Search chats"
              filter={chatSessionFilter}
              setFilter={setChatSessionFilter}
              placeholder="Filter sessions…"
              ariaLabel="Filter chat sessions"
            />
            <nav className="session-list">
              {sessions.length === 0 && (
                <p className="dim">{deferredChatFilter.length > 0 ? "No matches." : "No sessions yet."}</p>
              )}
              {sessions.map((s) => (
                <SessionRow
                  key={s.id}
                  session={s}
                  selected={active?.id === s.id}
                  unread={unreadSessions.has(s.id)}
                  onClick={() => {
                    pushRoute({ section: "chat", sessionId: s.id }, s);
                    setSubnavOpen(false);
                  }}
                  onLongPress={(x, y) => setSessionMenu({ x, y, id: s.id })}
                />
              ))}
              {chatSessionsHasMore && (
                <Button variant="ghost" size="sm" onClick={loadMoreChatSessions} disabled={chatSessionsLoadingMore}>
                  {chatSessionsLoadingMore ? "Loading…" : "Load more"}
                </Button>
              )}
            </nav>
          </>
        )}
        {section === "workspace" && effectiveWorkspacePath === null && (
          <WorkspaceNav
            client={client}
            workspaces={workspaces}
            archivedWorkspaces={archivedWorkspaces}
            selected={effectiveWorkspacePath}
            onSelect={(path) => {
              selectWorkspace(path);
              setSubnavOpen(false);
            }}
            onAdd={addWorkspace}
            onRemove={removeWorkspace}
            onRestore={restoreWorkspace}
          />
        )}
        {section === "workspace" && effectiveWorkspacePath !== null && (
          <>
            {/* Active-mode head: the selected workspace's title + path.
                Clicking it swaps the panel back to the picker list. */}
            <ListItem
              accentBar
              className="workspace-active-head"
              title={wsBasename(effectiveWorkspacePath)}
              subtitle={effectiveWorkspacePath}
              hint={`${effectiveWorkspacePath} — switch workspace`}
              onClick={() => selectWorkspace(null)}
              trailing={
                <span className="switch" aria-hidden="true">
                  ⇄
                </span>
              }
            />
            {/* Draft state: the code session (rooted at this workspace) is
                created by submit() on the first message. Same action row as
                the chat sidebar (create + search toggle). */}
            <SidebarActions
              createLabel="New session"
              onCreate={() => {
                setComposerFocusToken((n) => n + 1);
                pushRoute({ section: "workspace", wsPath: effectiveWorkspacePath, view: workspaceView, sessionId: null });
                setSubnavOpen(false);
              }}
              searchLabel="Search sessions"
              filter={wsSessionFilter}
              setFilter={setWsSessionFilter}
              placeholder="Filter sessions…"
              ariaLabel="Filter workspace sessions"
            />
            <nav className="session-list">
              {workspaceSessions.length === 0 && (
                <p className="dim">
                  {deferredWsFilter.length > 0 ? "No matches." : "No sessions in this workspace yet."}
                </p>
              )}
              {workspaceSessions.map((s) => (
                <SessionRow
                  key={s.id}
                  session={s}
                  selected={active?.id === s.id}
                  unread={unreadSessions.has(s.id)}
                  onClick={() => {
                    pushRoute(
                      { section: "workspace", wsPath: effectiveWorkspacePath, view: workspaceView, sessionId: s.id },
                      s,
                    );
                    setSubnavOpen(false);
                  }}
                  onLongPress={(x, y) => setSessionMenu({ x, y, id: s.id })}
                />
              ))}
              {wsSessionsHasMore && (
                <Button variant="ghost" size="sm" onClick={loadMoreWsSessions} disabled={wsSessionsLoadingMore}>
                  {wsSessionsLoadingMore ? "Loading…" : "Load more"}
                </Button>
              )}
            </nav>
          </>
        )}
        {section === "settings" && (
          <SettingsNav
            selected={settingsSection}
            onSelect={(next) => {
              pushRoute({ section: "settings", settingsSection: next });
              setSubnavOpen(false);
            }}
          />
        )}
        {section === "agents" && (
          <AgentsNav
            agents={navAgents}
            selected={effectiveAgentId}
            onSelect={(name) => {
              pushRoute({ section: "agents", name, creating: false });
              setSubnavOpen(false);
            }}
            onCreate={() => {
              pushRoute({ section: "agents", name: null, creating: true });
              setSubnavOpen(false);
            }}
            busy={false}
          />
        )}
        {section === "tools" && (
          <ToolsNav
            tools={navTools}
            selected={effectiveToolId}
            onSelect={(name) => {
              pushRoute({ section: "tools", name, creating: false });
              setSubnavOpen(false);
            }}
            onCreate={() => {
              pushRoute({ section: "tools", name: null, creating: true });
              setSubnavOpen(false);
            }}
            busy={false}
          />
        )}
        {section === "skills" && (
          <SkillsNav
            skills={navSkills}
            selected={effectiveSkillId}
            onSelect={(name) => {
              pushRoute({ section: "skills", name, creating: false });
              setSubnavOpen(false);
            }}
            onCreate={() => {
              pushRoute({ section: "skills", name: null, creating: true });
              setSubnavOpen(false);
            }}
            busy={false}
          />
        )}
        {section === "automations" && (
          <AutomationsNav
            automations={automations}
            selected={effectiveAutomationId}
            onSelect={(id) => {
              pushRoute({ section: "automations", name: id, creating: false });
              setSubnavOpen(false);
            }}
            onCreate={() => {
              pushRoute({ section: "automations", name: null, creating: true });
              setSubnavOpen(false);
            }}
            busy={false}
          />
        )}
    </>
  );

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
      bubbles={section === "chat"}
      focusToken={composerFocusToken}
      configDefault={configDefault}
      configDefaultAgent={configDefaultAgent}
      preferZdr={configPreferZdr}
      agents={agents}
      refreshAgents={refreshAgents}
      refreshProviders={refreshProviders}
      providersFetching={providersFetching}
      messages={messages}
      historyHasMore={pager.hasMore}
      loadingOlder={pager.loadingOlder}
      onLoadOlder={pager.loadOlder}
      draft={draft}
      setDraft={setDraft}
      mentionPaths={draftMentions}
      setMentionPaths={setDraftMentions}
      pendingMention={pendingMention}
      onPendingMentionConsumed={() => setPendingMention(null)}
      onSubmit={(text) => {
        // ChatPane already expanded leaf `#file` tokens to full paths.
        setDraft("");
        setDraftMentions({});
        const pending = draftAttachments;
        setDraftAttachments([]);
        void submit(text, pending);
      }}
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
      agentLocked={section === "chat"}
      onOpenWorkspace={(wsPath) => {
        // workspace.create node action: refresh config (the tool registered
        // the folder; cover a dropped config.updated) then navigate to the
        // workspace route for it.
        void refreshConfig();
        selectWorkspace(wsPath);
      }}
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
      workspaceRoot={section === "workspace" ? (effectiveWorkspacePath ?? active?.cwd ?? undefined) : undefined}
      workspaceFolders={section === "workspace" ? workspaceExtras : undefined}
      onOpenFile={openMentionedFile}
      {...(section === "chat"
        ? {
            attachments: draftAttachments,
            onAddAttachments: (files: File[]) => void addAttachments(files),
            onRemoveAttachment: removeAttachment,
            attachmentsBusy,
          }
        : {})}
      // Learn chip: only with an open session (drafts use the Skills page's
      // Learn form — a fresh learn session there has the same effect).
      onLearn={active !== null ? (request) => void learn(request) : undefined}
    />
  );

  return (
    <ThemeProvider theme={theme} customColors={customTheme?.colors}>
    <a className="skip-link" href="#main-content">Skip to main content</a>
    <div className={resizingSidebar ? "app resizing" : "app"}>
      {/* Pending asks render INLINE inside the chat pane (no overlay, no
          dim) — the app stays fully navigable while a run is blocked. The
          Chat nav item carries a count badge when the user is elsewhere. */}
      <MasterNav
        section={section}
        onNavigate={(s) => {
          navigate(s);
          setSubnavOpen(false);
        }}
        askBadge={askPanelVisible ? 0 : askTotal}
        onThemePicker={() => setThemePickerOpen(true)}
        visible={visibleNav}
        subnavToggle={
          showNestedPanel
            ? {
                open: subnavOpen,
                onToggle: () => setSubnavOpen((v) => !v),
              }
            : undefined
        }
      />

      {/* Desktop: nested column. Mobile: same body lives in the subnav Drawer
          (opened from MasterNav's right-edge toggle) — never both. */}
      {showNestedPanel && !isNarrow && (
      <aside className="nested-panel">
        <div className="nested-title">{nestedTitle}</div>
        {nestedBody}
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
            refreshAgents={refreshAgents}
            userName={configUserName}
            preferZdr={configPreferZdr}
            routerEnabled={configRouterEnabled}
            defaultAgent={configDefaultAgent}
            imageGen={configImageGen}
            videoGen={configVideoGen}
            jobs={configJobs}
            theme={theme}
            advancedMode={configAdvancedMode}
            showBuiltins={configShowBuiltins}
            hiddenNav={configHiddenNav}
            onOpenThemePicker={() => setThemePickerOpen(true)}
            onNotice={pushNotice}
          />
        </main>
      ) : section === "agents" ? (
        <main id="main-content" className="agents-pane">
          <AgentsPane
            client={client}
            agents={agents}
            tools={tools}
            skills={skills}
            selectedId={effectiveAgentId}
            activeSessionId={active?.id ?? null}
            refresh={refreshAgents}
            onNotice={pushNotice}
            creating={creatingAgent}
            list={list}
            onCreated={(name) => {
              setCreatingAgent(false);
              pushRoute({ section: "agents", name, creating: false });
            }}
            onCancel={() => setCreatingAgent(false)}
          />
        </main>
      ) : section === "tools" ? (
        <main id="main-content" className="agents-pane">
          <ToolsPane
            client={client}
            tools={tools}
            selectedId={effectiveToolId}
            refresh={refreshTools}
            onNotice={pushNotice}
            themeColors={themeColors}
            creating={creatingTool}
            onCreated={(name) => {
              setCreatingTool(false);
              pushRoute({ section: "tools", name, creating: false });
            }}
            onCancel={() => setCreatingTool(false)}
          />
        </main>
      ) : section === "skills" ? (
        <main id="main-content" className="agents-pane">
          {creatingSkill && skillLearnOpen ? (
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
            <SkillsPane
              client={client}
              skills={skills}
              selectedId={effectiveSkillId}
              refresh={refreshSkills}
              onNotice={pushNotice}
              creating={creatingSkill}
              onCreated={(name) => {
                setCreatingSkill(false);
                pushRoute({ section: "skills", name, creating: false });
              }}
              onCancel={() => setCreatingSkill(false)}
              onLearnInstead={() => setSkillLearnOpen(true)}
            />
          )}
        </main>
      ) : section === "automations" ? (
        <main id="main-content" className="agents-pane">
          <AutomationsPane
            client={client}
            automations={automations}
            agents={agents}
            workspaces={workspaces}
            selectedId={effectiveAutomationId}
            refresh={refreshAutomations}
            onNotice={pushNotice}
            onOpenSession={(sessionId) => pushRoute({ section: "chat", sessionId })}
            onDeleted={() => pushRoute({ section: "automations", name: null, creating: false })}
            creating={creatingAutomation}
            list={list}
            onCreated={(id) => {
              setCreatingAutomation(false);
              pushRoute({ section: "automations", name: id, creating: false });
            }}
            onCancel={() => setCreatingAutomation(false)}
          />
        </main>
      ) : section === "image" ? (
        <main id="main-content" className="image-main">
          <ImagePane
            client={client}
            imageGen={configImageGen}
            onNotice={pushNotice}
            onOpenSession={(id) => void openSession(id)}
          />
        </main>
      ) : section === "video" ? (
        <main id="main-content" className="video-main">
          <VideoPane
            client={client}
            videoGen={configVideoGen}
            onNotice={pushNotice}
            onOpenSession={(id) => void openSession(id)}
          />
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
                <Tabs
                  ariaLabel="Workspace view"
                  value={workspaceView}
                  onChange={(view) =>
                    pushRoute({
                      section: "workspace",
                      wsPath: effectiveWorkspacePath,
                      view: view as "chat" | "files",
                      sessionId: active?.id ?? null,
                    })
                  }
                  tabs={[
                    { value: "chat", label: "Chat" },
                    { value: "files", label: "Files" },
                  ]}
                />
                {/* Phones: the right rail is a Drawer (sidebar is display:none).
                    Hamburger affordance, matching the subnav/menu language. */}
                <Button
                  className="drawer-open-btn"
                  variant="ghost"
                  size="sm"
                  aria-label="Open workspace menu"
                  data-tooltip="Workspace menu"
                  onClick={() => setRailOpen(true)}
                >
                  <Menu size={16} aria-hidden="true" />
                </Button>
              </div>
              {workspaceView === "files" && effectiveWorkspacePath !== null ? (
                <FileView
                  client={client}
                  root={effectiveWorkspacePath}
                  roots={[effectiveWorkspacePath, ...workspaceExtras]}
                  openFiles={openFiles}
                  activeFile={activeFile}
                  themeColors={themeColors}
                  changedFiles={changedFiles}
                  fsRevision={fsRevision}
                  onFileSeen={clearChangedFile}
                  onSelectTab={selectFileTab}
                  onCloseTab={closeFileTab}
                  sessionId={active?.id ?? null}
                  openPlans={openPlans}
                  activePlan={activePlan}
                  planRevision={plans.find((p) => p.name === activePlan)?.updatedAt ?? ""}
                  onSelectPlan={selectPlanTab}
                  onClosePlan={closePlanTab}
                />
              ) : (
                chatPane
              )}
            </div>
          ) : (
            chatPane
          )}
          {section === "workspace" && effectiveWorkspacePath !== null && (
            // Right rail: file tree on top, then the session checklist/plans/
            // notes. The left-edge handle resizes it; the rail scrolls.
            <>
              <div
                className={resizingSidebar ? "workspace-resizer resizing" : "workspace-resizer"}
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize sidebar"
                aria-valuemin={WORKSPACE_SIDEBAR_MIN}
                aria-valuemax={WORKSPACE_SIDEBAR_MAX}
                aria-valuenow={sidebarWidth}
                tabIndex={0}
                title="Drag to resize · double-click to reset"
                onPointerDown={startSidebarResize}
                onKeyDown={onSidebarResizeKey}
                onDoubleClick={resetSidebarWidth}
              />
              <div className="workspace-sidebar" style={{ width: sidebarWidth }}>
                <FileTree
                  client={client}
                  root={effectiveWorkspacePath}
                  onOpenFile={openFile}
                  activePath={workspaceView === "files" ? activeFile : null}
                  refreshToken={fsRevision}
                  onUpload={uploadDropped}
                  folders={workspaceFolderNodes}
                  onAddFolder={() => setAddFoldersOpen(true)}
                  onRemoveFolder={(path) => void removeWorkspaceFolder(path)}
                  onItemContextMenu={(abs, kind, e) => setTreeMenu({ x: e.clientX, y: e.clientY, abs, kind })}
                />
                <TodosPanel todos={todos} onChange={changeTodos} disabled={active === null} />
                <PlansPanel
                  plans={plans}
                  activePlan={activePlan}
                  disabled={active === null}
                  onOpen={openPlan}
                  onCreate={createPlan}
                  onDelete={deletePlan}
                  onBuild={(name) => void buildPlan(name)}
                />
                <NotesPanel
                  key={active?.id ?? "none"}
                  notes={notes}
                  onSave={saveNotes}
                  disabled={active === null}
                />
              </div>
            </>
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

      {/* Multi-select add-folders modal — opened from the file tree toolbar. */}
      {addFoldersOpen && effectiveWorkspacePath !== null && (
        <AddWorkspaceModal
          client={client}
          title="Add folders to workspace"
          submitLabel="Add folder"
          ariaLabel="Add folders to workspace"
          multi
          onAddMany={addWorkspaceFolders}
          onClose={() => setAddFoldersOpen(false)}
        />
      )}

      {/* File-tree right-click / long-press menu (Open / Add to Chat). */}
      {treeMenu !== null && (
        <ContextMenu
          x={treeMenu.x}
          y={treeMenu.y}
          items={treeMenuItems}
          ariaLabel="File actions"
          onClose={() => setTreeMenu(null)}
        />
      )}

      {/* Session-row long-press menu (iOS: contextmenu is unreliable). */}
      {sessionMenu !== null && (
        <ContextMenu
          x={sessionMenu.x}
          y={sessionMenu.y}
          items={sessionMenuItems}
          ariaLabel="Session actions"
          onClose={() => setSessionMenu(null)}
        />
      )}

      {/* Mobile subnav: sessions / settings / agents list as a right Drawer
          (the nested column is not rendered under 640px). */}
      <Drawer
        open={showNestedPanel && isNarrow && subnavOpen}
        onClose={() => setSubnavOpen(false)}
        title={nestedTitle}
        ariaLabel={`${nestedTitle} navigation`}
      >
        {nestedBody}
      </Drawer>

      {/* Mobile workspace rail: slide-over Drawer with Files/Todos/Notes/Plans. */}
      <Drawer
        open={railOpen}
        onClose={() => setRailOpen(false)}
        title="Workspace rail"
        ariaLabel="Workspace rail"
        // Files tab is a full-bleed panel (the tree owns its own scroll/edges).
        bodyClassName={railTab === "files" ? "drawer-body-flush" : undefined}
        tabs={[
          { id: "files", label: "Files" },
          { id: "todos", label: "Todos" },
          { id: "notes", label: "Notes" },
          { id: "plans", label: "Plans" },
        ]}
        activeTab={railTab}
        onTabChange={(id) => setRailTab(id as "files" | "todos" | "notes" | "plans")}
      >
        {section === "workspace" && effectiveWorkspacePath !== null && (
          <>
            {railTab === "files" && (
              <FileTree
                client={client}
                root={effectiveWorkspacePath}
                onOpenFile={(path) => {
                  openFile(path);
                  setRailOpen(false);
                }}
                activePath={workspaceView === "files" ? activeFile : null}
                refreshToken={fsRevision}
                onUpload={uploadDropped}
                folders={workspaceFolderNodes}
                onAddFolder={() => setAddFoldersOpen(true)}
                onRemoveFolder={(path) => void removeWorkspaceFolder(path)}
                onItemContextMenu={(abs, kind, e) => setTreeMenu({ x: e.clientX, y: e.clientY, abs, kind })}
              />
            )}
            {railTab === "todos" && (
              <TodosPanel todos={todos} onChange={changeTodos} disabled={active === null} />
            )}
            {railTab === "plans" && (
              <PlansPanel
                plans={plans}
                activePlan={activePlan}
                disabled={active === null}
                onOpen={openPlan}
                onCreate={createPlan}
                onDelete={deletePlan}
                onBuild={(name) => void buildPlan(name)}
              />
            )}
            {railTab === "notes" && (
              <NotesPanel
                key={active?.id ?? "none"}
                notes={notes}
                onSave={saveNotes}
                disabled={active === null}
              />
            )}
          </>
        )}
      </Drawer>

      {/* Agents/tools mutation feedback — bottom-right toast. */}
      <Toast notice={notice} onDismiss={() => setNotice(null)} />

      {/* One fixed-position tooltip for every `[data-tooltip]` control. */}
      <TooltipLayer />
    </div>
    </ThemeProvider>
  );
}

/**
 * The session sidebars' stacked actions: a compose button, then a search
 * toggle. The server-side filter input is hidden until the search button is
 * clicked (keeping the list head compact); collapsing it clears the filter
 * so no invisible query lingers.
 */
function SidebarActions({
  createLabel,
  onCreate,
  searchLabel,
  filter,
  setFilter,
  placeholder,
  ariaLabel,
}: {
  createLabel: string;
  onCreate: () => void;
  searchLabel: string;
  filter: string;
  setFilter: (value: string) => void;
  placeholder: string;
  ariaLabel: string;
}) {
  const [searchOpen, setSearchOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (searchOpen) inputRef.current?.focus();
  }, [searchOpen]);
  // Leaving the section (unmount) drops any active filter — the input is
  // hidden then, so an invisible query must not linger.
  useEffect(() => () => setFilter(""), [setFilter]);
  return (
    <>
      <div className="sidebar-actions">
        <SubNavCreate icon={<SquarePen size={15} aria-hidden="true" />} label={createLabel} onClick={onCreate} />
        <SubNavCreate
          className="sidebar-search-btn"
          icon={<Search size={15} aria-hidden="true" />}
          label={searchLabel}
          ariaPressed={searchOpen}
          onClick={() => {
            setSearchOpen((open) => {
              if (open) setFilter("");
              return !open;
            });
          }}
        />
      </div>
      {searchOpen && (
        <TextInput
          ref={inputRef}
          className="session-filter"
          type="search"
          placeholder={placeholder}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label={ariaLabel}
        />
      )}
    </>
  );
}

/**
 * One session row in either sidebar: a slim single-line list item (no
 * workbench subtitle — the "chat"/"code" label is gone). Automation-spawned
 * sessions carry an inline Automation chip. The title emphasizes only when
 * the session has unseen activity.
 */
function SessionRow({
  session,
  selected,
  unread,
  onClick,
  onLongPress,
}: {
  session: Session;
  selected: boolean;
  unread: boolean;
  onClick: () => void;
  /** iOS long-press → ContextMenu (contextmenu is unreliable on WebKit touch). */
  onLongPress?: (clientX: number, clientY: number) => void;
}) {
  const title = session.title.length > 0 ? session.title : "(untitled)";
  const automation = typeof session.meta.automationName === "string" ? session.meta.automationName : undefined;
  const bindLongPress = useLongPress();
  const longPress = onLongPress !== undefined ? bindLongPress(onLongPress) : null;
  return (
    <ListItem
      accentBar
      inline
      className={unread ? "session-row has-updates" : "session-row"}
      title={title}
      selected={selected}
      hint={title}
      onClick={(e) => {
        longPress?.onClick(e);
        if (e.defaultPrevented) return;
        onClick();
      }}
      onPointerDown={longPress?.onPointerDown}
      onPointerUp={longPress?.onPointerUp}
      onPointerCancel={longPress?.onPointerCancel}
      onPointerMove={longPress?.onPointerMove}
      ariaCurrent={selected ? "page" : undefined}
      trailing={
        automation !== undefined ? (
          <Chip className="chip-automation" hint={`Automation: ${automation}`}>
            Automation
          </Chip>
        ) : undefined
      }
    />
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
  subnavToggle,
  visible,
}: {
  section: Section;
  onNavigate: (s: Section) => void;
  /** Pending-ask count for the Chat badge (0 = hidden). */
  askBadge?: number;
  /** Open the theme picker modal (the palette button above Settings). */
  onThemePicker: () => void;
  /**
   * Reachable section ids — advanced gating (config ui.advancedMode) ∩ the
   * per-item visibility set (config ui.hiddenNav). Items not in the set are
   * not rendered. Settings/Theme are always shown.
   */
  visible: Set<string>;
  /**
   * Mobile-only control on the right edge (opposite the brand mark): opens
   * the section subnav Drawer. Omitted on single-pane sections
   * (SIDEBAR_HIDDEN) — nothing to show. Hidden on desktop via CSS.
   */
  subnavToggle?: { open: boolean; onToggle: () => void };
}) {
  // Mobile-only: the icon row scrolls horizontally. Track whether content
  // overflows each edge so the scroll affordances show only when useful.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  const updateEdges = useCallback((): void => {
    const el = scrollRef.current;
    if (el === null) return;
    const left = el.scrollLeft > 2;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
    setEdges((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    updateEdges();
    el.addEventListener("scroll", updateEdges, { passive: true });
    let observer: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(updateEdges);
      observer.observe(el);
    }
    window.addEventListener("resize", updateEdges);
    return () => {
      el.removeEventListener("scroll", updateEdges);
      observer?.disconnect();
      window.removeEventListener("resize", updateEdges);
    };
  }, [updateEdges]);

  /** Nudge the row one comfortable step in `dir` (-1 left, 1 right). */
  const nudge = (dir: -1 | 1): void => {
    const el = scrollRef.current;
    if (el === null) return;
    el.scrollBy({ left: dir * Math.max(160, el.clientWidth * 0.6), behavior: "smooth" });
  };

  return (
      <nav className="master-nav" aria-label="Primary">
        {/* Same asset as the favicon (public/icon.svg) — one logo, one truth.
            Outside .master-scroll so the brand stays pinned on mobile while
            only the nav items pan. */}
        <img src="/icon.svg" alt="bai" className="brand-mark" />
      {/* The scroll region + its edge affordances (mobile). The wrappers carry
          the gradients; the buttons nudge the row and only appear at an edge
          that actually has hidden items. */}
      <div
        className={
          "master-scroll-wrap" +
          (edges.left ? " has-left" : "") +
          (edges.right ? " has-right" : "")
        }
      >
        {edges.left && (
          <IconButton
            className="master-scroll-btn left"
            label="Scroll navigation left"
            hint="Scroll left"
            onClick={() => nudge(-1)}
          >
            <ChevronLeft size={18} aria-hidden="true" />
          </IconButton>
        )}
      <div className="master-scroll" ref={scrollRef}>
      <div className="master-items">
        {visible.has("chat") && (
          <NavItem
            icon={<MessageCircle className="nav-icon" aria-hidden="true" />}
            label="Chat"
            active={section === "chat"}
            onClick={() => onNavigate("chat")}
            badge={askBadge}
          />
        )}
        {visible.has("workspace") && (
          <NavItem
            icon={<Folder className="nav-icon" aria-hidden="true" />}
            label="Workspace"
            active={section === "workspace"}
            onClick={() => onNavigate("workspace")}
          />
        )}
        {visible.has("image") && (
          <NavItem icon={<Image className="nav-icon" aria-hidden="true" />} label="Image Gen" active={section === "image"} onClick={() => onNavigate("image")} />
        )}
        {visible.has("video") && (
          <NavItem icon={<Video className="nav-icon" aria-hidden="true" />} label="Video Gen" active={section === "video"} onClick={() => onNavigate("video")} />
        )}
        {/* Workbenches above the line, agent machinery below it — the divider
            shows only when at least one machinery item is visible. */}
        {ADVANCED_NAV_IDS.some((id) => visible.has(id)) && (
          <>
            <div className="nav-divider" role="separator" aria-label="workbenches / agents" />
            {visible.has("agents") && <NavItem icon={<Bot className="nav-icon" aria-hidden="true" />} label="Agents" active={section === "agents"} onClick={() => onNavigate("agents")} />}
            {visible.has("tools") && <NavItem icon={<Wrench className="nav-icon" aria-hidden="true" />} label="Tools" active={section === "tools"} onClick={() => onNavigate("tools")} />}
            {visible.has("skills") && <NavItem icon={<Zap className="nav-icon" aria-hidden="true" />} label="Skills" active={section === "skills"} onClick={() => onNavigate("skills")} />}
            {visible.has("automations") && <NavItem icon={<Clock className="nav-icon" aria-hidden="true" />} label="Automations" active={section === "automations"} onClick={() => onNavigate("automations")} />}
            {visible.has("analytics") && <NavItem icon={<ChartColumn className="nav-icon" aria-hidden="true" />} label="Analytics" active={section === "analytics"} onClick={() => onNavigate("analytics")} />}
          </>
        )}
      </div>
      <div className="master-spacer" />
      <NavItem
        icon={<Palette className="nav-icon" aria-hidden="true" />}
        label="Choose a theme"
        onClick={onThemePicker}
      />

      {/* Shell sits directly above Settings — hideable like the rest. */}
      {visible.has("shell") && (
        <NavItem icon={<Terminal className="nav-icon" aria-hidden="true" />} label="Shell" active={section === "shell"} onClick={() => onNavigate("shell")} />
      )}
      <NavItem icon={<SlidersHorizontal className="nav-icon" aria-hidden="true" />} label="Settings" active={section === "settings"} onClick={() => onNavigate("settings")} />
      </div>
        {edges.right && (
          <IconButton
            className="master-scroll-btn right"
            label="Scroll navigation right"
            hint="Scroll right"
            onClick={() => nudge(1)}
          >
            <ChevronRight size={18} aria-hidden="true" />
          </IconButton>
        )}
      </div>
      {subnavToggle !== undefined && (
        <SubNavToggle open={subnavToggle.open} onToggle={subnavToggle.onToggle} />
      )}
    </nav>
  );
}

function basename(p: string): string {
  const parts = p.split("/").filter((s) => s.length > 0);
  return parts[parts.length - 1] ?? p;
}

/** Local alias — the sessions panel head shows the workspace's basename. */
const wsBasename = basename;
