import { useState } from "react";
import { Bot } from "lucide-react";
import type { BaiClient } from "@bai/api/client";
import { isValidAgentName, type AgentInfo, type ProviderListResponse, type SkillInfo, type ToolListEntry } from "@bai/shared";
import { modelOverrideOptions } from "./provider-utils";
import { Button, Checkbox, Combobox, ConfirmDialog, Field, SectionHeader, SubNav, SubNavCreate, SubNavItem, TextInput, Textarea, type ComboboxOption } from "./components";

/** Toast feedback callback — kind defaults to success (see toast.tsx). */
type OnNotice = (message: string, kind?: "success" | "error") => void;

/**
 * Agents section, split for the two-level nav: `AgentsNav` renders the
 * nested sidebar (create button + agent list); the main pane is the
 * `AgentForm` editor — for the selected agent, or a not-yet-written draft in
 * `creating` mode. Files are written through the API — the server
 * hot-reloads them, so a save is live everywhere immediately.
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
      <SubNavCreate
        icon={<Bot size={15} aria-hidden="true" />}
        label="New agent"
        disabled={busy}
        onClick={onCreate}
      />
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

/** Seed values for a not-yet-written agent (the create-mode form). */
function draftAgent(): AgentInfo {
  return {
    name: `agent-${Date.now().toString(36)}`,
    description: "What this agent is for.",
    tools: ["fs.read", "fs.list"],
    skills: ["*"],
    prompt: "Describe the agent's role, tone, and workflow here. The body is the system prompt.",
    source: "file",
  };
}

/**
 * Main pane: the agent editor (description / model override / tool allow-list
 * / system prompt). In `creating` mode it edits a draft whose name is
 * editable; Save writes the file, refreshes, and hands the new name back.
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
  creating = false,
  onCreated,
  onCancel,
  list = null,
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
  /** Render the full form for a new agent (name editable) instead of a selection. */
  creating?: boolean;
  /** Called with the new agent's name after a successful create. */
  onCreated?: (name: string) => void;
  /** Discard the draft (create mode). */
  onCancel?: () => void;
  /** Provider list — the model-override combobox's options. */
  list?: ProviderListResponse | null;
}) {
  if (creating) {
    return (
      <div className="agents-pane">
        <AgentForm
          key="__new_agent__"
          client={client}
          agent={draftAgent()}
          tools={tools}
          skills={skills}
          activeSessionId={activeSessionId}
          refresh={refresh}
          onNotice={onNotice}
          creating
          existing={agents.map((a) => a.name)}
          {...(onCreated !== undefined ? { onCreated } : {})}
          {...(onCancel !== undefined ? { onCancel } : {})}
          list={list}
        />
      </div>
    );
  }
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
        list={list}
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
  creating = false,
  existing = [],
  onCreated,
  onCancel,
  list = null,
}: {
  client: BaiClient;
  agent: AgentInfo;
  tools: ToolListEntry[];
  skills: SkillInfo[];
  activeSessionId: string | null;
  refresh: () => Promise<void>;
  onNotice: OnNotice;
  creating?: boolean;
  existing?: string[];
  onCreated?: (name: string) => void;
  onCancel?: () => void;
  list?: ProviderListResponse | null;
}) {
  const [name, setName] = useState(agent.name);
  const [description, setDescription] = useState(agent.description ?? "");
  const [model, setModel] = useState(agent.model ?? "");
  const [toolList, setToolList] = useState<string[]>(agent.tools);
  // Skills whitelist: the checkbox is the allow-all state (frontmatter
  // absent or ["*"]); unchecking reveals the combobox for a specific list.
  const [allSkills, setAllSkills] = useState(agent.skills === undefined || agent.skills.includes("*"));
  const [skillList, setSkillList] = useState<string[]>(agent.skills?.filter((s) => s !== "*") ?? []);
  const [prompt, setPrompt] = useState(agent.prompt);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const save = async (): Promise<void> => {
    const trimmed = name.trim();
    if (creating) {
      if (!isValidAgentName(trimmed)) {
        onNotice("Names start with a letter and may contain letters, digits, - and _ (up to 64 characters).", "error");
        return;
      }
      if (existing.includes(trimmed)) {
        onNotice(`An agent named "${trimmed}" already exists — pick another name.`, "error");
        return;
      }
    }
    setBusy(true);
    try {
      await client.putAgent(creating ? trimmed : agent.name, {
        description: description.trim().length > 0 ? description.trim() : undefined,
        ...(model.trim().length > 0 ? { model: model.trim() } : {}),
        tools: toolList,
        skills: allSkills ? ["*"] : skillList,
        prompt,
      });
      await refresh();
      if (creating) {
        onNotice(`created "${trimmed}" — live everywhere`);
        onCreated?.(trimmed);
        return;
      }
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
          creating ? (
            "New agent"
          ) : (
            <>
              {agent.name} <span className="dim">({agent.source})</span>
            </>
          )
        }
      />
      {creating && (
        <Field label="Name" hint="(the filename stem — ~/.config/bai/agents/<name>.md)">
          <TextInput
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            required
            maxLength={64}
            spellCheck={false}
          />
        </Field>
      )}
      <Field label="Description">
        <TextInput value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} />
      </Field>
      <Field label="Model override" hint="(optional — inherits the session/agent default when unset)">
        <Combobox
          value={model}
          onChange={setModel}
          options={modelOverrideOptions(list)}
          placeholder="(agent/session model)"
          ariaLabel="Model override"
          creatable
          emptyText="No matching model."
        />
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
      {/* Skills whitelist: the checkbox is its own labelled control. Checked =
          ["*"]; unchecked = the picked list. */}
      <Field
        label="Skills"
        hint="(what this agent can load — authoring follows the tools list)"
      >
        <Checkbox
          label="Allow all skills (*)"
          checked={allSkills}
          onChange={(e) => setAllSkills(e.target.checked)}
        />
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
      </Field>
      {/* The system prompt is the grow field: it fills the remaining pane
          height (the page itself does not scroll). */}
      <Field className="field-grow" label="System prompt" hint="(the markdown body)">
        <Textarea
          className="grow-input"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          required
        />
      </Field>
      <div className="agents-actions">
        <Button type="submit" variant="primary" loading={busy}>
          {creating ? "Create" : "Save"}
        </Button>
        {!creating && (
          <Button variant="secondary" disabled={busy} onClick={() => void useInSession()}>
            {activeSessionId === null ? "Set as default" : "Use in session"}
          </Button>
        )}
        {!creating && agent.source === "file" && (
          <Button variant="danger" disabled={busy} onClick={() => setConfirmDelete(true)}>
            Delete
          </Button>
        )}
        {creating && onCancel !== undefined && (
          <Button variant="ghost" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
      <ConfirmDialog
        open={confirmDelete}
        title="Delete agent?"
        body={
          <>
            Delete <strong>{agent.name}</strong>? Its file is removed and the change is live everywhere. This cannot
            be undone.
          </>
        }
        confirmLabel="Delete"
        busy={busy}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => {
          setConfirmDelete(false);
          void remove();
        }}
      />
    </form>
  );
}
