import { describe, expect, test } from "bun:test";
import { isZdrCapable, sortModelsZdrFirst } from "../src";

describe("ZDR overlay", () => {
  test("capable providers are recognized", () => {
    expect(isZdrCapable("openai", "gpt-5")).toBe(true);
    expect(isZdrCapable("anthropic", "claude-sonnet-4-5")).toBe(true);
    expect(isZdrCapable("groq", "llama-4")).toBe(true);
  });

  test("non-capable providers are not", () => {
    expect(isZdrCapable("stub", "echo")).toBe(false);
    expect(isZdrCapable("deepseek", "deepseek-v4")).toBe(false);
    expect(isZdrCapable("unknown-provider", "x")).toBe(false);
  });

  test("per-model exclusions carve models out of a capable provider", () => {
    // Anthropic Covered Models require 30-day retention — not ZDR.
    expect(isZdrCapable("anthropic", "claude-fable-5")).toBe(false);
    expect(isZdrCapable("anthropic", "claude-mythos-5.1")).toBe(false);
    // Other Anthropic models stay capable.
    expect(isZdrCapable("anthropic", "claude-sonnet-4-5")).toBe(true);
  });

  test("sortModelsZdrFirst is a no-op copy when the preference is off", () => {
    const models = [
      { id: "deepseek/v4", provider: "deepseek" },
      { id: "openai/gpt-5", provider: "openai" },
    ];
    const sorted = sortModelsZdrFirst(models, false);
    expect(sorted).toEqual(models);
    expect(sorted).not.toBe(models); // a copy, never the input
  });

  test("sortModelsZdrFirst floats capable models first, preserving order within groups", () => {
    const models = [
      { id: "deepseek/v4", provider: "deepseek" },
      { id: "openai/gpt-5-mini", provider: "openai" },
      { id: "mistral/large", provider: "mistral" },
      { id: "openai/gpt-5", provider: "openai" },
      { id: "anthropic/claude-fable-5", provider: "anthropic" }, // excluded → not capable
      { id: "anthropic/claude-sonnet-4-5", provider: "anthropic" },
    ];
    const sorted = sortModelsZdrFirst(models, true);
    expect(sorted.map((m) => m.id)).toEqual([
      // capable first, input order preserved within the group
      "openai/gpt-5-mini",
      "mistral/large",
      "openai/gpt-5",
      "anthropic/claude-sonnet-4-5",
      // then the rest, input order preserved
      "deepseek/v4",
      "anthropic/claude-fable-5",
    ]);
  });
});
