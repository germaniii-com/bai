import { Box, Text, useInput } from "ink";
import { useCallback, useEffect, useState } from "react";
import { spawnSync } from "node:child_process";
import type { BaiClient } from "@bai/api/client";
import type { AgentInfo, Session, ToolListEntry } from "@bai/shared";
import { listWindow } from "../components/dialog";
import { useTheme } from "../theme";

/** List rows shown around the cursor (SelectDialog parity). */
const WINDOW = 12;

type Tab = "agents" | "tools";

/**
 * Agent & tool switcher/manager (ctrl+a): list, create, edit ($EDITOR),
 * delete, and apply. Enter (or u) applies the highlighted agent — to the
 * active session when one is open, otherwise as the config default agent
 * (`agents.default`, what sessions without a selection resolve). All
 * mutations write files/config through the API — the server hot-reloads
 * them, so a save in $EDITOR is live everywhere immediately.
 * `catalogTick` bumps whenever agents.updated/tools.updated arrive on the
 * firehose, keeping the list fresh while the dialog is open.
 */
export function AgentManager({
  client,
  active,
  defaultAgent,
  catalogTick,
  onDone,
}: {
  client: BaiClient;
  active: Session | null;
  /** Current config default agent (agents.default), when set. */
  defaultAgent?: string;
  catalogTick: number;
  onDone: () => void;
}) {
  const [tab, setTab] = useState<Tab>("agents");
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [tools, setTools] = useState<ToolListEntry[]>([]);
  const [index, setIndex] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const t = useTheme();

  const refresh = useCallback(async () => {
    try {
      setAgents(await client.listAgents());
      setTools(await client.listTools());
      setNotice(null);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh, catalogTick]);

  const items = tab === "agents" ? agents : tools;

  // Keep the cursor in bounds as the list changes.
  useEffect(() => {
    setIndex((i) => Math.min(i, Math.max(0, items.length - 1)));
  }, [items.length]);

  const openEditor = useCallback((path: string | undefined) => {
    if (path === undefined) return;
    const editor = process.env.EDITOR ?? process.env.VISUAL ?? "vi";
    // Inherit stdio so the editor owns the terminal; the watcher reloads on save.
    const result = spawnSync(editor, [path], { stdio: "inherit" });
    if (result.status !== 0) setNotice(`editor exited with ${result.status ?? "signal"}`);
  }, []);

  const createItem = useCallback(async () => {
    if (tab === "agents") {
      const name = `agent-${Date.now().toString(36)}`;
      try {
        await client.putAgent(name, {
          description: "What this agent is for.",
          prompt: `You are ${name}, an agent inside bai.\n\nDescribe the agent's role, tone, and workflow here. The body is the system prompt.`,
          tools: ["fs.read", "fs.list"],
        });
        const created = await client.getAgent(name);
        openEditor(created?.path);
        void refresh();
      } catch (err) {
        setNotice(err instanceof Error ? err.message : String(err));
      }
    } else {
      const name = `tool_${Date.now().toString(36)}`;
      try {
        const result = await client.putTool(name, toolTemplateCode(name));
        if (!result.registered) setNotice("file written, but the tool failed to register (check the code)");
        const list = await client.listTools();
        openEditor(list.find((t) => t.name === name)?.path);
        void refresh();
      } catch (err) {
        setNotice(err instanceof Error ? err.message : String(err));
      }
    }
  }, [tab, client, openEditor, refresh]);

  const editItem = useCallback(
    (name: string) => {
      const path = tab === "agents" ? agents.find((a) => a.name === name)?.path : tools.find((t) => t.name === name)?.path;
      if (path === undefined) {
        setNotice(tab === "agents" ? "built-in agents have no file — create a new one instead" : "built-in tools have no file — create a new one instead");
        return;
      }
      openEditor(path);
      void refresh();
    },
    [tab, agents, tools, openEditor, refresh],
  );

  const deleteItem = useCallback(
    async (name: string) => {
      try {
        if (tab === "agents") await client.deleteAgent(name);
        else await client.deleteTool(name);
        setNotice(null);
        void refresh();
      } catch (err) {
        setNotice(err instanceof Error ? err.message : String(err));
      }
    },
    [tab, client, refresh],
  );

  /**
   * Apply the highlighted agent: per-session when a session is open,
   * otherwise the config default (sessions without a selection resolve it).
   * Resolves true when the apply succeeded (enter closes on success).
   */
  const applyAgent = useCallback(
    async (name: string): Promise<boolean> => {
      try {
        if (active === null) {
          if (defaultAgent === name) {
            setNotice(`"${name}" is already the default agent`);
            return true;
          }
          await client.putConfig({ agents: { default: name } });
          setNotice(`default agent set to "${name}" (sessions without a selection use it)`);
        } else {
          await client.setSessionAgent(active.id, { agent: name });
          setNotice(`session uses "${name}" (applies next prompt)`);
        }
        return true;
      } catch (err) {
        setNotice(err instanceof Error ? err.message : String(err));
        return false;
      }
    },
    [active, client, defaultAgent],
  );

  useInput((ch, key) => {
    if (confirmDelete !== null) {
      if (ch === "y") {
        const name = confirmDelete;
        setConfirmDelete(null);
        void deleteItem(name);
      } else if (ch === "n" || key.escape) {
        setConfirmDelete(null);
      }
      return;
    }
    if (key.escape || (key.ctrl && ch === "a")) {
      onDone();
      return;
    }
    if (ch === "t") {
      setTab((prev) => (prev === "agents" ? "tools" : "agents"));
      setIndex(0);
      setNotice(null);
      return;
    }
    if (key.upArrow || ch === "k") setIndex((i) => Math.max(0, i - 1));
    else if (key.downArrow || ch === "j") setIndex((i) => Math.min(items.length - 1, i + 1));
    else if (ch === "n") void createItem();
    else if (ch === "e" && items[index] !== undefined) editItem(items[index].name);
    else if (ch === "d" && items[index] !== undefined) {
      if (tab === "agents" && items[index]?.name === "build") setNotice("the build agent is built-in");
      else setConfirmDelete(items[index]?.name ?? null);
    } else if (tab === "agents" && items[index] !== undefined) {
      // Apply the highlighted agent: u stays in the dialog, enter closes.
      const name = items[index]?.name ?? "";
      if (ch === "u") void applyAgent(name);
      else if (key.return) void applyAgent(name).then((ok) => ok && onDone());
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>
        agents &amp; tools <Text color={t.dim}>({tab === "agents" ? "agents" : "tools"} · t to switch · esc close)</Text>
      </Text>
      {/* Sliding window around the cursor — long agent/tool lists scroll
          instead of overflowing the terminal. */}
      {(() => {
        const { start, end } = listWindow(index, items.length, WINDOW);
        const windowed = items.slice(start, end);
        return (
          <>
            {start > 0 && <Text color={t.dim}>  ↑ {start} more</Text>}
            {windowed.map((item, i) => {
              const absolute = start + i;
              if (tab === "agents") {
                const a = item as AgentInfo;
                const sessionAgent =
                  active !== null ? (active.meta as Record<string, unknown>).agent : undefined;
                const marks: string[] = [];
                if (sessionAgent === a.name) marks.push("session");
                if (defaultAgent === a.name) marks.push("default");
                return (
                  <Text key={a.name} color={absolute === index ? t.accent : t.text}>
                    {absolute === index ? "❯ " : "  "}
                    {a.name} <Text color={t.dim}>({a.source}{a.tools.length > 0 ? ` · ${a.tools.join(", ")}` : " · no tools"})</Text>
                    {marks.length > 0 && <Text color={t.success}> · {marks.join(" · ")}</Text>}
                  </Text>
                );
              }
              const tool = item as ToolListEntry;
              return (
                <Text key={tool.name} color={absolute === index ? t.accent : t.text}>
                  {absolute === index ? "❯ " : "  "}
                  {tool.name} <Text color={t.dim}>({tool.origin})</Text>
                </Text>
              );
            })}
            {end < items.length && (
              <Text color={t.dim}>  ↓ {items.length - end} more</Text>
            )}
          </>
        );
      })()}
      {items.length === 0 && <Text color={t.dim}>  (empty — n to create)</Text>}
      <Text color={t.dim}> </Text>
      <Text color={t.dim}>
        n new · e edit ($EDITOR) · d delete ·{" "}
        {tab === "agents"
          ? `enter/u ${active !== null ? "use in session" : "set as default"} · `
          : ""}j/k move · t tab · esc close
      </Text>
      {confirmDelete !== null && <Text color={t.warning}>delete "{confirmDelete}"? y/n</Text>}
      {notice !== null && <Text color={t.warning}>{notice}</Text>}
    </Box>
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
