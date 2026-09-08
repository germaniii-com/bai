import { useEffect, useState } from "react";
import { Editor } from "@monaco-editor/react";
import type { BaiClient } from "@bai/api/client";
import { isValidToolName, type ThemeColors, type ToolListEntry } from "@bai/shared";
import { defineBaiTheme } from "./monaco-setup";
import { Button, Field, SectionHeader, SubNav, SubNavCreate, SubNavItem, TextInput } from "./components";

/** Toast feedback callback — kind defaults to success (see toast.tsx). */
type OnNotice = (message: string, kind?: "success" | "error") => void;

/**
 * Tools section, split for the two-level nav: `ToolsNav` renders the nested
 * sidebar (create button + custom/built-in tools), the main pane is either
 * the `ToolCreateForm` (name first, file written on submit) or the
 * `ToolForm` code editor for the selected tool. Saving writes the file via
 * the API — the loader hot-imports it, no restart.
 */

/** Nested-sidebar tool list: create on top, file tools first, then built-ins. */
export function ToolsNav({
  tools,
  selected,
  onSelect,
  onCreate,
  busy,
}: {
  tools: ToolListEntry[];
  selected: string | null;
  onSelect: (name: string) => void;
  onCreate: () => void;
  busy: boolean;
}) {
  const sorted = [...tools].sort((a, b) => {
    const af = a.origin === "file" ? 0 : 1;
    const bf = b.origin === "file" ? 0 : 1;
    if (af !== bf) return af - bf;
    return a.name.localeCompare(b.name);
  });
  return (
    <SubNav>
      <SubNavCreate label="+ New tool" disabled={busy} onClick={onCreate} />
      {sorted.map((t) => (
        <SubNavItem
          key={t.name}
          title={t.name}
          subtitle={t.origin}
          selected={selected === t.name}
          onClick={() => onSelect(t.name)}
          ariaCurrent={selected === t.name ? "page" : undefined}
        />
      ))}
      {sorted.length === 0 && <p className="dim">No tools yet.</p>}
    </SubNav>
  );
}

/**
 * Creation form: the name is pre-filled (editable) and no file is written
 * until submit. Validates against the shared name rules and the existing
 * set before calling `onSubmit`.
 */
export function ToolCreateForm({
  existing,
  onSubmit,
  onCancel,
}: {
  existing: string[];
  /** Resolves when the tool file was written; the caller selects + refreshes. */
  onSubmit: (name: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(`tool_${Date.now().toString(36)}`);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    const trimmed = name.trim();
    if (!isValidToolName(trimmed)) {
      setError("Names start with a letter and may contain letters, digits, - and _ (up to 64 characters).");
      return;
    }
    if (existing.includes(trimmed)) {
      setError(`A tool named "${trimmed}" already exists — pick another name.`);
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
      <SectionHeader title="New tool" />
      <Field label="Name" hint="(the filename stem — ~/.config/bai/tools/<name>.ts)">
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
        Created from a starter template — the code is editable right after creating and hot-registers on save.
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
 * Main pane: the selected tool's Monaco code editor. Built-ins show an
 * override template (their real description + schema) — saving writes a
 * tool file that shadows the built-in until it is deleted, which restores
 * the built-in. Saving hot-registers; registration failures toast.
 */
export function ToolsPane({
  client,
  tools,
  selectedId,
  refresh,
  onNotice,
  themeColors,
}: {
  client: BaiClient;
  tools: ToolListEntry[];
  selectedId: string | null;
  refresh: () => Promise<void>;
  onNotice: OnNotice;
  themeColors: ThemeColors;
}) {
  const tool = tools.find((t) => t.name === selectedId);
  if (tool === undefined) {
    return (
      <div className="agents-pane">
        <p className="dim empty">Select or create a tool.</p>
      </div>
    );
  }
  return (
    <div className="agents-pane">
      <ToolForm key={tool.name} client={client} tool={tool} refresh={refresh} onNotice={onNotice} themeColors={themeColors} />
    </div>
  );
}

function ToolForm({
  client,
  tool,
  refresh,
  onNotice,
  themeColors,
}: {
  client: BaiClient;
  tool: ToolListEntry;
  refresh: () => Promise<void>;
  onNotice: OnNotice;
  themeColors: ThemeColors;
}) {
  const [code, setCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Monaco theme name — defined from the palette data (themes.ts), so a
  // theme switch re-skins the live editor with no CSS-read race (the
  // file-view pattern).
  const [monacoTheme, setMonacoTheme] = useState(() => defineBaiTheme(themeColors));
  useEffect(() => {
    setMonacoTheme(defineBaiTheme(themeColors));
  }, [themeColors]);

  // Fetch the current source: the tool file, or — for a built-in with no
  // override file yet — the generated override template (GET /api/tool/:name).
  useEffect(() => {
    void (async () => {
      try {
        setCode(await client.getToolCode(tool.name));
      } catch (err) {
        onNotice(err instanceof Error ? err.message : String(err), "error");
        setCode("");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tool.name keys the form instance
  }, [client, tool.name]);

  if (code === null) {
    return (
      <div className="agents-pane">
        <p className="dim">loading…</p>
      </div>
    );
  }

  const isBuiltin = tool.origin === "builtin";
  // A file-origin tool whose name belongs to a built-in: the file is an
  // override — deleting it restores the built-in, so the action reads
  // "reset to default" rather than "delete".
  const isBuiltinOverride = tool.builtin === true && !isBuiltin;

  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await client.putTool(tool.name, code);
      if (!result.registered) onNotice("saved, but the tool failed to register — check the code for errors", "error");
      else if (isBuiltin) onNotice(`saved "${tool.name}" — built-in overridden`);
      else onNotice(`saved "${tool.name}" — hot-registered`);
      await refresh();
    } catch (err) {
      onNotice(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    setBusy(true);
    try {
      await client.deleteTool(tool.name);
      await refresh();
      onNotice(isBuiltinOverride ? `reset "${tool.name}" to the built-in` : `deleted "${tool.name}"`);
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
            {tool.name} <span className="dim">({tool.origin})</span>
          </>
        }
      />
      {isBuiltin && (
        <p className="section-lede">
          Built-in tool — editing saves an override that replaces the built-in until the file is deleted (which restores it).
        </p>
      )}
      {isBuiltinOverride && (
        <p className="section-lede">
          This file overrides the built-in "{tool.name}" — "Reset to default" deletes it and restores the original.
        </p>
      )}
      <Field label="Code" hint={`(~/.config/bai/tools/${tool.name}.ts — hot-reloaded on save)`}>
        <div className="tool-editor">
          <Editor
            value={code}
            language="typescript"
            theme={monacoTheme}
            loading={<p className="dim empty">Loading editor…</p>}
            onChange={(value) => setCode(value ?? "")}
            options={{
              minimap: { enabled: false },
              fontSize: 13,
              lineNumbers: "on",
              scrollBeyondLastLine: false,
              automaticLayout: true,
              wordWrap: "on",
              stickyScroll: { enabled: false },
              contextmenu: false,
              padding: { top: 10, bottom: 10 },
            }}
          />
        </div>
      </Field>
      <div className="agents-actions">
        <Button type="submit" variant="primary" loading={busy}>
          Save
        </Button>
        {!isBuiltin && (
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => void remove()}
            title={isBuiltinOverride ? "Delete the override file — the original built-in registration is restored" : undefined}
          >
            {isBuiltinOverride ? "Reset to default" : "Delete"}
          </Button>
        )}
      </div>
    </form>
  );
}

/** Starter code for a new custom tool (mirrors core's toolTemplate). */
export function toolTemplateCode(name: string): string {
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
