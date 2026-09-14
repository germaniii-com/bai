import { isValidAgentName, type PlanFile, type SessionId } from "@bai/shared";
import type { Tool, ToolContext, ToolResult } from "./registry";

/**
 * plan.write — the plan agent's only write tool (opencode's plan-agent path
 * restriction, realized as a tool instead of permission rules: bai's engine
 * matches tool names, and a session-scoped write is stricter than any rule).
 * Content lands under the SESSION's plans directory
 * (`<dataDir>/sessions/<sessionId>/plans/<name>.md`) and nowhere else — the
 * path is derived from `ctx.sessionId` and every component is validated
 * before disk is touched, so a plan can never escape its session.
 *
 * The write goes through the injected `writePlan`, which also emits the
 * durable `plans.updated` event, so the session's Plans panel updates live.
 */
export function planWriteTool(deps: {
  writePlan: (sessionId: SessionId, name: string, content: string) => PlanFile;
}): Tool {
  return {
    name: "plan.write",
    origin: "builtin",
    description:
      "Write a plan for the current session. The plan is stored as a markdown file on the session " +
      "(shown in the session's Plans panel) under the name you choose. Use markdown: a one-paragraph " +
      "overview, then numbered phases with concrete steps, touched files, and verification. Replaces " +
      "the plan if the name already exists.",
    schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Plan name without extension (letters/digits/-/_), e.g. 'refactor-db'" },
        content: { type: "string", description: "Full markdown content of the plan" },
      },
      required: ["name", "content"],
    },
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const { name, content } = args as { name?: string; content?: string };
      if (typeof name !== "string" || !isValidAgentName(name)) {
        throw new Error("name must start with a letter and contain only letters, digits, '-' and '_' (max 64 chars).");
      }
      if (typeof content !== "string" || content.trim().length === 0) {
        throw new Error("content must be non-empty markdown.");
      }
      const plan = deps.writePlan(ctx.sessionId as SessionId, name, content);
      return {
        content: `Saved plan "${name}" (${plan.bytes} bytes) — visible in the session's Plans panel.`,
        meta: { name, bytes: plan.bytes, path: `sessions/${ctx.sessionId}/plans/${name}.md` },
      };
    },
  };
}
