/**
 * The `<env>` system block: session metadata every agent (and subagent)
 * sees so it knows where it is and when it is — cwd for relative fs paths
 * and bash, the session/workbench it is driving, its own identity, the
 * platform, and the date. Built per drain from the session row, so
 * subagents inherit their parent's cwd automatically (their session carries
 * it) — opencode/Claude-Code's env-block parity.
 */

export interface EnvBlockInput {
  /** Session working directory (absent for plain chat sessions). */
  cwd?: string;
  workbench: string;
  title: string;
  agent: string;
  /** Tool names the agent may use (registry ∩ allow-list — what this drain can actually call). */
  tools?: string[];
  /** RFC3339 now (the drain's clock). */
  now: string;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function buildEnvBlock(input: EnvBlockInput): string {
  const lines: string[] = ["<env>"];
  if (input.cwd !== undefined && input.cwd.length > 0) {
    lines.push(`Working directory: ${input.cwd} (fs tool paths resolve relative to it; bash runs there)`);
  }
  const title = input.title.length > 0 ? ` — "${input.title}"` : "";
  lines.push(`Workbench: ${input.workbench}${title}`);
  lines.push(`Agent: ${input.agent}`);
  if (input.tools !== undefined && input.tools.length > 0) {
    lines.push(`Available tools: ${input.tools.join(", ")}`);
  }
  lines.push(`Platform: ${process.platform}`);
  const date = new Date(input.now);
  if (!Number.isNaN(date.getTime())) {
    lines.push(`Date: ${date.toISOString().slice(0, 10)} (${WEEKDAYS[date.getUTCDay()] ?? ""})`.trimEnd());
  }
  lines.push("</env>");
  return lines.join("\n");
}
