import { isValidAgentName, type PlanFile, type SessionId } from "@bai/shared";
import type { Tool, ToolContext, ToolResult } from "./registry";

/**
 * plan.read — read a plan stored on the current session (the Plans panel), or
 * list the session's plans when no name is given. `plan.write` is the write
 * half (the plan agent's tool); this read half lets any agent consult a plan
 * the user wrote or edited — notably the "build this plan" flow, where the
 * build agent reads the plan and executes it. The session id comes from the
 * tool context, so there is no path argument and no escape surface.
 */
export function planReadTool(deps: {
  listPlans: (sessionId: SessionId) => PlanFile[];
  readPlan: (sessionId: SessionId, name: string) => string | undefined;
}): Tool {
  return {
    name: "plan.read",
    origin: "builtin",
    description:
      "Read a plan stored on the current session (shown in the session's Plans panel). Pass `name` to read that " +
      "plan's markdown; omit it to list the session's plan names first. Use this to implement or review a plan the " +
      "user wrote or edited before starting work.",
    schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Plan name to read (from the list); omit to list available plans" },
      },
      required: [],
    },
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const sessionId = ctx.sessionId as SessionId;
      const { name } = (args ?? {}) as { name?: unknown };

      if (name === undefined) {
        const plans = deps.listPlans(sessionId);
        return {
          content:
            plans.length === 0
              ? "This session has no plans yet."
              : `Plans on this session (${plans.length}): ${plans.map((p) => p.name).join(", ")}. ` +
                "Call plan.read with a name to read one.",
          meta: { plans, title: "List session plans" },
        };
      }
      if (typeof name !== "string" || !isValidAgentName(name)) {
        throw new Error("name must be a plan name (start with a letter; letters, digits, '-' and '_').");
      }
      const content = deps.readPlan(sessionId, name);
      if (content === undefined) {
        const available = deps.listPlans(sessionId).map((p) => p.name);
        throw new Error(
          `Unknown plan: ${name}${available.length > 0 ? ` (available: ${available.join(", ")})` : ""}.`,
        );
      }
      return { content, meta: { name, title: `Read plan ${name}` } };
    },
  };
}
