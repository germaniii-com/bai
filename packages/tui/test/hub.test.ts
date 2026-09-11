import { describe, expect, test } from "bun:test";
import { hubContextLabel, layoutHubStatus, truncate } from "../src/state/hub";
import type { Session, SessionId } from "@bai/shared";

function session(partial: Partial<Session> = {}): Session {
  return {
    id: "s1" as SessionId,
    title: "My session",
    workbench: "chat",
    createdAt: "",
    updatedAt: "",
    meta: {},
    ...partial,
  };
}

describe("truncate", () => {
  test("short strings pass through", () => {
    expect(truncate("abc", 10)).toBe("abc");
    expect(truncate("abc", 3)).toBe("abc");
  });
  test("cut strings gain an ellipsis within the budget", () => {
    expect(truncate("abcdef", 4)).toBe("abc…");
    expect(truncate("abcdef", 4).length).toBe(4);
  });
  test("non-positive budgets collapse to empty", () => {
    expect(truncate("abc", 0)).toBe("");
    expect(truncate("abc", -1)).toBe("");
  });
});

describe("hubContextLabel", () => {
  test("draft state (no session) → new session when no root is known", () => {
    expect(hubContextLabel(null)).toBe("new session");
    expect(hubContextLabel(null, "")).toBe("new session");
  });
  test("draft state (no session) → launch folder basename (workspace mode)", () => {
    expect(hubContextLabel(null, "/Users/me/Work/proj")).toBe("proj");
    // A trailing slash (or stray whitespace) still yields the folder itself.
    expect(hubContextLabel(null, "/Users/me/Work/proj/")).toBe("proj");
    expect(hubContextLabel(null, "  /Users/me/Work/proj  ")).toBe("proj");
  });
  test("chat session → workbench + title", () => {
    expect(hubContextLabel(session())).toBe("chat · My session");
  });
  test("untitled chat session → (untitled) placeholder", () => {
    expect(hubContextLabel(session({ title: "" }))).toBe("chat · (untitled)");
  });
  test("workspace (code) session → folder basename", () => {
    expect(hubContextLabel(session({ workbench: "code", cwd: "/home/me/projects/bai-ts" }))).toBe("bai-ts");
  });
  test("code session with empty cwd falls back to workbench + title", () => {
    expect(hubContextLabel(session({ workbench: "code", cwd: "" }))).toBe("code · My session");
  });
});

