import { useEffect, useState } from "react";
import type { BaiClient } from "@bai/api/client";
import { isValidToolName, type ToolListEntry } from "@bai/shared";

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
    <div className="settings-nav">
      <button type="button" className="new-session" disabled={busy} onClick={onCreate}>
        + new tool
      </button>
      {sorted.map((t) => (
        <button
          key={t.name}
          type="button"
          className={selected === t.name ? "provider-item active" : "provider-item"}
          onClick={() => onSelect(t.name)}
        >
          <span className="title">{t.name}</span>
          <span className="dim">{t.origin}</span>
        </button>
      ))}
      {sorted.length === 0 && <p className="dim">No tools yet.</p>}
    </div>
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
      <h3>New tool</h3>
      <label>
        name <span className="dim">(the filename stem — ~/.config/bai/tools/&lt;name&gt;.ts)</span>
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
        Created from a starter template — the code is editable right after creating and hot-registers on save.
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
 * Main pane: the selected tool's code editor (built-ins are view-only —
 * they have no editable source). Saving rewrites the tool file; the loader
 * hot-registers it and reports registration failures as a notice.
 */
export function ToolsPane({
  client,
  tools,
  selectedId,
  refresh,
  onNotice,
}: {
  client: BaiClient;
  tools: ToolListEntry[];
  selectedId: string | null;
  refresh: () => Promise<void>;
  onNotice: (message: string) => void;
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
      <ToolForm key={tool.name} client={client} tool={tool} refresh={refresh} onNotice={onNotice} />
    </div>
  );
}

function ToolForm({
  client,
  tool,
  refresh,
  onNotice,
}: {
  client: BaiClient;
  tool: ToolListEntry;
  refresh: () => Promise<void>;
  onNotice: (message: string) => void;
}) {
  const [code, setCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Fetch the current file content (GET /api/tool/:name; 404 for built-ins).
  useEffect(() => {
    void (async () => {
      try {
        setCode(await client.getToolCode(tool.name));
      } catch (err) {
        onNotice(err instanceof Error ? err.message : String(err));
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

  const editable = tool.origin === "file";

  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await client.putTool(tool.name, code);
      if (!result.registered) onNotice("saved, but the tool failed to register — check the code for errors");
      else onNotice(`saved "${tool.name}" — hot-registered`);
      await refresh();
    } catch (err) {
      onNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    setBusy(true);
    try {
      await client.deleteTool(tool.name);
      await refresh();
      onNotice(`deleted "${tool.name}"`);
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
        {tool.name} <span className="dim">({tool.origin})</span>
      </h3>
      {!editable && <p className="dim">Built-in tool — its source lives in bai itself. Create a new tool to customize behavior.</p>}
      <label>
        code <span className="dim">(~/.config/bai/tools/{tool.name}.ts — hot-reloaded on save)</span>
        <textarea
          className="code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          rows={22}
          spellCheck={false}
          readOnly={!editable}
        />
      </label>
      <div className="agents-actions">
        {editable && (
          <button type="submit" disabled={busy}>
            save
          </button>
        )}
        {editable && (
          <button type="button" className="danger" disabled={busy} onClick={() => void remove()}>
            delete
          </button>
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
