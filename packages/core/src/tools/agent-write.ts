import { isValidAgentName, type PutAgentBody } from "@bai/shared";
import type { AgentRegistry } from "../agent/registry";
import { serializeAgentMarkdown } from "../agent/registry";
import type { Tool, ToolContext, ToolResult } from "./registry";

/**
 * Agent authoring tools — the write side of the agent catalog (the chat
 * orchestrator's "create/edit an agent" capability). Same stance as the
 * skill authoring tools: root-restricted to the agents directory by
 * construction (AgentRegistry.put writes ~/.config/bai/agents/<name>.md,
 * atomic tmp+rename), hot-reloaded, and broadcast live so every surface —
 * and the task tool's embedded catalog — picks the change up immediately.
 *
 * agent.view returns the agent's full markdown definition (frontmatter +
 * prompt body) — the read-before-edit half. agent.save creates or REPLACES
 * a file agent's definition; built-in agents (build/chat/plan/learn) are
 * registry-protected and rejected with the registry's own error. There is
 * deliberately no agent.delete — deletion stays a surface/API action.
 */

/** String-list sanitizer shared by the tools/skills fields (trim, drop empties, cap). */
function stringList(value: unknown, cap: number, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${field} must be an array of tool/skill names.`);
  const list = value
    .filter((t): t is string => typeof t === "string" && t.trim().length > 0)
    .map((t) => t.trim());
  if (list.length > cap) throw new Error(`${field} accepts at most ${cap} entries.`);
  return list;
}

export function agentViewTool(deps: { agents: AgentRegistry }): Tool {
  return {
    name: "agent.view",
    origin: "builtin",
    description:
      "Read one agent's full definition — frontmatter (description, model, tools, skills) plus the prompt body, " +
      "returned as the markdown source that defines it. Read BEFORE agent.save when editing: copy the fields you " +
      "want to keep, change the ones you don't (agent.save replaces the whole definition).",
    schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Agent name (filename stem), e.g. \"reviewer\" or \"chat\"" },
      },
      required: ["name"],
    },
    async execute(args: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const { name } = args as { name?: unknown };
      if (typeof name !== "string" || name.trim().length === 0) {
        throw new Error("name must be an agent name (e.g. \"reviewer\"). List agents via the task tool's catalog.");
      }
      const agent = deps.agents.get(name.trim());
      if (agent === undefined) {
        throw new Error(`Unknown agent: ${name.trim()}.`);
      }
      const markdown = serializeAgentMarkdown({
        ...(agent.description !== undefined ? { description: agent.description } : {}),
        ...(agent.model !== undefined ? { model: agent.model } : {}),
        tools: agent.tools,
        ...(agent.skills !== undefined ? { skills: agent.skills } : {}),
        prompt: agent.prompt,
      });
      const header =
        `Agent "${agent.name}" (${agent.source}${agent.path !== undefined ? ` — ${agent.path}` : ""})\n` +
        (agent.description !== undefined ? `Description: ${agent.description}\n` : "") +
        `Tools: ${agent.tools.length > 0 ? agent.tools.join(", ") : "(none)"}\n` +
        (agent.skills !== undefined ? `Skills: ${agent.skills.join(", ")}\n` : "") +
        (agent.model !== undefined ? `Model: ${agent.model}\n` : "") +
        `\nMarkdown source (agent.save replaces the WHOLE definition — keep the fields you want):\n\n`;
      return {
        content: header + markdown,
        meta: { agent: agent.name, title: `Viewed agent: ${agent.name}` },
      };
    },
  };
}

export function agentSaveTool(deps: { agents: AgentRegistry }): Tool {
  return {
    name: "agent.save",
    origin: "builtin",
    description:
      "Create or replace an agent (writes ~/.config/bai/agents/<name>.md — live immediately, no restart; it appears " +
      "in every surface's picker and the task tool's catalog). Check existing agents first (agent.view) — extend a " +
      "matching one instead of minting a near-duplicate. agent.save replaces the WHOLE definition: when editing, " +
      "view first and include every field you want to keep. Built-in agents (build, chat, plan, learn) cannot be " +
      "overwritten. The prompt body is the agent's system prompt; tools is its allow-list (a single \"*\" entry = " +
      "every registered tool; empty = pure persona, no tools).",
    schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Agent name (filename stem): starts with a letter, then letters/digits/-/_ (max 64)" },
        description: { type: "string", description: "ONE sentence — what the agent is for; shown in pickers and the task catalog" },
        prompt: { type: "string", description: "Full markdown body — the agent's system prompt" },
        tools: { type: "array", items: { type: "string" }, description: "Tool allow-list (registry names, e.g. [\"fs.read\",\"bash\"]); [\"*\"] = every tool; omit = no tools" },
        skills: { type: "array", items: { type: "string" }, description: "Optional skill whitelist for skills.view; omit = every skill" },
        model: { type: "string", description: "Optional catalog model id, e.g. \"anthropic/claude-sonnet-4-5\"" },
      },
      required: ["name", "prompt"],
    },
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const { name, description, prompt, tools, skills, model } = args as {
        name?: unknown;
        description?: unknown;
        prompt?: unknown;
        tools?: unknown;
        skills?: unknown;
        model?: unknown;
      };
      if (typeof name !== "string" || !isValidAgentName(name.trim())) {
        throw new Error("name must start with a letter and contain only letters, digits, '-' and '_' (max 64 chars).");
      }
      const clean = name.trim();
      if (typeof prompt !== "string" || prompt.trim().length === 0) {
        throw new Error("prompt must be non-empty markdown (the agent's system prompt).");
      }
      if (prompt.length > 100_000) {
        throw new Error(`prompt is too large (${prompt.length} chars; max 100,000).`);
      }
      if (description !== undefined && (typeof description !== "string" || description.trim().length === 0)) {
        throw new Error("description must be a non-empty sentence (or omit it).");
      }
      if (model !== undefined && (typeof model !== "string" || model.trim().length === 0)) {
        throw new Error("model must be a catalog model id (or omit it).");
      }
      const toolList = stringList(tools, 50, "tools");
      const skillList = stringList(skills, 200, "skills");
      const body: PutAgentBody = {
        prompt: prompt.trim(),
        ...(description !== undefined && description.trim().length > 0 ? { description: description.trim() } : {}),
        ...(typeof model === "string" && model.trim().length > 0 ? { model: model.trim() } : {}),
        ...(toolList !== undefined && toolList.length > 0 ? { tools: toolList } : { tools: [] }),
        ...(skillList !== undefined && skillList.length > 0 ? { skills: skillList } : {}),
      };
      // put() validates the name again, rejects built-ins ("built-in and
      // cannot be overwritten"), writes atomically, rescans, and fires the
      // registry onChange (bus broadcast). The emitLive mirrors the API
      // route — web firehose surfaces refetch on it.
      const saved = deps.agents.put(clean, body);
      ctx.emitLive("agents.updated", {});
      const where = saved.path !== undefined ? ` at ${saved.path}` : "";
      return {
        content:
          `Saved agent "${saved.name}"${where}.\n` +
          `Tools: ${saved.tools.length > 0 ? saved.tools.join(", ") : "(none)"}\n` +
          `It is live: pickers and the task tool's catalog pick it up on the next turn.`,
        meta: { agent: saved.name, path: saved.path, title: `Saved agent: ${saved.name}` },
      };
    },
  };
}
