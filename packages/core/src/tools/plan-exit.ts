import type { Tool, ToolContext, ToolResult } from "./registry";
import type { QuestionService } from "../question/service";

/**
 * plan.exit — the plan agent's finish line (opencode's plan_exit tool).
 * Asks the user whether to switch to the build agent; on approval the
 * session's agent flips to `build` via ctx.switchAgent and the CURRENT run
 * continues with build tools (opencode's mid-run switch).
 *
 * Auto-allowed like question/todo: the gate is the user answering the
 * embedded question, not a permission dialog.
 */
export function planExitTool(questions: QuestionService): Tool {
  return {
    name: "plan.exit",
    origin: "builtin",
    description:
      "Finish planning: ask the user whether to switch to the build agent and start implementing the plan. " +
      "Call this after the plan file is written. On approval the session switches to build immediately; " +
      "on decline, continue refining the plan.",
    schema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "One-line summary of the plan for the confirmation prompt" },
      },
      required: [],
    },
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const { summary } = args as { summary?: string };
      if (ctx.switchAgent === undefined) {
        throw new Error("plan.exit is unavailable in this context (no agent switch support).");
      }
      const answers = await questions.ask({
        sessionId: ctx.sessionId,
        signal: ctx.signal,
        questions: [
          {
            question: summary !== undefined && summary.length > 0
              ? `The plan is ready: ${summary} — switch to the build agent and start implementing?`
              : "The plan is ready — switch to the build agent and start implementing?",
            header: "Plan complete",
            options: [
              { label: "Yes (Recommended)", description: "Switch to the build agent and implement the plan now" },
              { label: "No", description: "Stay in planning — keep refining the plan" },
            ],
          },
        ],
      });
      const answer = answers[0]?.[0] ?? "";
      if (answer.startsWith("Yes")) {
        const switched = await ctx.switchAgent("build");
        if (!switched) {
          throw new Error("Could not switch to the build agent (agent missing or session gone).");
        }
        return {
          content:
            "The user approved. The session has switched to the build agent — you can now use its full tool set " +
            "to implement the plan, starting with the first step.",
          meta: { switchedTo: "build", title: "Switched to build agent" },
        };
      }
      return {
        content: "The user declined the switch. Stay in planning mode and keep refining the plan based on their feedback.",
        meta: { switchedTo: undefined, title: "Stayed in plan mode" },
      };
    },
  };
}
