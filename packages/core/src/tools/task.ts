import type { AgentInfo, Config, Message, Session, SessionId } from "@bai/shared";
import type { AgentRegistry } from "../agent/registry";
import type { Tool, ToolContext, ToolResult } from "./registry";

/**
 * task — spawn a subagent: a real, durable child session running the chosen
 * agent to completion (opencode's session-per-subagent model). The child is
 * fully event-sourced and inspectable from any surface; the parent's tool
 * result is the child's final assistant text wrapped in `<task>` XML.
 *
 * Guards (opencode parity, adapted to bai's permission model):
 * - Depth: the caller's meta.parent ancestry is capped by config
 *   `agents.subagentDepth` (default 1 — subagents can't spawn subagents).
 * - Strips: child sessions are never offered or allowed `task`, `question`,
 *   or `plan.exit` (no recursion, no mid-run user questions — children run
 *   autonomously; enforced in run.ts's toolDefsFor + executeCalls).
 * - Permission: `task` itself is unmatched → "ask" (fail-closed); a spawn
 *   dialog carries the description + agent via ask-detail.
 * - Model: the subagent's own `model` wins; otherwise the parent's explicit
 *   per-session model is copied down (resolveRunContext precedence:
 *   meta.model → agent.model → global default).
 */

export interface TaskToolDeps {
  agents: AgentRegistry;
  config(): Config;
  getSession(id: SessionId): Session | undefined;
  createSession(opts: {
    title?: string;
    workbench?: Session["workbench"];
    cwd?: string;
    parent?: SessionId;
    agent?: string;
    model?: string;
  }): Session;
  submitPrompt(sessionId: SessionId, payload: { text: string }): unknown;
  drainNow(sessionId: SessionId): Promise<void>;
  interrupt(sessionId: SessionId): void;
  history(sessionId: SessionId): Message[];
}

/** The static, agent-independent guidance (opencode's task.txt, adapted). */
const TASK_GUIDANCE = `Launch a new agent (a "subagent") to handle complex, multistep tasks autonomously in its own session. The subagent runs the selected agent persona with its own tool allow-list, context window, and step budget.

When using the task tool, you must specify subagent_type to select which agent runs, plus a short description and a detailed prompt.

When NOT to use the task tool:
- If you want to read a specific file path, use fs.read or fs.glob directly — faster.
- If you are searching for a specific class definition like "class Foo", use fs.grep directly.
- If you are searching code within a specific file or set of 2-3 files, use fs.read directly.
- If no available agent is a good fit for the task, do the work yourself with your own tools.

Usage notes:
1. Multiple task calls in a single message run concurrently — launch independent subagents together to maximize throughput.
2. Once you have delegated work to a subagent, do not duplicate that work yourself. Continue with non-overlapping work, or wait for the result.
3. When the subagent is done, it returns a single final message to you. The result returned by the subagent is not visible to the user — summarize it in your own response. The output includes the subagent's session id.
4. Each invocation starts with a fresh context. Your prompt should contain a highly detailed task description for the subagent to perform autonomously, and you should specify exactly what information it should return back to you in its final and only message to you.
5. The subagent's outputs should generally be trusted.
6. Clearly tell the subagent whether you expect it to write code or just do research (search, file reads, web fetches, etc.), since it is not aware of the user's intent. Tell it how to verify its work if possible (e.g. relevant test commands).
7. Subagents cannot spawn their own subagents, cannot ask the user questions, and cannot use plan.exit — they run autonomously and return one final message.`;

/** Build the task tool description: guidance + the current agent catalog. */
export function taskDescription(agents: AgentRegistry): string {
  const list = agents
    .list()
    .map((a) => `- ${a.name}: ${a.description ?? "(no description)"}`)
    .join("\n");
  return `${TASK_GUIDANCE}\n\nAvailable agent types (subagent_type):\n${list}`;
}

/** Wrap the child result in the opencode-style task envelope. */
export function renderTaskOutput(sessionId: string, state: "completed" | "error", text: string): string {
  const tag = state === "error" ? "task_error" : "task_result";
  return [`<task id="${sessionId}" state="${state}">`, `<${tag}>`, text, `</${tag}>`, "</task>"].join("\n");
}

