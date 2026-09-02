import { useCallback, useEffect, useState } from "react";
import type { BaiClient } from "@bai/api/client";
import type { AgentInfo, ToolListEntry } from "@bai/shared";

type Tab = "agents" | "tools";

/**
 * Agents & tools management (web): list + form editor for agents
 * (description / model / tools / prompt) and a code editor for custom
 * tools. Saves write the markdown/tool files via the API — the server
 * hot-reloads them, so changes are live everywhere immediately. Refreshes
 * live from the firehose when agents.updated/tools.updated arrive.
 */
export function AgentsPage({
  client,
  tick,
  activeSessionId,
  onNotice,
}: {
  client: BaiClient;
  /** Bumped on agents.updated/tools.updated — refetch while open. */
  tick: number;
  activeSessionId: string | null;
  onNotice: (message: string) => void;
}) {
  const [tab, setTab] = useState<Tab>("agents");
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [tools, setTools] = useState<ToolListEntry[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [selectedTool, setSelectedTool] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [a, t] = await Promise.all([client.listAgents(), client.listTools()]);
      setAgents(a);
      setTools(t);
    } catch (err) {
      onNotice(err instanceof Error ? err.message : String(err));
    }
  }, [client, onNotice]);

  useEffect(() => {
    void refresh();
  }, [refresh, tick]);

  // Keep selections coherent with the (possibly changed) lists.
  useEffect(() => {
    if (selectedAgent !== null && !agents.some((a) => a.name === selectedAgent)) setSelectedAgent(null);
  }, [agents, selectedAgent]);
  useEffect(() => {
    if (selectedTool !== null && !tools.some((t) => t.name === selectedTool)) setSelectedTool(null);
  }, [tools, selectedTool]);

  const createAgent = async (): Promise<void> => {
    setBusy(true);
    try {
      const name = `agent-${Date.now().toString(36)}`;
      await client.putAgent(name, {
        description: "What this agent is for.",
        prompt: `You are ${name}, an agent inside bai.\n\nDescribe the agent's role, tone, and workflow here. The body is the system prompt.`,
        tools: ["fs.read", "fs.list"],
      });
      await refresh();
      setSelectedAgent(name);
      setTab("agents");
    } catch (err) {
      onNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const createTool = async (): Promise<void> => {
    setBusy(true);
    try {
      const name = `tool_${Date.now().toString(36)}`;
      await client.putTool(name, toolTemplateCode(name));
      await refresh();
      setSelectedTool(name);
      setTab("tools");
    } catch (err) {
      onNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const deleteSelected = async (): Promise<void> => {
    setBusy(true);
    try {
      if (tab === "agents" && selectedAgent !== null) await client.deleteAgent(selectedAgent);
      if (tab === "tools" && selectedTool !== null) await client.deleteTool(selectedTool);
      setSelectedAgent(null);
      setSelectedTool(null);
      await refresh();
    } catch (err) {
      onNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const useInSession = async (name: string): Promise<void> => {
    if (activeSessionId === null) {
      onNotice("no active session — open one first");
      return;
    }
    try {
      await client.setSessionAgent(activeSessionId, { agent: name });
      onNotice(`session uses "${name}" (applies next prompt)`);
    } catch (err) {
      onNotice(err instanceof Error ? err.message : String(err));
    }
  };

  const agent = agents.find((a) => a.name === selectedAgent) ?? null;
  const tool = tools.find((t) => t.name === selectedTool) ?? null;

  return (
    <div className="agents-layout">
      <div className="agents-list">
        <div className="agents-tabs">
          <button className={tab === "agents" ? "agents-tab active" : "agents-tab"} onClick={() => setTab("agents")}>
            Agents
          </button>
          <button className={tab === "tools" ? "agents-tab active" : "agents-tab"} onClick={() => setTab("tools")}>
            Tools
          </button>
        </div>
        <nav className="agents-items">
          {tab === "agents"
            ? agents.map((a) => (
                <button
                  key={a.name}
                  className={selectedAgent === a.name ? "agents-item active" : "agents-item"}
                  onClick={() => setSelectedAgent(a.name)}
                >
                  <span className="title">{a.name}</span>
                  <span className="dim">
                    {a.source}
                    {a.tools.length > 0 ? ` · ${a.tools.join(", ")}` : " · no tools"}
                  </span>
                </button>
              ))
            : tools.map((t) => (
                <button
                  key={t.name}
                  className={selectedTool === t.name ? "agents-item active" : "agents-item"}
                  onClick={() => setSelectedTool(t.name)}
                >
                  <span className="title">{t.name}</span>
                  <span className="dim">{t.origin}</span>
                </button>
              ))}
        </nav>
        {tab === "agents" ? (
          <button className="agents-create" disabled={busy} onClick={() => void createAgent()}>
            + new agent
          </button>
        ) : (
          <button className="agents-create" disabled={busy} onClick={() => void createTool()}>
            + new tool
          </button>
        )}
      </div>

      <div className="agents-editor">
        {tab === "agents" && agent !== null && (
          <AgentEditor
            key={agent.name}
            client={client}
            agent={agent}
            busy={busy}
            canDelete={agent.source === "file"}
            onSaved={async () => {
              await refresh();
              onNotice(`saved "${agent.name}" — live everywhere`);
            }}
            onDelete={() => void deleteSelected()}
            onUse={() => void useInSession(agent.name)}
            onNotice={onNotice}
          />
        )}
        {tab === "agents" && agent === null && <p className="dim empty">Select or create an agent.</p>}

        {tab === "tools" && tool !== null && (
          <ToolEditor
            key={tool.name}
            client={client}
            tool={tool}
            busy={busy}
            canDelete={tool.origin === "file"}
            onSaved={async () => {
              await refresh();
              onNotice(`saved "${tool.name}" — hot-registered`);
            }}
            onDelete={() => void deleteSelected()}
            onNotice={onNotice}
          />
        )}
        {tab === "tools" && tool === null && <p className="dim empty">Select or create a tool.</p>}
      </div>
    </div>
  );
}

function AgentEditor({
  client,
  agent,
  busy,
  canDelete,
  onSaved,
  onDelete,
  onUse,
  onNotice,
}: {
  client: BaiClient;
  agent: AgentInfo;
  busy: boolean;
  canDelete: boolean;
  onSaved: () => Promise<void>;
  onDelete: () => void;
  onUse: () => void;
  onNotice: (message: string) => void;
}) {
  const [description, setDescription] = useState(agent.description ?? "");
  const [model, setModel] = useState(agent.model ?? "");
  const [tools, setTools] = useState(agent.tools.filter((t) => t !== "*").join(", "));
  const [prompt, setPrompt] = useState(agent.prompt);

  const save = async (): Promise<void> => {
    try {
      const toolList = tools
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
      await client.putAgent(agent.name, {
        description: description.trim().length > 0 ? description.trim() : undefined,
        ...(model.trim().length > 0 ? { model: model.trim() } : {}),
        ...(toolList.length > 0 ? { tools: toolList } : { tools: [] }),
        prompt,
      });
      await onSaved();
    } catch (err) {
      onNotice(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <form
      className="agent-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h3>
        {agent.name} <span className="dim">({agent.source})</span>
      </h3>
      <label>
        description
        <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} />
      </label>
      <label>
        model override <span className="dim">(catalog id, e.g. anthropic/claude-sonnet-4-5 — optional)</span>
        <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="(session model)" />
      </label>
      <label>
        tools <span className="dim">(comma-separated allow-list, e.g. fs.read, fs.glob — empty = no tools)</span>
        <input value={tools} onChange={(e) => setTools(e.target.value)} placeholder="fs.read, fs.list" />
      </label>
      <label>
        system prompt <span className="dim">(the markdown body)</span>
        <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={14} required />
      </label>
      <div className="agents-actions">
        <button type="submit" disabled={busy}>
          save
        </button>
        <button type="button" disabled={busy} onClick={onUse}>
          use in session
        </button>
        {canDelete && (
          <button type="button" className="danger" disabled={busy} onClick={onDelete}>
            delete
          </button>
        )}
      </div>
    </form>
  );
}

function ToolEditor({
  client,
  tool,
  busy,
  canDelete,
  onSaved,
  onDelete,
  onNotice,
}: {
  client: BaiClient;
  tool: ToolListEntry;
  busy: boolean;
  canDelete: boolean;
  onSaved: () => Promise<void>;
  onDelete: () => void;
  onNotice: (message: string) => void;
}) {
  const [code, setCode] = useState<string | null>(null);

  // Fetch the current file content once (the API exposes code only via the
  // file — surfaces read it back through a dedicated GET below).
  useEffect(() => {
    void (async () => {
      try {
        setCode(await client.getToolCode(tool.name));
      } catch (err) {
        onNotice(err instanceof Error ? err.message : String(err));
        setCode("");
      }
    })();
  }, [client, tool.name, onNotice]);

  if (code === null) return <p className="dim">loading…</p>;

  const save = async (): Promise<void> => {
    try {
      const result = await client.putTool(tool.name, code);
      if (!result.registered) onNotice("saved, but the tool failed to register — check the code for errors");
      await onSaved();
    } catch (err) {
      onNotice(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <form
      className="agent-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h3>
        {tool.name} <span className="dim">({tool.origin})</span>
      </h3>
      <label>
        code <span className="dim">(~/.config/bai/tools/{tool.name}.ts — hot-reloaded on save)</span>
        <textarea
          className="code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          rows={22}
          spellCheck={false}
        />
      </label>
      <div className="agents-actions">
        <button type="submit" disabled={busy}>
          save
        </button>
        {canDelete && (
          <button type="button" className="danger" disabled={busy} onClick={onDelete}>
            delete
          </button>
        )}
      </div>
    </form>
  );
}

/** Starter code for a new custom tool (mirrors core's toolTemplate). */
function toolTemplateCode(name: string): string {
  return `// Custom bai tool: ${name}
// The filename stem is the tool's name. Rely on Bun/node builtins —
// npm imports resolve from the config directory, not your workspace.
// After saving, the tool is hot-registered (no restart).

export default {
  description: "What ${name} does, phrased for the model.",
  schema: {
    type: "object",
    properties: {
      input: { type: "string", description: "Describe this argument for the model." },
    },
    required: ["input"],
  },
  async execute(args, ctx) {
    const { input } = args as { input: string };
    // ctx: { sessionId, cwd?, signal, emitLive }
    return { content: \`you said: \${input}\` };
  },
};
`;
}
