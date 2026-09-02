import type { Tool, ToolContext, ToolResult } from "./registry";

/**
 * bash — run a shell command in the session's working directory (pi's bash
 * tool, Bun runtime). One-shot spawns under `bash -lc` with a hard timeout
 * that kills the process tree; stdout/stderr are combined and the registry
 * bounds the output (head+tail, full text spilled to a managed file).
 *
 * Permission: unmatched → "ask" (fail-closed) — the permission gate covers
 * every invocation, and "allow always" is session-scoped.
 */

const DEFAULT_TIMEOUT_S = 60;
const MAX_TIMEOUT_S = 600;

/** Bytes of stderr appended after a non-zero exit (the useful tail). */
const STDERR_TAIL = 4_000;

export function bashTool(): Tool {
  return {
    name: "bash",
    origin: "builtin",
    description:
      "Execute a bash command in the session's working directory and return its output. " +
      "Use for running tests, builds, git, and other shell work. Prefer file tools for file edits. " +
      "Long-running servers are not supported — commands should terminate on their own. " +
      "Output is truncated if very large (the full output spills to a file whose path is returned).",
    schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The bash command to execute" },
        timeout: { type: "number", description: "Timeout in seconds (default 60, max 600)" },
      },
      required: ["command"],
    },
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const { command, timeout } = args as { command?: string; timeout?: number };
      if (typeof command !== "string" || command.trim().length === 0) {
        throw new Error("command is required");
      }
      const timeoutS = Math.max(1, Math.min(MAX_TIMEOUT_S, Math.floor(timeout ?? DEFAULT_TIMEOUT_S)));
      const signal = AbortSignal.timeout(timeoutS * 1000);

      let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
      try {
        proc = Bun.spawn({
          cmd: ["/bin/bash", "-lc", command],
          cwd: ctx.cwd !== undefined && ctx.cwd.length > 0 ? ctx.cwd : undefined,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          env: process.env as Record<string, string>,
        });
      } catch (err) {
        throw new Error(`Failed to spawn bash: ${err instanceof Error ? err.message : err}`);
      }

      // Kill on timeout — Bun's spawn has no signal option in 1.3, so a
      // timer kills the direct child (the process we spawned). Killed
      // processes surface as a throw (not an exit-code result): a timed-out
      // command's partial output usually isn't what the model wants.
      let killed = false;
      const killer = setTimeout(() => {
        killed = true;
        try {
          proc.kill();
        } catch {
          // already exited
        }
      }, timeoutS * 1000);
      // Kill on run interrupt too.
      const onAbort = () => {
        try {
          proc.kill();
        } catch {
          // already exited
        }
      };
      if (ctx.signal.aborted) onAbort();
      else ctx.signal.addEventListener("abort", onAbort, { once: true });

      try {
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        ctx.signal.removeEventListener("abort", onAbort);

        if (ctx.signal.aborted) {
          throw new Error("Command aborted: the run was interrupted.");
        }
        if (killed) {
          throw new Error(`Command timed out after ${timeoutS}s and was killed.`);
        }

        const combined = stdout.length > 0 ? (stderr.length > 0 ? `${stdout}\n${stderr}` : stdout) : stderr;
        const output = combined.trimEnd();
        if (exitCode === 0) {
          return {
            content: output.length > 0 ? output : "(no output)",
            meta: { exitCode: 0, command },
          };
        }
        const stderrTail = stderr.length > STDERR_TAIL ? `${stderr.slice(0, STDERR_TAIL)}\n… (stderr truncated)` : stderr;
        const body = stdout.length > 0 ? `stdout:\n${stdout}\nstderr:\n${stderrTail}` : stderrTail;
        return {
          content: `Command failed with exit code ${exitCode}.\n${body}`.trimEnd(),
          meta: { exitCode, command, isError: true },
        };
      } finally {
        clearTimeout(killer);
        ctx.signal.removeEventListener("abort", onAbort);
        try {
          proc.kill();
        } catch {
          // exited already — cleanup is best-effort
        }
      }
    },
  };
}
