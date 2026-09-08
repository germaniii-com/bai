import { useEffect, useState } from "react";
import { GraduationCap, Sparkles } from "lucide-react";
import type { BaiClient } from "@bai/api/client";
import type { ProviderListResponse, SkillInfo, SkillUsageTotals } from "@bai/shared";
import { isValidSkillName } from "@bai/shared";
import { ModelModal } from "./model-picker";

/** Toast feedback callback — kind defaults to success (see toast.tsx). */
type OnNotice = (message: string, kind?: "success" | "error") => void;

/**
 * Skills section, split for the two-level nav: `SkillsNav` renders the
 * nested sidebar (create button + skill list), the main pane is either the
 * `SkillCreateForm` (name first, SKILL.md written on submit) or the
 * `SkillForm` editor for the selected skill. Saving writes the file via the
 * API — the server hot-reloads it, so the next agent turn sees the change.
 */

/** Nested-sidebar skill list: create on top, then skills alphabetically. */
export function SkillsNav({
  skills,
  selected,
  onSelect,
  onCreate,
  busy,
}: {
  skills: SkillInfo[];
  selected: string | null;
  onSelect: (name: string) => void;
  onCreate: () => void;
  busy: boolean;
}) {
  const sorted = [...skills].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div className="settings-nav">
      <button type="button" className="new-session" disabled={busy} onClick={onCreate}>
        + new skill
      </button>
      {sorted.map((s) => (
        <button
          key={s.name}
          type="button"
          className={selected === s.name ? "provider-item active" : "provider-item"}
          onClick={() => onSelect(s.name)}
          aria-current={selected === s.name ? "page" : undefined}
        >
          <span className="title">{s.name}</span>
          <span className="dim">{s.tags !== undefined && s.tags.length > 0 ? s.tags.slice(0, 3).join(", ") : "skill"}</span>
        </button>
      ))}
      {sorted.length === 0 && <p className="dim">No skills yet.</p>}
    </div>
  );
}

/**
 * Creation form: the name is pre-filled (editable) and no file is written
 * until submit. Validates against the shared name rules and the existing
 * set before calling `onSubmit`.
 */
export function SkillCreateForm({
  existing,
  onSubmit,
  onCancel,
  onLearn,
}: {
  existing: string[];
  /** Resolves when the SKILL.md file was written; the caller selects + refreshes. */
  onSubmit: (name: string) => Promise<void>;
  onCancel: () => void;
  /** Swap to the "Learn with AI" form (agent authors the skill for you). */
  onLearn: () => void;
}) {
  const [name, setName] = useState(`skill-${Date.now().toString(36)}`);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    const trimmed = name.trim();
    if (!isValidSkillName(trimmed)) {
      setError("Names start with a letter and may contain letters, digits, - and _ (up to 64 characters).");
      return;
    }
    if (existing.includes(trimmed)) {
      setError(`A skill named "${trimmed}" already exists — pick another name.`);
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
      <h3>New skill</h3>
      <label>
        name <span className="dim">(the directory stem — ~/.config/bai/skills/&lt;name&gt;/SKILL.md)</span>
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
        Created from a starter template — description, tags, and the instructions are editable right after creating.
        The agent loads the skill on demand via skills.view.
      </p>
      <div className="agents-actions">
        <button type="submit" disabled={busy}>
          create
        </button>
        <button type="button" disabled={busy} onClick={onLearn}>
          learn with AI instead
        </button>
        <button type="button" disabled={busy} onClick={onCancel}>
          cancel
        </button>
      </div>
    </form>
  );
}

/**
 * Main pane: the selected skill's form editor (description / version / tags
 * / instructions body), its usage stats, and its linked files (read-only —
 * they are managed on disk). Saves write SKILL.md via the API.
 */
export function SkillsPane({
  client,
  skills,
  selectedId,
  refresh,
  onNotice,
}: {
  client: BaiClient;
  skills: SkillInfo[];
  selectedId: string | null;
  refresh: () => Promise<void>;
  onNotice: OnNotice;
}) {
  const skill = skills.find((s) => s.name === selectedId);
  if (skill === undefined) {
    return (
      <div className="agents-pane">
        <p className="dim empty">Select or create a skill.</p>
      </div>
    );
  }
  return (
    <div className="agents-pane">
      <SkillForm key={skill.name} client={client} skill={skill} refresh={refresh} onNotice={onNotice} />
    </div>
  );
}

