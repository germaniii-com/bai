/**
 * Agent definitions — the contract between file-defined agents
 * (~/.config/bai/agents/*.md) and every bai surface.
 *
 * An agent file is markdown with optional YAML frontmatter; the body is the
 * agent's system prompt. The name is the filename stem:
 *
 *   ---
 *   description: Reviews code changes without editing.
 *   model: anthropic/claude-sonnet-4-5
 *   tools:
 *     - fs.read
 *     - fs.glob
 *   ---
 *   You are a meticulous code reviewer...
 *
 * Only the minimal field set is supported (description, model, tools) — see
 * the plan: no temperature/mode/hidden yet.
 */
import { z } from "zod";

/** Where an agent definition comes from. */
export type AgentSource = "builtin" | "file";

/** A resolved agent definition (built-in or file-defined). */
export interface AgentInfo {
  name: string;
  description?: string;
  /** Catalog model id override, e.g. "anthropic/claude-sonnet-4-5". */
  model?: string;
  /**
   * Tool names the agent may use (registry names, e.g. "fs.read"). A single
   * "*" entry means every registered tool. Empty = pure persona, no tools.
   */
  tools: string[];
  /** System prompt (the markdown body). */
  prompt: string;
  source: AgentSource;
  /** Absolute path of the defining markdown file (file agents only). */
  path?: string;
}

/** Frontmatter of an agent markdown file — deliberately minimal. */
export const agentFrontmatterSchema = z.object({
  description: z.string().max(2000).optional(),
  model: z.string().max(200).optional(),
  tools: z.array(z.string().min(1).max(100)).max(50).optional(),
});

export type AgentFrontmatter = z.infer<typeof agentFrontmatterSchema>;

/** Valid agent names: filename stems — letter first, then letters/digits/-/_ . */
export function isValidAgentName(name: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name);
}

/** The default build agent's system prompt. */
export const BUILD_AGENT_PROMPT = `You are bai's build agent, an expert software engineer working directly in the user's workspace.

You accomplish tasks end-to-end: explore the code with the fs tools, make changes with write/edit, and verify your work. Prefer small, focused edits over rewrites.

Guidelines:
- Read a file before editing it; your edits must match the file's exact current content, including whitespace and indentation.
- When editing, include enough surrounding lines in old_string to make the match unique.
- After changes, verify (re-read the file, or reason through the change) before declaring done.
- Do not invent file paths — list or glob first when unsure.
- Keep responses concise; show diffs or code only when useful.`;

/** The built-in build agent — the default when a session selects no agent. */
export const BUILTIN_BUILD_AGENT: AgentInfo = {
  name: "build",
  description: "The default agent. Executes tools (fs.read/write/edit/list/glob) based on configured permissions.",
  tools: ["fs.read", "fs.list", "fs.glob", "fs.write", "fs.edit"],
  prompt: BUILD_AGENT_PROMPT,
  source: "builtin",
};
