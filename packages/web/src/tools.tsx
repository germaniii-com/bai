import { useEffect, useState } from "react";
import { Editor } from "@monaco-editor/react";
import type { BaiClient } from "@bai/api/client";
import { isToolOverride, isValidToolName, type ThemeColors, type ToolListEntry } from "@bai/shared";
import { defineBaiTheme } from "./monaco-setup";
import { EDITOR_FONT_FAMILY, useEditorFontSize } from "./editor-font";
import { OverrideWarning } from "./icons";
import { shouldAutoFocus } from "./pointer";
import { Wrench } from "lucide-react";
import { ActionRow, Banner, Button, ConfirmDialog, EmptyState, Field, FormSection, PageHeader, SubNav, SubNavCreate, SubNavItem, TextInput } from "./components";

/** Toast feedback callback — kind defaults to success (see toast.tsx). */
type OnNotice = (message: string, kind?: "success" | "error") => void;

/**
 * Tools section, split for the two-level nav: `ToolsNav` renders the nested
 * sidebar (create button + custom/built-in tools); the main pane is the
 * `ToolForm` code editor — for the selected tool, or a not-yet-written draft
 * in `creating` mode. Saving writes the file via the API — the loader
 * hot-imports it, no restart.
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
      <SubNavCreate
        icon={<Wrench size={15} aria-hidden="true" />}
        label="New tool"
        disabled={busy}
        onClick={onCreate}
      />
      {sorted.map((t) => (
        <SubNavItem
          key={t.name}
          title={t.name}
          subtitle={t.origin}
          trailing={isToolOverride(t) ? <OverrideWarning kind="tool" /> : undefined}
          selected={selected === t.name}
          onClick={() => onSelect(t.name)}
          ariaCurrent={selected === t.name ? "page" : undefined}
        />
      ))}
      {sorted.length === 0 && <p className="dim">No tools yet.</p>}
    </SubNav>
  );
}

/** A not-yet-written custom tool (the create-mode form's draft). */
function draftTool(): ToolListEntry {
  return {
    name: `tool_${Date.now().toString(36)}`,
    description: "What this tool does.",
    origin: "file",
    schema: {},
  };
}

/**
 * Main pane: the selected tool's Monaco code editor. Built-ins show an
 * override template (their real description + schema) — saving writes a
 * tool file that shadows the built-in until it is deleted, which restores
 * the built-in. Saving hot-registers; registration failures toast. In
 * `creating` mode it edits a draft name + starter code.
 */
