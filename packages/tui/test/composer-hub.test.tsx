import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import React from "react";
import type { Session, SessionId, SessionUsage } from "@bai/shared";
import { contextTracker } from "@bai/shared";
import { ComposerHub } from "../src/components/composer";
import { layoutHubStatus } from "../src/state/hub";

const tick = (ms = 30): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function session(): Session {
  return {
    id: "s1" as SessionId,
    title: "My session",
    workbench: "chat",
    createdAt: "",
    updatedAt: "",
    meta: {},
  };
}

function renderHub(mode: "normal" | "input", runActive = false) {
  const layout = layoutHubStatus({
    width: 60,
    session: session(),
    mode,
    agent: "build",
    model: "stub/echo",
  });
  return render(
    <ComposerHub
      editor={{ text: "", cursor: 0 }}
      mode={mode}
      busy={false}
      escArmed={false}
      runActive={runActive}
      layout={layout}
    />,
  );
}

describe("ComposerHub render", () => {
  test("NORMAL: status row shows label, mode, agent, model; commands row points at the supermenu", async () => {
    const { lastFrame, unmount } = renderHub("normal");
    await tick();
    const frame = lastFrame() ?? "";
    unmount();
    // Status row (the hub owns what the old header carried).
    expect(frame).toContain("chat · My session");
    expect(frame).toContain("NORMAL");
    expect(frame).toContain("@build");
    expect(frame).toContain("stub/echo");
    // Commands row: the old footer hints (the row truncates at the test
    // terminal's 100 columns, so assert the leading entries). The ctrl+**
    // family is gone — the supermenu (ctrl+p) is the single entry point.
    expect(frame).toContain("ctrl+p commands");
    expect(frame).not.toContain("ctrl+l models");
    expect(frame).not.toContain("ctrl+p providers");
    // Ex-mode prompt while in NORMAL.
    expect(frame).toContain(": ");
  });

  test("INPUT: green typing affordance, input-mode command hints", async () => {
    const { lastFrame, unmount } = renderHub("input");
    await tick();
    const frame = lastFrame() ?? "";
    unmount();
    expect(frame).toContain("›");
    expect(frame).toContain("▌");
    expect(frame).toContain("enter send · esc normal · ctrl+j/k newline · ctrl+w word");
    expect(frame).not.toContain("ctrl+p commands");
  });

  test("runActive NORMAL surfaces the esc-stop hint", async () => {
    const { lastFrame, unmount } = renderHub("normal", true);
    await tick();
    const frame = lastFrame() ?? "";
    unmount();
    expect(frame).toContain("esc stop");
  });

  test("context tracker: appended to the commands row in both modes", async () => {
    const usage: SessionUsage = { inputTokens: 40_000, outputTokens: 5_200, contextWindow: 200_000 };
    const tracker = contextTracker(usage);
    expect(tracker).toBeDefined();
    // INPUT mode (short hint row): the full label fits the 100-col test
    // terminal. NORMAL mode's long hint row truncates the tail first — the
    // designed narrow-terminal behavior — so only the segment's head survives.
    const inputLayout = layoutHubStatus({ width: 60, session: session(), mode: "input", agent: "build", model: "stub/echo" });
    const { lastFrame, unmount } = render(
      <ComposerHub
        editor={{ text: "", cursor: 0 }}
        mode="input"
        busy={false}
        escArmed={false}
        runActive={false}
        layout={inputLayout}
        context={tracker}
      />,
    );
    await tick();
    expect(lastFrame() ?? "").toContain("· 45k/200k (23%)");
    unmount();

    const normalLayout = layoutHubStatus({ width: 60, session: session(), mode: "normal", agent: "build", model: "stub/echo" });
    const normal = render(
      <ComposerHub
        editor={{ text: "", cursor: 0 }}
        mode="normal"
        busy={false}
        escArmed={false}
        runActive={false}
        layout={normalLayout}
        context={tracker}
      />,
    );
    await tick();
    expect(normal.lastFrame() ?? "").toContain("· 4");
    normal.unmount();
  });

  test("context tracker: absent when there is no usage yet", async () => {
    const layout = layoutHubStatus({ width: 60, session: session(), mode: "normal", agent: "build", model: "stub/echo" });
    const { lastFrame, unmount } = render(
      <ComposerHub
        editor={{ text: "", cursor: 0 }}
        mode="normal"
        busy={false}
        escArmed={false}
        runActive={false}
        layout={layout}
      />,
    );
    await tick();
    const frame = lastFrame() ?? "";
    unmount();
    expect(frame).not.toContain("45k");
    expect(frame).not.toContain("?/");
  });
});
