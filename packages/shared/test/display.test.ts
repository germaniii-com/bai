import { describe, expect, test } from "bun:test";
import { messageAttributionLabel, unwrapTaskOutput } from "../src/display";

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

describe("messageAttributionLabel", () => {
  test("renders `<agent> . <provider/model>`", () => {
    expect(messageAttributionLabel({ agent: "chat", provider: "anthropic", model: "claude-sonnet-4-5" })).toBe(
      "chat . anthropic/claude-sonnet-4-5",
    );
  });

  test("swaps the provider id for its display name when the catalog resolved one", () => {
    expect(
      messageAttributionLabel({ agent: "chat", provider: "anthropic", model: "claude-sonnet-4-5" }, {
        providerName: "Anthropic",
      }),
    ).toBe("chat . Anthropic/claude-sonnet-4-5");
  });

  test("keeps the raw id when the provider-name lookup missed", () => {
    expect(
      messageAttributionLabel({ agent: "chat", provider: "anthropic", model: "claude-sonnet-4-5" }, {
        providerName: undefined,
      }),
    ).toBe("chat . anthropic/claude-sonnet-4-5");
  });

  test("omits missing parts instead of leaving empty segments", () => {
    // No provider on the row (partial attribution) — no dangling slash.
    expect(messageAttributionLabel({ agent: "build", model: "claude-4" })).toBe("build . claude-4");
    // No agent — the target stands alone.
    expect(messageAttributionLabel({ provider: "openai", model: "gpt-5" })).toBe("openai/gpt-5");
    // Model only.
    expect(messageAttributionLabel({ model: "gpt-5" })).toBe("gpt-5");
    // Agent only.
    expect(messageAttributionLabel({ agent: "chat" })).toBe("chat");
  });

  test("returns undefined when nothing is known (user turns, pre-migration rows)", () => {
    expect(messageAttributionLabel(undefined)).toBeUndefined();
    expect(messageAttributionLabel(null)).toBeUndefined();
    expect(messageAttributionLabel({})).toBeUndefined();
    // Empty strings are not attribution.
    expect(messageAttributionLabel({ agent: "", provider: "", model: "" })).toBeUndefined();
  });

  test("a model id that already carries the provider prefix is not doubled", () => {
    // The engine stores provider + the vendor model id, so `provider/model`
    // reads exactly like the catalog id. This guards the split contract.
    expect(messageAttributionLabel({ agent: "chat", provider: "openrouter", model: "anthropic/claude-4" })).toBe(
      "chat . openrouter/anthropic/claude-4",
    );
  });
});
