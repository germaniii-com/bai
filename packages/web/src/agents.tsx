import { useState } from "react";
import type { BaiClient } from "@bai/api/client";
import { isValidAgentName, type AgentInfo } from "@bai/shared";

/**
 * Agents section, split for the two-level nav: `AgentsNav` renders the
 * nested sidebar (create button + agent list), the main pane is either the
 * `AgentCreateForm` (name first, file written on submit) or the
 * `AgentForm` editor for the selected agent. Files are written through the
 * API — the server hot-reloads them, so a save is live everywhere
 * immediately.
 */

/** Nested-sidebar agent list: create on top, then build first + file agents. */
export function AgentsNav({
  agents,
  selected,
  onSelect,
  onCreate,
  busy,
}: {
  agents: AgentInfo[];
  selected: string | null;
  onSelect: (name: string) => void;
  onCreate: () => void;
  busy: boolean;
}) {
  const sorted = [...agents].sort((a, b) => {
    if (a.name === "build") return -1;
    if (b.name === "build") return 1;
    return a.name.localeCompare(b.name);
  });
  return (
    <div className="settings-nav">
      <button type="button" className="new-session" disabled={busy} onClick={onCreate}>
        + new agent
      </button>
      {sorted.map((a) => (
        <button
          key={a.name}
          type="button"
          className={selected === a.name ? "provider-item active" : "provider-item"}
          onClick={() => onSelect(a.name)}
        >
          <span className="title">{a.name}</span>
          <span className="dim">
            {a.source}
            {a.tools.length > 0 ? ` · ${a.tools.length} tool${a.tools.length === 1 ? "" : "s"}` : " · no tools"}
          </span>
        </button>
      ))}
      {sorted.length === 0 && <p className="dim">No agents yet.</p>}
    </div>
  );
}

/**
 * Creation form: the name is pre-filled (editable) and no file is written
 * until submit — unlike the TUI's instant-template flow. Validates against
 * the shared name rules and the existing set before calling `onSubmit`.
 */
export function AgentCreateForm({
  existing,
  onSubmit,
  onCancel,
}: {
  existing: string[];
  /** Resolves when the agent file was written; the caller selects + refreshes. */
  onSubmit: (name: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(`agent-${Date.now().toString(36)}`);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    const trimmed = name.trim();
    if (!isValidAgentName(trimmed)) {
      setError("Names start with a letter and may contain letters, digits, - and _ (up to 64 characters).");
      return;
    }
    if (existing.includes(trimmed)) {
      setError(`An agent named "${trimmed}" already exists — pick another name.`);
      return;
    }
    setBusy(true);
    try {
      await onSubmit(trimmed);
      // The parent flips to the editor on success; stay busy until unmount.
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <form
      className="agent-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h3>New agent</h3>
      <label>
        name <span className="dim">(the filename stem — ~/.config/bai/agents/&lt;name&gt;.md)</span>
        <input
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
          autoFocus
          required
          maxLength={64}
          spellCheck={false}
        />
      </label>
      {error !== null && <div className="error">{error}</div>}
      <p className="dim">
        Created from a starter template — description, tools, and the system prompt are editable right after creating.
      </p>
      <div className="agents-actions">
        <button type="submit" disabled={busy}>
          create
        </button>
        <button type="button" disabled={busy} onClick={onCancel}>
          cancel
        </button>
      </div>
    </form>
  );
}

/**
 * Main pane: the selected agent's form editor (description / model override /
 * tool allow-list / system prompt). Saves write the markdown file via the API.
 */
export function AgentsPane({
  client,
  agents,
  selectedId,
  activeSessionId,
  refresh,
  onNotice,
}: {
  client: BaiClient;
  agents: AgentInfo[];
  selectedId: string | null;
  activeSessionId: string | null;
  refresh: () => Promise<void>;
  onNotice: (message: string) => void;
}) {
  const agent = agents.find((a) => a.name === selectedId);
  if (agent === undefined) {
    return (
      <div className="agents-pane">
        <p className="dim empty">Select or create an agent.</p>
      </div>
    );
  }
  return (
    <div className="agents-pane">
      <AgentForm
        key={agent.name}
        client={client}
        agent={agent}
        activeSessionId={activeSessionId}
        refresh={refresh}
        onNotice={onNotice}
      />
    </div>
  );
}

function AgentForm({
  client,
  agent,
  activeSessionId,
  refresh,
  onNotice,
}: {
  client: BaiClient;
  agent: AgentInfo;
  activeSessionId: string | null;
  refresh: () => Promise<void>;
  onNotice: (message: string) => void;
}) {
  const [description, setDescription] = useState(agent.description ?? "");
  const [model, setModel] = useState(agent.model ?? "");
  const [tools, setTools] = useState(agent.tools.filter((t) => t !== "*").join(", "));
  const [prompt, setPrompt] = useState(agent.prompt);
  const [busy, setBusy] = useState(false);

  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      const toolList = tools
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
      await client.putAgent(agent.name, {
        description: description.trim().length > 0 ? description.trim() : undefined,
        ...(model.trim().length > 0 ? { model: model.trim() } : {}),
        tools: toolList,
        prompt,
      });
      await refresh();
      onNotice(`saved "${agent.name}" — live everywhere`);
    } catch (err) {
      onNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    setBusy(true);
    try {
      await client.deleteAgent(agent.name);
      await refresh();
      onNotice(`deleted "${agent.name}"`);
    } catch (err) {
      onNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const useInSession = async (): Promise<void> => {
    setBusy(true);
    try {
      if (activeSessionId === null) {
        // No session open: the explicit gesture persists the config default
        // agent (what sessions without a selection resolve at drain time).
        await client.putConfig({ agents: { default: agent.name } });
        onNotice(`default agent set to "${agent.name}" (sessions without a selection use it)`);
      } else {
        await client.setSessionAgent(activeSessionId, { agent: agent.name });
        onNotice(`session uses "${agent.name}" (applies next prompt)`);
      }
    } catch (err) {
      onNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
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
        <button type="button" disabled={busy} onClick={() => void useInSession()}>
          {activeSessionId === null ? "set as default" : "use in session"}
        </button>
        {agent.source === "file" && (
          <button type="button" className="danger" disabled={busy} onClick={() => void remove()}>
            delete
          </button>
        )}
      </div>
    </form>
  );
}
