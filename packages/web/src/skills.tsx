import { useEffect, useState } from "react";
import { GraduationCap, Sparkles } from "lucide-react";
import type { BaiClient } from "@bai/api/client";
import type { ProviderListResponse, SkillInfo, SkillUsageTotals } from "@bai/shared";
import { isValidSkillName } from "@bai/shared";
import { ModelModal } from "./model-picker";
import { Button, Chip, Field, SectionHeader, SubNav, SubNavCreate, SubNavItem, TextInput, Textarea } from "./components";

/** Toast feedback callback — kind defaults to success (see toast.tsx). */
type OnNotice = (message: string, kind?: "success" | "error") => void;

/**
 * Skills section, split for the two-level nav: `SkillsNav` renders the nested
 * sidebar (create button + skill list), the main pane is either the
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
    <SubNav>
      <SubNavCreate label="+ New skill" disabled={busy} onClick={onCreate} />
      {sorted.map((s) => (
        <SubNavItem
          key={s.name}
          title={s.name}
          subtitle={s.tags !== undefined && s.tags.length > 0 ? s.tags.slice(0, 3).join(", ") : "skill"}
          selected={selected === s.name}
          onClick={() => onSelect(s.name)}
          ariaCurrent={selected === s.name ? "page" : undefined}
        />
      ))}
      {sorted.length === 0 && <p className="dim">No skills yet.</p>}
    </SubNav>
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
      <SectionHeader title="New skill" />
      <Field label="Name" hint="(the directory stem — ~/.config/bai/skills/<name>/SKILL.md)">
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
        Created from a starter template — description, tags, and the instructions are editable right after creating.
        The agent loads the skill on demand via skills.view.
      </p>
      <div className="agents-actions">
        <Button type="submit" variant="primary" loading={busy}>
          Create
        </Button>
        <Button variant="secondary" disabled={busy} onClick={onLearn}>
          Learn with AI instead
        </Button>
        <Button variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
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
  // Linked-file editing: click a file to load it into the inline editor;
  // "+ add file" writes a new one. Paths are validated client-side and
  // (authoritatively) server-side by the same support-dir rules.
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [addingFile, setAddingFile] = useState(false);
  const [newPath, setNewPath] = useState("");
  const [newContent, setNewContent] = useState("");

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

  const openLinkedFile = async (file: string): Promise<void> => {
    setAddingFile(false);
    setOpenFile(file);
    setFileContent(null);
    try {
      setFileContent(await client.getSkillFile(skill.name, file));
    } catch (err) {
      onNotice(err instanceof Error ? err.message : String(err), "error");
      setOpenFile(null);
    }
  };

  const saveLinkedFile = async (): Promise<void> => {
    if (openFile === null || fileContent === null) return;
    setBusy(true);
    try {
      await client.putSkillFile(skill.name, openFile, fileContent);
      await refresh();
      onNotice(`saved ${openFile}`);
    } catch (err) {
      onNotice(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setBusy(false);
    }
  };

  const deleteLinkedFile = async (): Promise<void> => {
    if (openFile === null) return;
    setBusy(true);
    try {
      await client.deleteSkillFile(skill.name, openFile);
      setOpenFile(null);
      setFileContent(null);
      await refresh();
      onNotice(`deleted ${openFile}`);
    } catch (err) {
      onNotice(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setBusy(false);
    }
  };

  const createLinkedFile = async (): Promise<void> => {
    const path = newPath.trim();
    if (!/^(references|templates|scripts|assets)\//.test(path) || path.includes("..")) {
      onNotice("path must start with references/, templates/, scripts/, or assets/ (no ..)", "error");
      return;
    }
    if (newContent.trim().length === 0) {
      onNotice("content must be non-empty", "error");
      return;
    }
    setBusy(true);
    try {
      await client.putSkillFile(skill.name, path, newContent);
      setAddingFile(false);
      setNewPath("");
      setNewContent("");
      await refresh();
      onNotice(`created ${path}`);
      await openLinkedFile(path);
    } catch (err) {
      onNotice(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setBusy(false);
    }
  };

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
      <SectionHeader
        title={
          <>
            {skill.name} <span className="dim">(skill)</span>
          </>
        }
      />
      {usage !== null && (
        <p className="section-lede">
          {usage.views} view{usage.views === 1 ? "" : "s"} · {usage.sessions} session{usage.sessions === 1 ? "" : "s"}
          {usage.lastUsedAt !== undefined ? ` · last used ${new Date(usage.lastUsedAt).toLocaleString()}` : " · never used"}
        </p>
      )}
      <Field
        label="Description"
        hint="(one sentence — the first ~60 chars show in the agent's skill index)"
      >
        <TextInput value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} required />
      </Field>
      <Field label="Version" hint="(optional)">
        <TextInput value={version} onChange={(e) => setVersion(e.target.value)} placeholder="1.0.0" maxLength={20} />
      </Field>
      <Field label="Tags" hint="(comma-separated, optional)">
        <TextInput value={tags} onChange={(e) => setTags(e.target.value)} placeholder="research, papers" />
      </Field>
      <Field label="Instructions" hint="(the markdown body of SKILL.md — hot-reloaded on save)">
        <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={14} required />
      </Field>
      <Field
        label="Linked files"
        hint="(references/, templates/, scripts/, assets/ — the agent reads them via skills.view(name, path))"
      >
        <div className="skill-linked-files">
          {skill.linkedFiles.map((f) => (
            <Chip key={f} interactive selected={openFile === f} onClick={() => void openLinkedFile(f)}>
              <code>{f}</code>
            </Chip>
          ))}
          <Chip interactive add onClick={() => { setAddingFile(true); setOpenFile(null); }}>
            + Add file
          </Chip>
        </div>
      </Field>
      {openFile !== null && fileContent !== null && (
        <Field
          label={
            <>
              Editing <code>{openFile}</code>
            </>
          }
        >
          <Textarea
            mono
            value={fileContent}
            onChange={(e) => setFileContent(e.target.value)}
            rows={12}
            spellCheck={false}
          />
          <div className="agents-actions">
            <Button variant="secondary" disabled={busy} onClick={() => void saveLinkedFile()}>
              Save file
            </Button>
            <Button variant="danger" disabled={busy} onClick={() => void deleteLinkedFile()}>
              Delete file
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => { setOpenFile(null); setFileContent(null); }}>
              Close
            </Button>
          </div>
        </Field>
      )}
      {addingFile && (
        <Field
          label="New file path"
          hint="(must start with references/, templates/, scripts/, or assets/)"
        >
          <TextInput
            value={newPath}
            onChange={(e) => setNewPath(e.target.value)}
            placeholder="references/api.md"
            spellCheck={false}
          />
          <Textarea
            mono
            value={newContent}
            onChange={(e) => setNewContent(e.target.value)}
            rows={8}
            placeholder="File content…"
            spellCheck={false}
          />
          <div className="agents-actions">
            <Button variant="secondary" disabled={busy} onClick={() => void createLinkedFile()}>
              Create file
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setAddingFile(false)}>
              Cancel
            </Button>
          </div>
        </Field>
      )}
      <div className="agents-actions">
        <Button type="submit" variant="primary" loading={busy}>
          Save
        </Button>
        <Button variant="danger" disabled={busy} onClick={() => void remove()}>
          Delete
        </Button>
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
      <SectionHeader
        title={
          <>
            <GraduationCap size={16} aria-hidden="true" style={{ verticalAlign: "-2px" }} /> Learn a skill
          </>
        }
      />
      <p className="section-lede">
        An agent gathers the sources you describe and authors the skill for you. Point it at a directory, a URL,
        pasted material, or a workflow — requirements after a source are honored ("focus on the auth flow").
      </p>
      <Field label="What would you like to learn?">
        <Textarea
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
      </Field>
      <Field label="Model" hint="(the learn session runs on it — optional)">
        <button type="button" className="model-button" onClick={() => setPickerOpen(true)} aria-haspopup="dialog">
          <Sparkles size={12} aria-hidden="true" />
          <span className="model-current">{model ?? configDefault ?? "server default"}</span>
        </button>
      </Field>
      {error !== null && <div className="error">{error}</div>}
      <div className="agents-actions">
        <Button type="submit" variant="primary" loading={busy}>
          Learn it
        </Button>
        <Button variant="ghost" disabled={busy} onClick={onBack}>
          Create manually instead
        </Button>
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