describe("layoutHubStatus", () => {
  const agent = "build";
  const model = "stub/echo";

  test("roomy terminal: right group right-aligned, three chips in order", () => {
    const l = layoutHubStatus({ width: 80, session: session(), mode: "normal", agent, model });
    // left label untruncated; mode 6 + sep 3 + @build 6 + sep 3 + stub/echo 9 = 27
    expect(l.left).toBe("chat · My session");
    expect(l.modeText).toBe("NORMAL");
    expect(l.agentText).toBe("@build");
    expect(l.modelText).toBe("stub/echo");
    expect(l.gap).toBe(80 - l.left.length - 27);
    // chips: sessions 0..left, agent then model, model flush with the edge
    expect(l.chips.map((c) => c.kind)).toEqual(["sessions", "agent", "model"]);
    expect(l.chips[0]).toEqual({ kind: "sessions", start: 0, end: l.left.length });
    const modeEnd = l.left.length + l.gap + 6;
    expect(l.chips[1]).toEqual({ kind: "agent", start: modeEnd + 3, end: modeEnd + 3 + 6 });
    expect(l.chips[2]).toEqual({ kind: "model", start: 71, end: 80 });
  });

  test("all chip ranges stay inside the width and never overlap", () => {
    for (const width of [10, 16, 24, 30, 40, 57, 64, 80, 120]) {
      const l = layoutHubStatus({ width, session: session(), mode: "input", agent, model });
      let prevEnd = -1;
      for (const chip of l.chips) {
        expect(chip.start).toBeGreaterThanOrEqual(prevEnd);
        expect(chip.end).toBeLessThanOrEqual(width);
        expect(chip.end).toBeGreaterThan(chip.start);
        prevEnd = chip.end;
      }
    }
  });

  test("narrow terminal: the model chip truncates first, left label shrinks to nothing", () => {
    // width 24 < rightLen 27 → model truncates to fill (room 6)
    const l = layoutHubStatus({ width: 24, session: session(), mode: "normal", agent, model });
    expect(l.modelText.length).toBe(6);
    expect(l.modelText.endsWith("…")).toBe(true);
    expect(l.left).toBe("");
    expect(l.gap).toBe(0);
    expect(l.chips.map((c) => c.kind)).toEqual(["agent", "model"]);
  });

  test("very narrow terminal: model drops, agent truncates, mode survives", () => {
    const l = layoutHubStatus({ width: 12, session: session(), mode: "normal", agent, model });
    expect(l.modelText).toBe("");
    expect(l.agentText).toBe("@b…");
    expect(l.modeText).toBe("NORMAL");
    expect(l.chips.map((c) => c.kind)).toEqual(["agent"]);
    expect(l.chips[0]?.end).toBe(12);
  });

  test("extremely narrow terminal: agent drops too (below the 3-col minimum), only the mode badge stays", () => {
    const l = layoutHubStatus({ width: 10, session: session(), mode: "normal", agent, model });
    expect(l.modelText).toBe("");
    expect(l.agentText).toBe("");
    expect(l.modeText).toBe("NORMAL");
    expect(l.chips.map((c) => c.kind)).toEqual(["sessions"]);
  });

  test("degenerate width: only the mode badge and whatever fits remain", () => {
    const l = layoutHubStatus({ width: 5, session: session(), mode: "input", agent, model });
    expect(l.modelText).toBe("");
    expect(l.agentText).toBe("");
    expect(l.modeText).toBe("INPUT");
    expect(l.chips).toEqual([]);
  });

  test("long model ids truncate with an ellipsis rather than pushing chips off-row", () => {
    const long = "zhipuai/glm-4.6-airx-superlong-identifier";
    const l = layoutHubStatus({ width: 40, session: session(), mode: "normal", agent, model: long });
    expect(l.modelText.length).toBeLessThanOrEqual(40);
    expect(l.modelText.endsWith("…")).toBe(true);
    const modelChip = l.chips.find((c) => c.kind === "model");
    expect(modelChip).toBeDefined();
    expect(modelChip?.end).toBe(40);
  });

  test("draft state with a launch folder: the left chip is the folder, not 'new session'", () => {
    const l = layoutHubStatus({
      width: 80,
      session: null,
      mode: "normal",
      agent,
      model,
      workspaceRoot: "/Users/me/Work/proj",
    });
    expect(l.left).toBe("proj");
    expect(l.left).not.toContain("new session");
    // The draft label is still the sessions chip (clickable → session picker).
    expect(l.chips[0]).toEqual({ kind: "sessions", start: 0, end: 4 });
    expect(l.chips.map((c) => c.kind)).toEqual(["sessions", "agent", "model"]);
  });

  test("draft state without a root keeps the 'new session' placeholder", () => {
    const l = layoutHubStatus({ width: 80, session: null, mode: "normal", agent, model });
    expect(l.left).toBe("new session");
    expect(l.chips[0]).toEqual({ kind: "sessions", start: 0, end: 11 });
  });

  test("a very deep launch folder still truncates within the row", () => {
    const deep = "/Users/me/Work/clients/acme/platform/services/api-server";
    const l = layoutHubStatus({
      width: 30,
      session: null,
      mode: "normal",
      agent,
      model,
      workspaceRoot: deep,
    });
    expect(l.left.endsWith("…")).toBe(true);
    // Every chip still fits and the row never exceeds the width.
    for (const chip of l.chips) expect(chip.end).toBeLessThanOrEqual(30);
  });
});
