import { describe, expect, test } from "bun:test";
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  MIN_MAX_OUTPUT_TOKENS,
  resolveMaxOutputTokens,
} from "../src/provider/output-limit";

/**
 * The output ceiling decides whether a large tool call can complete at all: the
 * adapters fall back to 4096 tokens (~16 KB) when the request carries no
 * `params.max_tokens`, which silently truncates big `fs.write` arguments and
 * ends the run. See docs/TOOL-OUTPUT-BUDGETS.md.
 */
describe("resolveMaxOutputTokens", () => {
  test("falls back to the default when nothing is known", () => {
    expect(resolveMaxOutputTokens()).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
    expect(resolveMaxOutputTokens({})).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
    expect(resolveMaxOutputTokens({ configValue: undefined, modelLimit: undefined, contextWindow: undefined })).toBe(
      DEFAULT_MAX_OUTPUT_TOKENS,
    );
  });

  test("prefers the model's catalog limit over the default", () => {
    expect(resolveMaxOutputTokens({ modelLimit: 8_000 })).toBe(8_000);
    expect(resolveMaxOutputTokens({ modelLimit: 64_000 })).toBe(64_000);
  });

  test("a config override wins when it is within the vendor cap", () => {
    expect(resolveMaxOutputTokens({ configValue: 4_000, modelLimit: 8_000 })).toBe(4_000);
    // ...including a deliberately tiny value for forcing chunked writes.
    expect(resolveMaxOutputTokens({ configValue: 512, modelLimit: 64_000 })).toBe(512);
  });

  test("never exceeds the vendor cap, however large the override", () => {
    expect(resolveMaxOutputTokens({ configValue: 500_000, modelLimit: 8_000 })).toBe(8_000);
    expect(resolveMaxOutputTokens({ configValue: 500_000 })).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
  });

  test("never takes more than half the context window", () => {
    expect(resolveMaxOutputTokens({ modelLimit: 16_384, contextWindow: 8_192 })).toBe(4_096);
    // A tiny window still beats the floor only when the floor is smaller.
    expect(resolveMaxOutputTokens({ modelLimit: 1_000, contextWindow: 2_000 })).toBe(1_000);
  });

  test("the context clamp applies to the config override too", () => {
    expect(resolveMaxOutputTokens({ configValue: 8_000, contextWindow: 8_192 })).toBe(4_096);
  });

  test("non-positive values count as unset, not as a request", () => {
    // 0, negatives and non-finite numbers are all "no opinion" — never a cap.
    expect(resolveMaxOutputTokens({ configValue: 0, modelLimit: 0 })).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
    expect(resolveMaxOutputTokens({ configValue: -5, modelLimit: -5, contextWindow: -5 })).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
    expect(resolveMaxOutputTokens({ configValue: Number.NaN, modelLimit: Number.NaN })).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
    expect(resolveMaxOutputTokens({ configValue: Number.POSITIVE_INFINITY })).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
  });

  test("honours the floor for a positive but starved request", () => {
    expect(resolveMaxOutputTokens({ configValue: 1 })).toBe(MIN_MAX_OUTPUT_TOKENS);
    expect(resolveMaxOutputTokens({ configValue: 255 })).toBe(MIN_MAX_OUTPUT_TOKENS);
    expect(resolveMaxOutputTokens({ configValue: 256 })).toBe(MIN_MAX_OUTPUT_TOKENS);
    expect(resolveMaxOutputTokens({ configValue: 257 })).toBe(257);
  });

  test("always returns a positive integer", () => {
    for (const value of [
      resolveMaxOutputTokens(),
      resolveMaxOutputTokens({ modelLimit: 4_096.7 }),
      resolveMaxOutputTokens({ contextWindow: 10_001 }),
    ]) {
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    }
  });

  test("a 4096-era default is never what we send", () => {
    // Regression guard for the bug itself: the whole point is that the ceiling
    // must not silently stay at the adapters' 4096 fallback.
    expect(resolveMaxOutputTokens()).toBeGreaterThan(4_096);
  });
});
