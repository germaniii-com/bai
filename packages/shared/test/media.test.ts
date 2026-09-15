import { describe, expect, test } from "bun:test";
import {
  fuzzyTagScore,
  mediaParamDefaults,
  modelsForWorkflow,
  normalizeTag,
  normalizeTags,
  readMediaGen,
  type MediaModelInfo,
  type MediaParamSpec,
} from "../src";

describe("normalizeTag / normalizeTags", () => {
  test("trims, collapses whitespace, lowercases, caps length", () => {
    expect(normalizeTag("  Hello   World ")).toBe("hello world");
    expect(normalizeTag("x".repeat(50)).length).toBe(32);
  });

  test("drops empties, dedupes, caps count at 10", () => {
    const tags = normalizeTags([" Cat ", "cat", "", "dog", "dog", ...Array.from({ length: 20 }, (_, i) => `t${i}`)]);
    expect(tags[0]).toBe("cat");
    expect(tags[1]).toBe("dog");
    expect(tags).toHaveLength(10);
    expect(new Set(tags).size).toBe(tags.length);
  });
});

describe("mediaParamDefaults", () => {
  test("collects declared defaults only", () => {
    const specs: MediaParamSpec[] = [
      { key: "aspect_ratio", label: "Aspect", kind: "enum", options: [{ value: "1:1", label: "1:1" }], default: "1:1" },
      { key: "seed", label: "Seed", kind: "number" },
      { key: "allow_fallbacks", label: "Fallbacks", kind: "toggle", default: true },
    ];
    expect(mediaParamDefaults(specs)).toEqual({ aspect_ratio: "1:1", allow_fallbacks: true });
  });
});

describe("modelsForWorkflow", () => {
  const models: MediaModelInfo[] = [
    { id: "t2i-only", modes: ["t2i"], maxReferences: 0, maxCount: 1 },
    { id: "both", modes: ["t2i", "i2i"], maxReferences: 4, maxCount: 4 },
  ];

  test("hides models that don't support the selected workflow", () => {
    expect(modelsForWorkflow(models, "t2i").map((m) => m.id)).toEqual(["t2i-only", "both"]);
    expect(modelsForWorkflow(models, "i2i").map((m) => m.id)).toEqual(["both"]);
  });
});

describe("fuzzyTagScore", () => {
  test("matches prefix, substring, and subsequence tokens", () => {
    expect(fuzzyTagScore("gemini 3 pro", "gemini")).toBeGreaterThan(0);
    expect(fuzzyTagScore("gemini 3 pro", "pro")).toBeGreaterThan(0);
    expect(fuzzyTagScore("gemini 3 pro", "3")).toBeGreaterThan(0);
    expect(fuzzyTagScore("gemini 3 pro", "g3p")).toBeGreaterThan(0);
  });

  test("requires every query token to match", () => {
    expect(fuzzyTagScore("gemini 3 pro", "gemini nope")).toBe(0);
    expect(fuzzyTagScore("cat", "dog")).toBe(0);
  });

  test("ranks tighter matches higher and treats an empty query as match-all", () => {
    expect(fuzzyTagScore("gemini 3 pro", "gemini")).toBeGreaterThan(fuzzyTagScore("gemini 3 pro", "g3p"));
    expect(fuzzyTagScore("gemini 3 pro", "gemini pro")).toBeGreaterThan(fuzzyTagScore("gemini 3 pro", "pro"));
    expect(fuzzyTagScore("anything", "")).toBeGreaterThan(0);
  });
});

describe("readMediaGen", () => {  test("round-trips a stored request (prompt included) and normalizes tags", () => {
    const meta = {
      gen: {
        mode: "i2i",
        prompt: "a red cube",
        model: "openai/gpt-image-2",
        params: { aspect_ratio: "16:9", count: 2, allow_fallbacks: true },
        referenceAssetIds: ["ast_1"],
        tags: [" Cat ", "dog"],
      },
    };
    expect(readMediaGen(meta)).toEqual({
      mode: "i2i",
      prompt: "a red cube",
      model: "openai/gpt-image-2",
      params: { aspect_ratio: "16:9", count: 2, allow_fallbacks: true },
      referenceAssetIds: ["ast_1"],
      tags: ["cat", "dog"],
    });
  });

  test("undefined for missing or malformed recipes", () => {
    expect(readMediaGen(undefined)).toBeUndefined();
    expect(readMediaGen({})).toBeUndefined();
    expect(readMediaGen({ gen: { mode: "nope", prompt: "x" } })).toBeUndefined();
    expect(readMediaGen({ gen: { mode: "t2i" } })).toBeUndefined();
  });
});
