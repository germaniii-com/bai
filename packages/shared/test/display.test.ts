import { describe, expect, test } from "bun:test";
import { unwrapTaskOutput } from "../src/display";

const completed = [
  '<task id="ses_01ABC" state="completed">',
  "<task_result>",
  "child report line 1",
  "child report line 2",
  "</task_result>",
  "</task>",
].join("\n");

const failed = [
  '<task id="ses_01XYZ" state="error">',
  "<task_error>",
  'Subagent "probe" produced no final answer.',
  "</task_error>",
  "</task>",
].join("\n");

describe("unwrapTaskOutput", () => {
  test("unwraps a completed task result (multi-line text preserved)", () => {
    const view = unwrapTaskOutput(completed);
    expect(view).toEqual({ sessionId: "ses_01ABC", state: "completed", text: "child report line 1\nchild report line 2" });
  });

  test("unwraps a failed task result", () => {
    const view = unwrapTaskOutput(failed);
    expect(view?.state).toBe("error");
    expect(view?.text).toContain("produced no final answer");
    expect(view?.sessionId).toBe("ses_01XYZ");
  });

  test("returns undefined for ordinary tool output", () => {
    expect(unwrapTaskOutput("just some file content\nline two")).toBeUndefined();
    expect(unwrapTaskOutput("")).toBeUndefined();
  });

  test("tolerates a missing trailing newline inside the tags", () => {
    const tight = '<task id="ses_1" state="completed">\n<task_result>one line</task_result>\n</task>';
    expect(unwrapTaskOutput(tight)).toEqual({ sessionId: "ses_1", state: "completed", text: "one line" });
  });
});
