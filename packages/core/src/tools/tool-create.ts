import type { Tool, ToolContext, ToolResult } from "./registry";

/**
 * tool.create — the orchestrator's "create a tool" capability: write a
 * custom tool file (~/.config/bai/tools/<name>.ts) that hot-registers via
 * the ToolLoader (same path as the web Tools section and PUT /api/tool).
 * The write goes through Service.putTool — atomic tmp+rename, name
 * validation (a dotted name is accepted only when it shadows a registered
 * built-in), loader rescan — so the tool is callable immediately.
 *
 * Permission stance: ASK (deliberately absent from DEFAULT_PERMISSIONS).
 * Unlike agent/skill authoring (prompt + markdown, root-restricted by
 * construction), a tool file is arbitrary executable code imported by the
 * runtime — it must never run without the user's approval.
 *
 * There is deliberately no tool.delete: deleting an executable file the
 * agent wrote is a surface/API action (DELETE /api/tool/:name, the web
 * Tools section).
 */

/** The contract text embedded in the description (mirrors toolTemplate). */
const TOOL_CONTRACT = `The code must be a TypeScript module with a default export:

  export default {
    description: "What the tool does, phrased for the model.",
    schema: { type: "object", properties: { ... }, required: [...] },
    async execute(args, ctx) {
      // ctx: { sessionId, cwd?, signal, emitLive }
      return { content: "..." };  // or a plain string
    },
  };

The tool NAME is the <name> argument (the filename stem) — not the module.
Rely on Bun/node builtins; npm imports resolve from the config directory,
not the workspace. Keep execute self-contained and fast: no long-running
loops, honor ctx.signal for cancellable work.`;

export interface ToolCreateDeps {
  /** Service.putTool — validates, writes ~/.config/bai/tools/<name>.ts, hot-registers. */
  putTool(name: string, code: string): Promise<{ name: string; registered: boolean }>;
}

export function toolCreateTool(deps: ToolCreateDeps): Tool {
  return {
    name: "tool.create",
    origin: "builtin",
    description:
      "Create a custom tool from TypeScript source — the file is written to ~/.config/bai/tools/<name>.ts and " +
      "hot-registers immediately (callable on your next turn, no restart). Check the registered tools first " +
      "(the tool list in your context) — don't recreate what exists. " + TOOL_CONTRACT,
    schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "Tool name (filename stem): starts with a letter, then letters/digits/-/_ (max 64). Dotted names (e.g. \"fs.read\") are reserved for overriding built-ins.",
        },
        code: { type: "string", description: "Full TypeScript module source (the default-export contract)" },
      },
      required: ["name", "code"],
    },
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const { name, code } = args as { name?: unknown; code?: unknown };
      if (typeof name !== "string" || name.trim().length === 0) {
        throw new Error("name is required (the filename stem, e.g. \"coin_flip\").");
      }
      if (typeof code !== "string" || code.trim().length === 0) {
        throw new Error("code is required (the full TypeScript module source).");
      }
      if (code.length > 500_000) {
        throw new Error(`code is too large (${code.length} chars; max 500,000).`);
      }
      const result = await deps.putTool(name.trim(), code);
      if (!result.registered) {
        throw new Error(
          `The file for "${result.name}" was written but did not register — the module likely has a syntax error or ` +
            `doesn't default-export { description, schema, execute }. Check the contract and try again.`,
        );
      }
      // Mirror the API route (PUT /api/tool): the loader's onChange publishes
      // on the bus; this hits the web firehose so surfaces refetch the list.
      ctx.emitLive("tools.updated", {});
      return {
        content:
          `Created tool "${result.name}" (~/.config/bai/tools/${result.name}.ts) — registered and callable on your next turn.\n` +
          `It is NOT auto-allowed: first use raises a permission ask for the user to approve (unless config allows it).`,
        meta: { tool: result.name, title: `Created tool: ${result.name}` },
      };
    },
  };
}
