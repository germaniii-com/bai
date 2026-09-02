import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isValidAgentName } from "@bai/shared";
import type { Tool, ToolContext, ToolResult } from "./registry";

/**
 * plan.write — the plan agent's only write tool (opencode's plan-agent path
 * restriction, realized as a tool instead of permission rules: bai's engine
 * matches tool names, and a rooted tool is stricter than any rule). Content
 * lands under the plans dir (`~/.config/bai/plans/`) as `<name>.md` and
 * nowhere else — path escapes throw before any write.
 */
export function planWriteTool(plansDir: string): Tool {
  return {
    name: "plan.write",
    origin: "builtin",
    description:
      "Write a plan file to bai's plans directory (~/.config/bai/plans/<name>.md). " +
      "Use markdown: a one-paragraph overview, then numbered phases with concrete steps, " +
      "touched files, and verification. Replaces the plan if the name already exists.",
    schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Plan file name without extension (letters/digits/-/_)" },
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
      const file = path.join(plansDir, `${name}.md`);
      // Root enforcement: resolve and prefix-check BEFORE writing.
      const resolvedRoot = path.resolve(plansDir);
      const resolved = path.resolve(file);
      if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
        throw new Error(`Plan path escapes the plans directory: ${resolved}`);
      }
      mkdirSync(resolvedRoot, { recursive: true });
      const existed = existsSync(resolved);
      writeFileSync(resolved, content);
      return {
        content: existed
          ? `Updated plan ${name}: ${resolved}`
          : `Wrote plan ${name}: ${resolved} (${Buffer.byteLength(content)} bytes)`,
        meta: { path: resolved, name, bytes: Buffer.byteLength(content), created: !existed },
      };
    },
  };
}

/** Absolute path of a plan file (surfaces read plans through fs tools/APIs). */
export function planFileFor(plansDir: string, name: string): string {
  return path.join(plansDir, `${name}.md`);
}

/** Read a plan file back (used by tests). */
export function readPlan(plansDir: string, name: string): string | undefined {
  const file = planFileFor(plansDir, name);
  if (!existsSync(file)) return undefined;
  return readFileSync(file, "utf8");
}
