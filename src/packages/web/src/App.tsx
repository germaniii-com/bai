import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { BaiClient, followGlobal, followSession } from "@bai/api/client";
import type { Message, Session } from "@bai/shared";
import { applyEvent, messageText } from "./state";
import { useProviders } from "./use-providers";
import { useAgents } from "./use-agents";
import { useTools } from "./use-tools";
import { SettingsNav, SettingsPane } from "./settings";
import { WorkspaceNav, FolderGlyph } from "./workspace";
import { FileTree } from "./file-tree";
import { ChatPane } from "./chat-pane";
import { AgentsNav, AgentsPane, AgentCreateForm } from "./agents";
import { ToolsNav, ToolsPane, ToolCreateForm, toolTemplateCode } from "./tools";

/**
 * Master-rail sections. Image/Video are Phase 5 placeholders — the rail
 * renders them disabled (same stance as the TUI's placeholder views);
 * chat, workspace, and settings are reachable.
 */
type Section = "chat" | "workspace" | "agents" | "tools" | "image" | "video" | "settings";

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
  const [section, setSection] = useState<Section>("chat");
  const [settingsProviderId, setSettingsProviderId] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<string[]>([]);
  const [workspacePath, setWorkspacePath] = useState<string | null>(null);
  const [workspaceSessions, setWorkspaceSessions] = useState<Session[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [active, setActive] = useState<Session | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [runActive, setRunActive] = useState(false);
  const [sentPending, setSentPending] = useState(false);
  const streamCtrl = useRef<AbortController | null>(null);
  const { list, refresh: refreshProviders, fetching: providersFetching } = useProviders(client);
  // Default model + agent + workspace list from config — a tiny startup
  // fetch so the header's picker buttons show the real defaults before the
  // (heavy, on-demand) provider list ever loads. Same pattern as the TUI's
  // header.
  const [configDefault, setConfigDefault] = useState<string | undefined>(undefined);
  const [configDefaultAgent, setConfigDefaultAgent] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | null>(null);
  // Independent catalogs: agents and tools each own their fetch/refresh —
  // updated by firehose events (agents.updated / tools.updated), section
  // engagement, and reconnect healing.
  const { agents, refresh: refreshAgents } = useAgents(client);
  const { tools, refresh: refreshTools } = useTools(client);
  // Selections per section; stale ids (deleted elsewhere) resolve to null
  // against the live lists — the settings pattern.
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [selectedTool, setSelectedTool] = useState<string | null>(null);
  // Creation flows: true while the create form (pre-filled, editable name)
  // is open in the main pane — no file is written until the form submits.
  const [creatingAgent, setCreatingAgent] = useState(false);
  const [creatingTool, setCreatingTool] = useState(false);

  const refreshConfig = useCallback(async () => {
    try {
      const config = await client.getConfig();
      setConfigDefault(config.models.default);
      setConfigDefaultAgent(config.agents?.default);
      setWorkspaces(config.workspaces ?? []);
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
  useEffect(() => {
    const ctrl = new AbortController();
    void followGlobal(client, {
      signal: ctrl.signal,
      onEvent: (evt) => {
        // Universal healing (§8.4): the firehose's first frame on every
        // (re)connect refreshes the snapshots — live events missed during a
        // drop (e.g. a background title change) can't linger.
        if (evt.type === "server.hello") {
          void refreshSessions();
          void refreshWorkspaceSessions();
          void refreshConfig();
          void refreshAgents();
          void refreshTools();
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
      },
    });
    return () => ctrl.abort();
  }, [client, refreshConfig, refreshSessions, refreshWorkspaceSessions, refreshAgents, refreshTools]);

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

  // Stale-selection fallbacks: a provider deleted from another surface
  // (firehose provider.updated) resolves back to General; a workspace
  // removed from config (config.updated) resolves back to no selection.
  const providerExists = list?.providers.some((p) => p.id === settingsProviderId) ?? false;
  const effectiveSettingsId = providerExists ? settingsProviderId : null;
  const effectiveWorkspacePath =
    workspacePath !== null && workspaces.includes(workspacePath) ? workspacePath : null;
  const effectiveAgentId = agents.some((a) => a.name === selectedAgent) ? selectedAgent : null;
  const effectiveToolId = tools.some((t) => t.name === selectedTool) ? selectedTool : null;

  const navigate = (next: Section): void => {
    if (next === "settings") {
      // On-demand + refetch on engagement (TUI ctrl+p parity): the provider
      // list never loads at startup, and every engagement pulls fresh data.
      void refreshProviders();
    }
    if (next === "workspace") {
      // Engagement refetch: fresh session list for the selected workspace.
      void refreshWorkspaceSessions();
    }
    if (next === "agents") {
      // Engagement refetch: agents changed anywhere → fresh list.
      setCreatingAgent(false);
      void refreshAgents();
    }
    if (next === "tools") {
      // Engagement refetch: tools changed anywhere → fresh list.
      setCreatingTool(false);
      void refreshTools();
    }
    // Keep the open session coherent with the section — a chat session in
    // the workspace view (or vice versa) would read as a context mixup.
    if (next === "chat" && active?.workbench !== "chat") setActive(null);
    if (next === "workspace" && active?.workbench !== "code") setActive(null);
    setSection(next);
  };

  const selectWorkspace = (path: string | null): void => {
    setWorkspacePath(path);
    // Keep the open session only when it belongs to the chosen workspace.
    setActive((current) => (path !== null && current?.cwd === path ? current : null));
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
    setWorkspacePath(path);
  };

  /** Write a starter agent file for the (form-validated) name, then select it. */
  const createAgent = async (name: string): Promise<void> => {
    await client.putAgent(name, {
      description: "What this agent is for.",
      prompt: `You are ${name}, an agent inside bai.\n\nDescribe the agent's role, tone, and workflow here. The body is the system prompt.`,
      tools: ["fs.read", "fs.list"],
    });
    setCreatingAgent(false);
    setSelectedAgent(name);
    await refreshAgents();
  };

  /** Write a starter tool file for the (form-validated) name, then select it. */
  const createTool = async (name: string): Promise<void> => {
    await client.putTool(name, toolTemplateCode(name));
    setCreatingTool(false);
    setSelectedTool(name);
    await refreshTools();
  };

  const submit = async (): Promise<void> => {
    const text = draft.trim();
    if (text.length === 0) return;
    setDraft("");
    setSentPending(true);
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
            <button className="new-session" onClick={() => setActive(null)}>
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
            <button className="new-session" onClick={() => setActive(null)}>
              + new session
            </button>
            <nav className="session-list">
              {workspaceSessions.length === 0 && (
                <p className="dim">No sessions in this workspace yet.</p>
              )}
              {workspaceSessions.map((s) => (
                <button
                  key={s.id}
                  className={active?.id === s.id ? "session active" : "session"}
                  onClick={() => setActive(s)}
                >
                  <span className="title">{s.title.length > 0 ? s.title : "(untitled)"}</span>
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
        {section === "agents" && (
          <AgentsNav
            agents={agents}
            selected={effectiveAgentId}
            onSelect={(name) => {
              setCreatingAgent(false);
              setSelectedAgent(name);
            }}
            onCreate={() => {
              setSelectedAgent(null);
              setCreatingAgent(true);
            }}
            busy={false}
          />
        )}
        {section === "tools" && (
          <ToolsNav
            tools={tools}
            selected={effectiveToolId}
            onSelect={(name) => {
              setCreatingTool(false);
              setSelectedTool(name);
            }}
            onCreate={() => {
              setSelectedTool(null);
              setCreatingTool(true);
            }}
            busy={false}
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
      ) : section === "agents" ? (
        <main className="agents-pane">
          {notice !== null && (
            <div className="notice" role="status" onClick={() => setNotice(null)}>
              {notice}
            </div>
          )}
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
              onNotice={setNotice}
            />
          )}
        </main>
      ) : section === "tools" ? (
        <main className="agents-pane">
          {notice !== null && (
            <div className="notice" role="status" onClick={() => setNotice(null)}>
              {notice}
            </div>
          )}
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
              onNotice={setNotice}
            />
          )}
        </main>
      ) : section === "workspace" && effectiveWorkspacePath === null ? (
        <main className="chat">
          <p className="dim empty">Select or add a workspace to start.</p>
        </main>
      ) : (
        <>
          <ChatPane
            client={client}
            list={list}
            active={active}
            configDefault={configDefault}
            configDefaultAgent={configDefaultAgent}
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
            startPlaceholder={
              section === "workspace" ? "Describe a task for this workspace…" : "Start a chat…"
            }
          />
          {section === "workspace" && effectiveWorkspacePath !== null && (
            <FileTree client={client} root={effectiveWorkspacePath} />
          )}
        </>
      )}
    </div>
  );
}

/**
 * Master rail: brand mark, workbench sections (Image/Video disabled until
 * their phases land), Settings pinned at the bottom.
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
        <MasterItem section="workspace" label="Workspace" active={section === "workspace"} onNavigate={onNavigate}>
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
        {/* Workbenches above the line, agent machinery below it. */}
        <div className="nav-divider" role="separator" aria-label="workbenches / agents" />
        <MasterItem section="agents" label="Agents" active={section === "agents"} onNavigate={onNavigate}>
          <Icon>
            <rect x="4" y="4" width="16" height="16" rx="2" />
            <rect x="9" y="9" width="6" height="6" />
            <line x1="9" y1="1" x2="9" y2="4" />
            <line x1="15" y1="1" x2="15" y2="4" />
            <line x1="9" y1="20" x2="9" y2="23" />
            <line x1="15" y1="20" x2="15" y2="23" />
            <line x1="20" y1="9" x2="23" y2="9" />
            <line x1="20" y1="14" x2="23" y2="14" />
            <line x1="1" y1="9" x2="4" y2="9" />
            <line x1="1" y1="14" x2="4" y2="14" />
          </Icon>
        </MasterItem>
        <MasterItem section="tools" label="Tools" active={section === "tools"} onNavigate={onNavigate}>
          <Icon>
            <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
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

function basename(p: string): string {
  const parts = p.split("/").filter((s) => s.length > 0);
  return parts[parts.length - 1] ?? p;
}

/** Local alias — the sessions panel head shows the workspace's basename. */
const wsBasename = basename;

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
