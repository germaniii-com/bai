import { describe, expect, test } from "bun:test";
import { agentCycleDelta, cycleAgentName } from "../src/state/agents";

const NAMES = ["build", "chat", "plan", "learn", "reviewer"];

describe("cycleAgentName", () => {
  test("steps forward and backward with wraparound", () => {
    expect(cycleAgentName(NAMES, "build", 1)).toBe("chat");
    expect(cycleAgentName(NAMES, "reviewer", 1)).toBe("build");
    expect(cycleAgentName(NAMES, "build", -1)).toBe("reviewer");
    expect(cycleAgentName(NAMES, "plan", -1)).toBe("chat");
  });

  test("unknown current enters at the start (forward) or end (reverse)", () => {
    expect(cycleAgentName(NAMES, undefined, 1)).toBe("build");
    expect(cycleAgentName(NAMES, "ghost", 1)).toBe("build");
    expect(cycleAgentName(NAMES, undefined, -1)).toBe("reviewer");
    expect(cycleAgentName(NAMES, "ghost", -1)).toBe("reviewer");
  });

  test("empty list yields nothing", () => {
    expect(cycleAgentName([], "build", 1)).toBeUndefined();
  });

  test("single agent cycles to itself (caller no-ops)", () => {
    expect(cycleAgentName(["build"], "build", 1)).toBe("build");
  });
});

describe("agentCycleDelta", () => {
  test("plain tab is forward, shift+tab is reverse", () => {
    expect(agentCycleDelta("\t", { tab: true, shift: false })).toBe(1);
    expect(agentCycleDelta(undefined, { tab: true, shift: true })).toBe(-1);
  });

  test("backtab escape spellings are reverse", () => {
    expect(agentCycleDelta("\x1b[Z", { tab: true })).toBe(-1);
    expect(agentCycleDelta("\x1b[9;2u", {})).toBe(-1); // kitty CSI u
    expect(agentCycleDelta("\x1b[27;2;9~", {})).toBe(-1); // xterm modifyOtherKeys
  });

  test("ESC-stripped backtab only counts when ink marked it as tab", () => {
    expect(agentCycleDelta("[Z", { tab: true })).toBe(-1);
    // A literal "[Z" typed into the composer is not a keybinding.
    expect(agentCycleDelta("[Z", { tab: false })).toBeNull();
    expect(agentCycleDelta("[9;2u", {})).toBeNull();
  });

  test("non-tab keys never cycle", () => {
    expect(agentCycleDelta("j", {})).toBeNull();
    expect(agentCycleDelta(undefined, {})).toBeNull();
  });
});
