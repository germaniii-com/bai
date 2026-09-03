/**
 * Presentation helpers shared by every surface. Pure functions only — no
 * imports (shared is the dependency leaf).
 */

/** What a `task` tool result's `<task>` XML wrapper unwraps to. */
export interface TaskOutputView {
  /** The child session id that produced the output. */
  sessionId: string;
  state: "completed" | "error";
  text: string;
}

/**
 * Unwrap the task tool's `<task id state><task_result|task_error>` envelope
 * (core/src/tools/task.ts renderTaskOutput) into displayable text. Returns
 * undefined for content that isn't a task result — callers fall back to the
 * raw content.
 */
export function unwrapTaskOutput(content: string): TaskOutputView | undefined {
  const match =
    /<task id="([^"]*)" state="(completed|error)">\n<(task_result|task_error)>\n?([\s\S]*?)\n?<\/\3>\n<\/task>/.exec(
      content,
    );
  if (match === null) return undefined;
  const [, sessionId, state, , text] = match;
  return {
    sessionId: sessionId as string,
    state: state as TaskOutputView["state"],
    text: text as string,
  };
}
