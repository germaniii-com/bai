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
  /** Registered workspace roots — fs tools accept absolute paths under them when the session has no cwd. */
  workspaces?: string[];
  /** RFC3339 now (the drain's clock). */
  now: string;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** True when the agent's tool set includes the fs file tools. */
function hasFsTools(tools: string[] | undefined): boolean {
  return tools?.some((t) => t.startsWith("fs.")) ?? false;
}

export function buildEnvBlock(input: EnvBlockInput): string {
  const lines: string[] = ["<env>"];
  const fs = hasFsTools(input.tools);
  if (input.cwd !== undefined && input.cwd.length > 0) {
    lines.push(`Working directory: ${input.cwd} (fs tool paths resolve relative to it; bash runs there)`);
    if (fs) {
      // The fs tools root relative paths here, but absolute paths under the
      // cwd always resolve — models mix the two up far less with this note.
      lines.push(`fs tools: prefer absolute paths under the working directory (relative paths also resolve against it).`);
    }
  } else {
    if (fs) {
      if (input.workspaces !== undefined && input.workspaces.length > 0) {
        lines.push(
          `No session working directory — fs tools accept ONLY absolute paths inside these registered workspaces: ${input.workspaces.join(", ")}`,
        );
      } else {
        lines.push("No session working directory and no registered workspaces — fs tool paths cannot be resolved; use bash for filesystem access.");
      }
    }
    // bash has no session cwd either: it inherits the server process's cwd —
    // saying so explains the fs-vs-bash discrepancy to the model.
    lines.push(`bash runs in the server process working directory: ${process.cwd()}`);
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
