import { describe, expect, test } from "bun:test";
import type { ModelInfo } from "@bai/shared";
import { defaultTitle, isDefaultTitle, pickSmallModel, sanitizeGeneratedTitle } from "../src";

describe("pickSmallModel", () => {
  const m = (id: string, opts: Partial<ModelInfo> = {}): ModelInfo => ({
    id,
    provider: "p",
    label: id,
    ...opts,
  });

  test("prefers name-pattern matches, skips reasoning models", () => {
    const models = [
      m("p/claude-opus-4", { outputCost: 5 }),
      m("p/claude-opus-mini", { outputCost: 1 }),
      m("p/gpt-5-nano", { reasoning: true }),
    ];
    expect(pickSmallModel(models)).toBe("p/claude-opus-mini");
  });

  test("pattern priority: mini beats nano beats flash", () => {
    expect(pickSmallModel([m("p/x-flash"), m("p/x-nano")])).toBe("p/x-nano");
    expect(pickSmallModel([m("p/x-flash"), m("p/x-mini")])).toBe("p/x-mini");
  });

  test("falls back to the cheapest non-reasoning model by output cost", () => {
    const models = [
      m("p/big", { outputCost: 10 }),
      m("p/cheap", { outputCost: 0.5 }),
      m("p/reasoning", { outputCost: 0.1, reasoning: true }),
    ];
    expect(pickSmallModel(models)).toBe("p/cheap");
  });

  test("reasoning-only provider: cheapest small-pattern model wins", () => {
    // Mirrors opencode-go in the catalog — every model reasoning-flagged.
    const models = [
      m("p/glm-5.3", { outputCost: 4.4, reasoning: true }),
      m("p/glm-5.3-flash", { outputCost: 0.25, reasoning: true }),
      m("p/deepseek-v4-flash", { outputCost: 0.66, reasoning: true }),
    ];
    expect(pickSmallModel(models)).toBe("p/glm-5.3-flash");
  });

  test("undefined when nothing qualifies (caller falls back)", () => {
    expect(pickSmallModel([m("p/r", { reasoning: true })])).toBeUndefined();
    expect(pickSmallModel([m("p/plain")])).toBeUndefined();
    expect(pickSmallModel([])).toBeUndefined();
  });
});

describe("defaultTitle / isDefaultTitle", () => {
  test("default title is prefix + timestamp and recognized", () => {
    const title = defaultTitle("2026-09-01T15:30:45.123Z");
    expect(title).toBe("New Chat Session - 2026-09-01T15:30:45.123Z");
    expect(isDefaultTitle(title)).toBe(true);
  });

  test("anything else is not a default title", () => {
    expect(isDefaultTitle("")).toBe(false);
    expect(isDefaultTitle("custom name")).toBe(false);
    expect(isDefaultTitle("New Chat Session - not-a-timestamp")).toBe(false);
    // Missing milliseconds (hand-written) — not a creation-time default.
    expect(isDefaultTitle("New Chat Session - 2026-09-01T15:30:45Z")).toBe(false);
    // Case-sensitive prefix.
    expect(isDefaultTitle("new chat session - 2026-09-01T15:30:45.123Z")).toBe(false);
  });
});

describe("sanitizeGeneratedTitle", () => {
  test("plain title passes through", () => {
    expect(sanitizeGeneratedTitle("Debugging production 500 errors")).toBe(
      "Debugging production 500 errors",
    );
  });

  test("strips <think> blocks (reasoning models)", () => {
    expect(sanitizeGeneratedTitle("<think>let me analyze…</think>\nParser bug fix")).toBe(
      "Parser bug fix",
    );
  });

  test("takes the first non-empty line (skips leading blanks)", () => {
    expect(sanitizeGeneratedTitle("\n\n  \nAuth refresh token support")).toBe(
      "Auth refresh token support",
    );
    // The first non-empty line wins; anything after it is dropped.
    expect(sanitizeGeneratedTitle("Sure!\n\nAuth refresh token support")).toBe("Sure!");
  });

  test("strips surrounding quotes", () => {
    expect(sanitizeGeneratedTitle('"Config review"')).toBe("Config review");
    expect(sanitizeGeneratedTitle("'Config review'")).toBe("Config review");
    expect(sanitizeGeneratedTitle("`Config review`")).toBe("Config review");
  });

  test("collapses internal whitespace within the line", () => {
    expect(sanitizeGeneratedTitle("Rate   limiting")).toBe("Rate limiting");
  });

  test("caps at 100 chars with an ellipsis", () => {
    const title = sanitizeGeneratedTitle("y".repeat(150));
    expect(title.length).toBe(100);
    expect(title.endsWith("...")).toBe(true);
  });

  test("nothing usable → empty string (default stands)", () => {
    expect(sanitizeGeneratedTitle("")).toBe("");
    expect(sanitizeGeneratedTitle("<think>only reasoning</think>")).toBe("");
    expect(sanitizeGeneratedTitle('"""')).toBe("");
  });
});
