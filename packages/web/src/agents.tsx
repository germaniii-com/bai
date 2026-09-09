import { useState } from "react";
import type { BaiClient } from "@bai/api/client";
import { isValidAgentName, type AgentInfo, type SkillInfo, type ToolListEntry } from "@bai/shared";
import { Button, Combobox, Field, SectionHeader, SubNav, SubNavCreate, SubNavItem, TextInput, Textarea, type ComboboxOption } from "./components";

/** Toast feedback callback — kind defaults to success (see toast.tsx). */
type OnNotice = (message: string, kind?: "success" | "error") => void;

/**
 * Agents section, split for the two-level nav: `AgentsNav` renders the
 * nested sidebar (create button + agent list), the main pane is either the
 * `AgentCreateForm` (name first, file written on submit) or the
 * `AgentForm` editor for the selected agent. Files are written through the
 * API — the server hot-reloads them, so a save is live everywhere
 * immediately.
 */

/** The tools combobox's options: the registered tools + the "*" wildcard. */
function toolOptions(tools: ToolListEntry[]): ComboboxOption[] {
  return [
    { value: "*", label: "* (all tools)", hint: "every registered tool" },
    ...tools.map((t) => ({ value: t.name, label: t.name, hint: t.origin })),
  ];
}

/** The skills combobox's options: name + a one-line description hint. */
function skillOptions(skills: SkillInfo[]): ComboboxOption[] {
  return skills.map((s) => ({
    value: s.name,
    label: s.name,
    hint: s.description.length > 60 ? `${s.description.slice(0, 60)}…` : s.description,
  }));
}

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
    <SubNav>
      <SubNavCreate label="+ New agent" disabled={busy} onClick={onCreate} />
      {sorted.map((a) => (
        <SubNavItem
          key={a.name}
          title={a.name}
          subtitle={
            a.source +
            (a.tools.length > 0 ? ` · ${a.tools.length} tool${a.tools.length === 1 ? "" : "s"}` : " · no tools")
          }
          selected={selected === a.name}
          onClick={() => onSelect(a.name)}
          ariaCurrent={selected === a.name ? "page" : undefined}
        />
      ))}
      {sorted.length === 0 && <p className="dim">No agents yet.</p>}
    </SubNav>
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
      <SectionHeader title="New agent" />
      <Field
        label="Name"
        hint="(the filename stem — ~/.config/bai/agents/<name>.md)"
      >
        <TextInput
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
      </Field>
      {error !== null && <div className="error">{error}</div>}
      <p className="section-lede">
        Created from a starter template — description, tools, and the system prompt are editable right after creating.
      </p>
      <div className="agents-actions">
        <Button type="submit" variant="primary" loading={busy}>
          Create
        </Button>
        <Button variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
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
  tools,
  skills,
  selectedId,
  activeSessionId,
  refresh,
  onNotice,
}: {
  client: BaiClient;
  agents: AgentInfo[];
  /** Registered tools — the tools combobox's options. */
  tools: ToolListEntry[];
  /** Registered skills — the skills whitelist combobox's options. */
  skills: SkillInfo[];
  selectedId: string | null;
  activeSessionId: string | null;
  refresh: () => Promise<void>;
  onNotice: OnNotice;
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
        tools={tools}
        skills={skills}
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
  tools,
  skills,
  activeSessionId,
  refresh,
  onNotice,
}: {
  client: BaiClient;
  agent: AgentInfo;
  tools: ToolListEntry[];
  skills: SkillInfo[];
  activeSessionId: string | null;
  refresh: () => Promise<void>;
  onNotice: OnNotice;
}) {
  const [description, setDescription] = useState(agent.description ?? "");
  const [model, setModel] = useState(agent.model ?? "");
  const [toolList, setToolList] = useState<string[]>(agent.tools);
  // Skills whitelist: the checkbox is the allow-all state (frontmatter
  // absent or ["*"]); unchecking reveals the combobox for a specific list.
  const [allSkills, setAllSkills] = useState(agent.skills === undefined || agent.skills.includes("*"));
  const [skillList, setSkillList] = useState<string[]>(agent.skills?.filter((s) => s !== "*") ?? []);
  const [prompt, setPrompt] = useState(agent.prompt);
  const [busy, setBusy] = useState(false);

  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      await client.putAgent(agent.name, {
        description: description.trim().length > 0 ? description.trim() : undefined,
        ...(model.trim().length > 0 ? { model: model.trim() } : {}),
        tools: toolList,
        skills: allSkills ? ["*"] : skillList,
        prompt,
      });
      await refresh();
      onNotice(`saved "${agent.name}" — live everywhere`);
    } catch (err) {
      onNotice(err instanceof Error ? err.message : String(err), "error");
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
      onNotice(err instanceof Error ? err.message : String(err), "error");
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
      onNotice(err instanceof Error ? err.message : String(err), "error");
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
      <SectionHeader
        title={
          <>
            {agent.name} <span className="dim">({agent.source})</span>
          </>
        }
      />
      <Field label="Description">
        <TextInput value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} />
      </Field>
      <Field
        label="Model override"
        hint="(catalog id, e.g. anthropic/claude-sonnet-4-5 — optional)"
      >
        <TextInput value={model} onChange={(e) => setModel(e.target.value)} placeholder="(session model)" />
      </Field>
      <Field
        label="Tools"
        hint="(type to search; empty = no tools; “*” = all)"
      >
        <Combobox
          multiple
          values={toolList}
          onValuesChange={setToolList}
          options={toolOptions(tools)}
          placeholder="Add tool…"
          ariaLabel="Allowed tools"
          emptyText="No matching tool."
        />
      </Field>
      {/* Skills whitelist (plain div — the checkbox gets its own label, so
          no label nesting). Checked = ["*"]; unchecked = the picked list. */}
      <div className="field">
        <span className="field-label">
          Skills <span className="field-hint">(what this agent can load — authoring follows the tools list)</span>
        </span>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={allSkills}
            onChange={(e) => setAllSkills(e.target.checked)}
          />
          Allow all skills (*)
        </label>
        {!allSkills && (
          <Combobox
            multiple
            values={skillList}
            onValuesChange={setSkillList}
            options={skillOptions(skills)}
            placeholder="Add skill…"
            ariaLabel="Allowed skills"
            emptyText="No matching skill."
          />
        )}
      </div>
      <Field
        label="System prompt"
        hint="(the markdown body)"
      >
        <Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={14} required />
      </Field>
      <div className="agents-actions">
        <Button type="submit" variant="primary" loading={busy}>
          Save
        </Button>
        <Button variant="secondary" disabled={busy} onClick={() => void useInSession()}>
          {activeSessionId === null ? "Set as default" : "Use in session"}
        </Button>
        {agent.source === "file" && (
          <Button variant="danger" disabled={busy} onClick={() => void remove()}>
            Delete
          </Button>
        )}
      </div>
    </form>
  );
}
