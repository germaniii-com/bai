import type { Tool, ToolContext, ToolResult } from "./registry";
import type { QuestionService } from "../question/service";

/**
 * question — ask the user one or more multiple-choice questions mid-run
 * (opencode's question tool). The run blocks until the user answers on any
 * surface (first reply wins) or dismisses; a dismissal surfaces as an error
 * tool result ("The user dismissed this question"), mirroring opencode's
 * QuestionRejectedError.
 *
 * The service is injected at registration (Service constructor) so the tool
 * stays a pure schema + execute pair, like the fs tools' roots injection.
 */
export function questionTool(questions: QuestionService): Tool {
  return {
    name: "question",
    origin: "builtin",
    description:
      "Ask the user one or more questions during execution — gather preferences, clarify ambiguous instructions, " +
      "get decisions on implementation choices, or offer a choice of direction. " +
      "Answers come back as arrays of selected labels (one row per question, in order). " +
      "If you recommend an option, put it first and add \"(Recommended)\" to its label. " +
      "Don't add catch-all \"Other\" options — a custom free-text answer is always available. " +
      "The run pauses until the user responds; use it sparingly for decisions that matter.",
    schema: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          description: "Questions to ask (1-5 per call)",
          minItems: 1,
          maxItems: 5,
          items: {
            type: "object",
            properties: {
              question: { type: "string", description: "Complete question" },
              header: { type: "string", description: "Very short label (max 30 chars)" },
              options: {
                type: "array",
                description: "Available choices (1-8)",
                minItems: 1,
                maxItems: 8,
                items: {
                  type: "object",
                  properties: {
                    label: { type: "string", description: "Display text (1-5 words, concise)" },
                    description: { type: "string", description: "Explanation of the choice" },
                  },
                  required: ["label", "description"],
                },
              },
              multiple: { type: "boolean", description: "Allow selecting multiple choices (default false)" },
            },
            required: ["question", "header", "options"],
          },
        },
      },
      required: ["questions"],
    },
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const { questions: prompts } = args as { questions: Parameters<QuestionService["ask"]>[0]["questions"] };
      if (!Array.isArray(prompts) || prompts.length === 0) {
        throw new Error("questions must be a non-empty array");
      }
      const answers = await questions.ask({
        sessionId: ctx.sessionId,
        questions: prompts,
        signal: ctx.signal,
      });
      const formatted = prompts
        .map((q, i) => {
          const answer = answers[i];
          return `"${q.question}"="${answer !== undefined && answer.length > 0 ? answer.join(", ") : "Unanswered"}"`;
        })
        .join(", ");
      return {
        content: `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`,
        meta: { answers, count: prompts.length, title: `Asked ${prompts.length} question${prompts.length === 1 ? "" : "s"}` },
      };
    },
  };
}
