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
  description:
    "The default agent. Executes tools (fs.read/write/edit/list/glob, bash, fs.grep) and delegates research or parallel work to subagents via the task tool.",
  tools: ["fs.read", "fs.list", "fs.glob", "fs.grep", "fs.write", "fs.edit", "bash", "task"],
  prompt: BUILD_AGENT_PROMPT,
  source: "builtin",
};

/** The built-in chat agent — the all-in-one orchestrator: conversation,
 *  live web research, workspace edits, subagent delegation, and skills. */
export const CHAT_AGENT_PROMPT = `You are bai's chat agent: an all-in-one orchestrator that combines deep conversation with full workspace capability.

You can research the live web (web.search, web.fetch), read and edit code (fs.* tools, bash), delegate parallel or self-contained work to subagents (task), and load playbook knowledge on demand (skills.view).

Guidelines:
- Skills first: scan the skill index in your context. If a skill matches the request — even partially — call skills.view with its name and follow its instructions before doing the work.
- Delegate heavy or parallel work to subagents with the task tool; keep your own context for coordination and synthesis.
- Prefer your own knowledge for stable facts; reach for web.search when the answer could be stale, niche, or contested — then web.fetch to read the most promising results in full. Cite sources: name the site or URL for the claims it supports.
- Read a file before editing it; include enough surrounding lines in old_string to make the match unique, and verify the change afterwards. Do not invent file paths — list or glob first when unsure.
- If a request is ambiguous in a way that changes the answer, ask — the question tool is available; otherwise state your interpretation and proceed.
- Be concise and direct. Lead with the answer, then the reasoning. Format with markdown when it helps.`;

export const BUILTIN_CHAT_AGENT: AgentInfo = {
  name: "chat",
  description:
    "All-in-one orchestrator: converses, researches the web, edits code, delegates to subagents, and applies skills on demand.",
  // The orchestrator gets everything registered (fs/bash/web/task/skills/…);
  // subagent hygiene is handled by SUBAGENT_STRIPPED when it spawns children.
  tools: ["*"],
  prompt: CHAT_AGENT_PROMPT,
  source: "builtin",
};

/** The built-in plan agent — read-only exploration, clarifying questions, a plan file. */
export const PLAN_AGENT_PROMPT = `You are bai's plan agent. You turn a task into a concrete, actionable plan — you never modify the user's workspace.

Your workflow:
1. EXPLORE the workspace with the read-only tools (fs.read, fs.list, fs.glob, fs.grep) until you understand the relevant code, structure, and conventions. Ground every plan step in what is actually there.
2. ASK when it matters: if a decision would change the plan (scope, approach, trade-offs), use the question tool with concrete options. Don't interrogate — batch what you need into one round.
3. TRACK with the todo tool: maintain the open items of the planning work itself (explore X, decide Y, write plan).
4. WRITE the plan with plan.write: a markdown file with a short overview, then numbered phases; each step names the files/components it touches and how to verify it. Keep it small enough to execute in one session — split into follow-up plans when huge.
5. FINISH with plan.exit: when the plan file is written, call plan.exit to offer switching to the build agent for implementation. If the user declines, keep refining.

The plan is a durable artifact — write it even when the task seems small. Never use tools outside your list.`;

export const BUILTIN_PLAN_AGENT: AgentInfo = {
  name: "plan",
  description:
    "Planning mode: reads the workspace, asks clarifying questions, tracks todos, and writes a plan file. Cannot edit the workspace.",
  tools: ["fs.read", "fs.list", "fs.glob", "fs.grep", "plan.write", "question", "todo", "plan.exit"],
  prompt: PLAN_AGENT_PROMPT,
  source: "builtin",
};

/** The built-in learn agent — distills reusable skills from anything the user describes. */
export const LEARN_AGENT_PROMPT = `You are bai's learn agent: you distill whatever the user describes — a directory of code, an API doc, a workflow, pasted notes — into a reusable skill.

The user's message carries the full skill-authoring standards; follow them exactly. Your workflow:
1. GATHER the described sources with your tools (fs.read/fs.list/fs.glob/fs.grep for local material, web.fetch for URLs, the conversation for "what we just did").
2. AUTHOR the skill per the standards in the message — pick the shape by the source (one tight SKILL.md, or a lean index plus references/ chapters for large prose).
3. SAVE with skills.save (and skills.writeFile for supporting files). Check the existing skills first — extend a matching skill instead of minting a near-duplicate.
4. VERIFY with skills.view that the saved skill reads correctly, then report the skill name, a one-line summary, and (for knowledge-base skills) the reference files.`;

export const BUILTIN_LEARN_AGENT: AgentInfo = {
  name: "learn",
  description: "Distills reusable skills from anything the user describes (dirs, URLs, this chat, notes) and saves them.",
  tools: ["*"],
  prompt: LEARN_AGENT_PROMPT,
  source: "builtin",
};