function SkillForm({
  client,
  skill,
  refresh,
  onNotice,
}: {
  client: BaiClient;
  skill: SkillInfo;
  refresh: () => Promise<void>;
  onNotice: OnNotice;
}) {
  const [description, setDescription] = useState(skill.description);
  const [version, setVersion] = useState(skill.version ?? "");
  const [tags, setTags] = useState(skill.tags?.join(", ") ?? "");
  const [body, setBody] = useState(skill.body);
  const [usage, setUsage] = useState<SkillUsageTotals | null>(null);
  const [busy, setBusy] = useState(false);

  // Per-skill usage totals (views · sessions · last used) — a fresh fetch
  // per form instance (keyed by skill name), refreshed after each save.
  useEffect(() => {
    void (async () => {
      try {
        const detail = await client.getSkill(skill.name);
        setUsage(detail?.usage ?? { views: 0, sessions: 0 });
      } catch {
        setUsage(null); // advisory — the stats line just stays hidden
      }
    })();
  }, [client, skill.name]);

  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      const tagList = tags
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
      await client.putSkill(skill.name, {
        description: description.trim(),
        ...(version.trim().length > 0 ? { version: version.trim() } : {}),
        ...(tagList.length > 0 ? { tags: tagList } : {}),
        body,
      });
      await refresh();
      onNotice(`saved "${skill.name}" — live for the next agent turn`);
    } catch (err) {
      onNotice(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    setBusy(true);
    try {
      await client.deleteSkill(skill.name);
      await refresh();
      onNotice(`deleted "${skill.name}"`);
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
      <h3>
        {skill.name} <span className="dim">(skill)</span>
      </h3>
      {usage !== null && (
        <p className="dim">
          {usage.views} view{usage.views === 1 ? "" : "s"} · {usage.sessions} session{usage.sessions === 1 ? "" : "s"}
          {usage.lastUsedAt !== undefined ? ` · last used ${new Date(usage.lastUsedAt).toLocaleString()}` : " · never used"}
        </p>
      )}
      <label>
        description <span className="dim">(one sentence — the first ~60 chars show in the agent's skill index)</span>
        <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} required />
      </label>
      <label>
        version <span className="dim">(optional)</span>
        <input value={version} onChange={(e) => setVersion(e.target.value)} placeholder="1.0.0" maxLength={20} />
      </label>
      <label>
        tags <span className="dim">(comma-separated, optional)</span>
        <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="research, papers" />
      </label>
      <label>
        instructions <span className="dim">(the markdown body of SKILL.md — hot-reloaded on save)</span>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={14} required />
      </label>
      {skill.linkedFiles.length > 0 && (
        <label>
          linked files <span className="dim">(read-only here — the agent reads them via skills.view(name, path); edit on disk)</span>
          <ul className="skill-linked-files">
            {skill.linkedFiles.map((f) => (
              <li key={f}>
                <code>{f}</code>
              </li>
            ))}
          </ul>
        </label>
      )}
      <div className="agents-actions">
        <button type="submit" disabled={busy}>
          save
        </button>
        <button type="button" className="danger" disabled={busy} onClick={() => void remove()}>
          delete
        </button>
      </div>
    </form>
  );
}

/**
 * Learn with AI (hermes /learn parity, no slash command): describe what to
 * learn, optionally pin a model (the composer's three-column picker in
 * capture mode), and submit — the server spawns a visible learn session
 * whose first turn distills the request into a skill. `onLearned` receives
 * the session id so the caller can navigate to it and watch.
 */
export function SkillLearnForm({
  client,
  list,
  refreshProviders,
  preferZdr,
  configDefault,
  onLearned,
  onBack,
}: {
  client: BaiClient;
  /** Provider list for the model picker (null until the first fetch lands). */
  list: ProviderListResponse | null;
  refreshProviders: () => Promise<void>;
  preferZdr?: boolean;
  /** Default model from GET /api/config — keeps the picker label truthful. */
  configDefault?: string;
  /** Resolves when the learn session was spawned; the caller navigates to it. */
  onLearned: (sessionId: string) => Promise<void>;
  /** Back to the manual create form. */
  onBack: () => void;
}) {
  const [request, setRequest] = useState("");
  const [model, setModel] = useState<string | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    const text = request.trim();
    if (text.length === 0) {
      setError("Describe what to learn — sources (paths, URLs), requirements, or leave it to the conversation.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const session = await client.learnSkill({
        request: text,
        ...(model !== null ? { model } : {}),
        ...(model !== null && account !== null ? { account } : {}),
      });
      await onLearned(session.id);
      // The parent navigates away on success; stay busy until unmount.
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
      <h3>
        <GraduationCap size={16} aria-hidden="true" style={{ verticalAlign: "-2px" }} /> Learn a skill
      </h3>
      <p className="dim">
        An agent gathers the sources you describe and authors the skill for you. Point it at a directory, a URL,
        pasted material, or a workflow — requirements after a source are honored ("focus on the auth flow").
      </p>
      <label>
        what would you like to learn?
        <textarea
          value={request}
          onChange={(e) => {
            setRequest(e.target.value);
            setError(null);
          }}
          rows={6}
          autoFocus
          required
          maxLength={8000}
          placeholder="e.g. the REST client in ~/projects/acme-sdk, focus on the auth flow — or https://docs.example.com/api, skip the deprecated endpoints"
        />
      </label>
      <label>
        model <span className="dim">(the learn session runs on it — optional)</span>
        <button type="button" className="model-button" onClick={() => setPickerOpen(true)} aria-haspopup="dialog">
          <Sparkles size={12} aria-hidden="true" />
          <span className="model-current">{model ?? configDefault ?? "server default"}</span>
        </button>
      </label>
      {error !== null && <div className="error">{error}</div>}
      <div className="agents-actions">
        <button type="submit" disabled={busy}>
          {busy ? "starting…" : "learn it"}
        </button>
        <button type="button" disabled={busy} onClick={onBack}>
          create manually instead
        </button>
      </div>
      {pickerOpen && (
        <ModelModal
          client={client}
          list={list}
          active={null}
          preferZdr={preferZdr}
          refreshProviders={refreshProviders}
          current={model ?? configDefault ?? "stub/echo"}
          onClose={() => setPickerOpen(false)}
          onPick={(modelId, accountId) => {
            setModel(modelId);
            setAccount(accountId);
          }}
        />
      )}
    </form>
  );
}