/** The last non-empty assistant text in a session's history (the child's answer). */
export function finalAssistantText(history: Message[]): string | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i];
    if (message?.role !== "assistant") continue;
    for (let j = message.parts.length - 1; j >= 0; j--) {
      const part = message.parts[j];
      if (part?.kind !== "text") continue;
      const text = (part.payload as { text?: string }).text ?? "";
      if (text.trim().length > 0) return text;
    }
  }
  return undefined;
}

/** How deep the calling session already is (0 = root; walks meta.parent). */
function subagentDepthOf(sessionId: SessionId, deps: TaskToolDeps): number {
  let depth = 0;
  let current = deps.getSession(sessionId);
  while (current !== undefined) {
    const parent = current.meta.parent;
    if (typeof parent !== "string" || parent.length === 0) break;
    depth++;
    current = deps.getSession(parent as SessionId);
  }
  return depth;
}

export function taskTool(deps: TaskToolDeps, description: string): Tool {
  return {
    name: "task",
    origin: "builtin",
    description,
    schema: {
      type: "object",
      properties: {
        description: { type: "string", description: "A short (3-5 words) description of the task" },
        prompt: { type: "string", description: "The detailed task for the agent to perform autonomously" },
        subagent_type: { type: "string", description: "The agent to run for this task" },
      },
      required: ["description", "prompt", "subagent_type"],
    },
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const { description: desc, prompt, subagent_type: subagentType } = args as {
        description?: string;
        prompt?: string;
        subagent_type?: string;
      };
      if (typeof desc !== "string" || desc.trim().length === 0) throw new Error("description is required");
      if (typeof prompt !== "string" || prompt.trim().length === 0) throw new Error("prompt is required");
      if (typeof subagentType !== "string" || subagentType.trim().length === 0) throw new Error("subagent_type is required");

      const maxDepth = deps.config().agents?.subagentDepth ?? 1;
      const depth = subagentDepthOf(ctx.sessionId, deps);
      if (depth >= maxDepth) {
        throw new Error(
          `Subagent depth limit reached (${maxDepth}). Increase "agents.subagentDepth" in config to allow nested subagents.`,
        );
      }

      const agent: AgentInfo | undefined = deps.agents.get(subagentType);
      if (agent === undefined) {
        throw new Error(
          `Unknown agent type: ${subagentType} is not a valid agent type. Available agents: ${deps.agents.list().map((a) => a.name).join(", ")}.`,
        );
      }

      const parent = deps.getSession(ctx.sessionId);
      if (parent === undefined) throw new Error("Parent session no longer exists");

      // Model rule: the subagent's own override wins; otherwise copy the
      // parent's explicit per-session model down (resolveRunContext reads
      // meta.model before agent.model, so an unconditional copy would
      // override the subagent's choice).
      const parentMeta = parent.meta as { model?: unknown };
      const inheritModel =
        agent.model === undefined && typeof parentMeta.model === "string" && parentMeta.model.length > 0
          ? parentMeta.model
          : undefined;

      const child = deps.createSession({
        title: `${desc.trim()} (@${agent.name} subagent)`,
        workbench: parent.workbench,
        ...(parent.cwd !== undefined ? { cwd: parent.cwd } : {}),
        parent: ctx.sessionId,
        agent: agent.name,
        ...(inheritModel !== undefined ? { model: inheritModel } : {}),
      });

      // Parent interrupt ⇒ child interrupt (mirrors bash's kill-on-abort).
      const onAbort = () => deps.interrupt(child.id);
      if (ctx.signal.aborted) onAbort();
      else ctx.signal.addEventListener("abort", onAbort, { once: true });

      try {
        deps.submitPrompt(child.id, { text: prompt });
        await deps.drainNow(child.id);
      } finally {
        ctx.signal.removeEventListener("abort", onAbort);
      }

      const title = `${desc.trim()} (@${agent.name} subagent)`;
      const text = finalAssistantText(deps.history(child.id));
      const meta = { title, subagent: { sessionId: child.id, agent: agent.name } };
      if (text === undefined) {
        return {
          content: renderTaskOutput(child.id, "error", `Subagent "${agent.name}" produced no final answer.`),
          meta,
        };
      }
      return { content: renderTaskOutput(child.id, "completed", text), meta };
    },
  };
}
