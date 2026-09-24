import { describe, expect, test } from "bun:test";
import { THEME_OPTIONS } from "@bai/shared";
import { mixHex, tuiTheme } from "../src/theme";

/**
 * The TUI now consumes the shared design system's elevation triad
 * (docs/DESIGN-SYSTEM.md): `surfaceSecondary` → raised `panel`,
 * `background` → recessed `inset`, plus a blended `selection` bar. These
 * roles must resolve for every built-in theme so no surface falls back to a
 * raw/invalid color.
 */
describe("mixHex", () => {
  test("linearly blends toward the base color", () => {
    // 14% of black over white → 0.86 * 255 ≈ 219 (0xdb).
    expect(mixHex("#000000", "#ffffff", 0.14)).toBe("#dbdbdb");
    expect(mixHex("#ffffff", "#000000", 0)).toBe("#000000");
    expect(mixHex("#ffffff", "#000000", 1)).toBe("#ffffff");
  });

  test("clamps the amount and tolerates malformed input", () => {
    expect(mixHex("#ffffff", "#000000", 5)).toBe("#ffffff");
    expect(mixHex("#ffffff", "#000000", -5)).toBe("#000000");
    expect(mixHex("nope", "#123456", 0.5)).toBe("#123456");
  });
});

describe("TUI elevation tokens", () => {
  test("every built-in theme resolves panel/inset/selection/accentAlt", () => {
    for (const option of THEME_OPTIONS) {
      const t = tuiTheme(option.value);
      for (const role of ["panel", "inset", "selection", "accentAlt"] as const) {
        expect(t[role]).toMatch(/^#[0-9a-fA-F]{6}$/);
      }
      // Selection is an accent tint over the panel, never an opaque accent.
      expect(t.selection).not.toBe(t.accent);
    }
  });

  test("the palette identity is cached (stable across reads)", () => {
    const a = tuiTheme("dark");
    const b = tuiTheme("dark");
    expect(a).toBe(b);
  });
});