export function ToolsPane({
  client,
  tools,
  selectedId,
  refresh,
  onNotice,
  themeColors,
  creating = false,
  onCreated,
  onCancel,
}: {
  client: BaiClient;
  tools: ToolListEntry[];
  selectedId: string | null;
  refresh: () => Promise<void>;
  onNotice: OnNotice;
  themeColors: ThemeColors;
  /** Render the full code form for a new tool (name editable). */
  creating?: boolean;
  /** Called with the new tool's name after a successful create. */
  onCreated?: (name: string) => void;
  /** Discard the draft (create mode). */
  onCancel?: () => void;
}) {
  if (creating) {
    return (
      <div className="pane-inner">
        <ToolForm
          key="__new_tool__"
          client={client}
          tool={draftTool()}
          refresh={refresh}
          onNotice={onNotice}
          themeColors={themeColors}
          creating
          existing={tools.map((t) => t.name)}
          {...(onCreated !== undefined ? { onCreated } : {})}
          {...(onCancel !== undefined ? { onCancel } : {})}
        />
      </div>
    );
  }
  const tool = tools.find((t) => t.name === selectedId);
  if (tool === undefined) {
    return (
      <div className="pane-inner">
        <EmptyState
          icon={<Wrench size={22} aria-hidden="true" />}
          title="No tool selected"
          description="Pick a tool from the list, or create a new one to get started."
        />
      </div>
    );
  }
  return (
    <div className="pane-inner">
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
  creating = false,
  existing = [],
  onCreated,
  onCancel,
}: {
  client: BaiClient;
  tool: ToolListEntry;
  refresh: () => Promise<void>;
  onNotice: OnNotice;
  themeColors: ThemeColors;
  creating?: boolean;
  existing?: string[];
  onCreated?: (name: string) => void;
  onCancel?: () => void;
}) {
  const [name, setName] = useState(tool.name);
  // Create mode seeds the starter template (no server file to fetch yet).
  const [code, setCode] = useState<string | null>(() => (creating ? toolTemplateCode(tool.name) : null));
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  // Monaco theme name — defined from the palette data (themes.ts), so a
  // theme switch re-skins the live editor with no CSS-read race (the
  // file-view pattern).
  const [monacoTheme, setMonacoTheme] = useState(() => defineBaiTheme(themeColors));
  const editorFontSize = useEditorFontSize();
  useEffect(() => {
    setMonacoTheme(defineBaiTheme(themeColors));
  }, [themeColors]);

  // Fetch the current source: the tool file, or — for a built-in with no
  // override file yet — the generated override template (GET /api/tool/:name).
  // Create mode has nothing to fetch.
  useEffect(() => {
    if (creating) return;
    void (async () => {
      try {
        setCode(await client.getToolCode(tool.name));
      } catch (err) {
        onNotice(err instanceof Error ? err.message : String(err), "error");
        setCode("");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tool.name keys the form instance
  }, [client, tool.name, creating]);

  if (code === null) {
    return (
      <div className="pane-inner">
        <p className="dim">loading…</p>
      </div>
    );
  }

  const isBuiltin = !creating && tool.origin === "builtin";
  // A file-origin tool whose name belongs to a built-in: the file is an
  // override — deleting it restores the built-in, so the action reads
  // "reset to default" rather than "delete".
  const isBuiltinOverride = tool.builtin === true && !isBuiltin;

  const save = async (): Promise<void> => {
    const trimmed = name.trim();
    if (creating) {
      if (!isValidToolName(trimmed)) {
        onNotice("Names start with a letter and may contain letters, digits, - and _ (up to 64 characters).", "error");
        return;
      }
      if (existing.includes(trimmed)) {
        onNotice(`A tool named "${trimmed}" already exists — pick another name.`, "error");
        return;
      }
    }
    setBusy(true);
    try {
      const target = creating ? trimmed : tool.name;
      const result = await client.putTool(target, code);
      if (!result.registered) onNotice("saved, but the tool failed to register — check the code for errors", "error");
      else if (creating) onNotice(`created "${target}" — hot-registered`);
      else if (isBuiltin) onNotice(`saved "${target}" — built-in overridden`);
      else onNotice(`saved "${target}" — hot-registered`);
      await refresh();
      if (creating) onCreated?.(target);
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
      <PageHeader
        title={creating ? "New tool" : tool.name}
        lede={
          isBuiltin
            ? "Built-in tool — editing saves an override that replaces the built-in until the file is deleted (which restores it)."
            : isBuiltinOverride
              ? `This file overrides the built-in "${tool.name}" — "Reset to default" deletes it and restores the original.`
              : creating
                ? undefined
                : `Source: ${tool.origin}`
        }
      />
      {isBuiltinOverride && (
        <Banner tone="warning" title="Built-in overridden">
          <strong>{tool.name}</strong> has been overridden — if it is not working properly, try resetting it
          to default. <OverrideWarning kind="tool" />
        </Banner>
      )}
      {creating && (
        <FormSection title="Identity" flow="stack">
          <Field label="Name" hint="(the filename stem — ~/.config/bai/tools/<name>.ts)">
            <TextInput
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus={shouldAutoFocus()}
              required
              maxLength={64}
              spellCheck={false}
            />
          </Field>
        </FormSection>
      )}
      <FormSection title="Source" flow="stack" className="field-grow">
        <Field
          label="Code"
          hint={`(~/.config/bai/tools/${creating ? name.trim() || tool.name : tool.name}.ts — hot-reloaded on save)`}
        >
          <div className="tool-editor">
            <Editor
              value={code}
              language="typescript"
              theme={monacoTheme}
              loading={<p className="dim empty">Loading editor…</p>}
              onChange={(value) => setCode(value ?? "")}
              options={{
                minimap: { enabled: false },
                fontFamily: EDITOR_FONT_FAMILY,
                fontSize: editorFontSize,
                fontLigatures: true,
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
      </FormSection>
      <ActionRow align="between">
        <div className="action-row-group">
          <Button type="submit" variant="primary" loading={busy}>
            {creating ? "Create" : "Save"}
          </Button>
        </div>
        <div className="action-row-group">
          {!creating && !isBuiltin && (
            <Button
              variant="danger"
              disabled={busy}
              onClick={() => setConfirmRemove(true)}
              title={isBuiltinOverride ? "Delete the override file — the original built-in registration is restored" : undefined}
            >
              {isBuiltinOverride ? "Reset to default" : "Delete"}
            </Button>
          )}
          {creating && onCancel !== undefined && (
            <Button variant="ghost" disabled={busy} onClick={onCancel}>
              Cancel
            </Button>
          )}
        </div>
      </ActionRow>
      <ConfirmDialog
        open={confirmRemove}
        title={isBuiltinOverride ? "Reset to default?" : "Delete tool?"}
        body={
          isBuiltinOverride ? (
            <>
              Delete the override file for <strong>{tool.name}</strong> and restore the built-in registration?
            </>
          ) : (
            <>
              Delete <strong>{tool.name}</strong>? Its file is removed and the change is live. This cannot be undone.
            </>
          )
        }
        confirmLabel={isBuiltinOverride ? "Reset" : "Delete"}
        busy={busy}
        onCancel={() => setConfirmRemove(false)}
        onConfirm={() => {
          setConfirmRemove(false);
          void remove();
        }}
      />
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
