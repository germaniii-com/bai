import { describe, expect, test } from "bun:test";
import {
  DEFAULT_THEME,
  isThemeId,
  resolveThemeId,
  THEME_COLORS,
  THEME_OPTIONS,
  type ThemeId,
} from "../src";

const HEX = /^#[0-9a-fA-F]{6}$/;
const SLOTS = [
  "surface",
  "surfaceSecondary",
  "background",
  "text",
  "textMuted",
  "border",
  "success",
  "danger",
  "warning",
  "primary",
  "secondary",
  "accent",
] as const;

describe("theme catalog", () => {
  test("24 themes, options and colors stay in lockstep", () => {
    expect(THEME_OPTIONS.length).toBe(24);
    const optionIds = THEME_OPTIONS.map((o) => o.value).sort();
    const colorIds = (Object.keys(THEME_COLORS) as ThemeId[]).sort();
    expect(optionIds).toEqual(colorIds);
  });

  test("every theme defines every slot with a valid hex color", () => {
    for (const [id, colors] of Object.entries(THEME_COLORS)) {
      for (const slot of SLOTS) {
        expect([id, slot], colors[slot]).toMatch(HEX);
      }
    }
  });

  test("options carry a valid mode", () => {
    for (const opt of THEME_OPTIONS) {
      expect(["light", "dark"]).toContain(opt.mode);
      expect(opt.label.length).toBeGreaterThan(0);
    }
  });

  test("default theme is a known dark theme", () => {
    expect(DEFAULT_THEME).toBe("dark");
    expect(THEME_OPTIONS.find((o) => o.value === DEFAULT_THEME)?.mode).toBe("dark");
  });
});

describe("theme resolution", () => {
  test("isThemeId accepts known ids only", () => {
    expect(isThemeId("dracula")).toBe(true);
    expect(isThemeId("nope")).toBe(false);
    expect(isThemeId(undefined)).toBe(false);
    expect(isThemeId(42)).toBe(false);
  });

  test("resolveThemeId falls back to the default on unknown/missing values", () => {
    expect(resolveThemeId("catppuccin-mocha")).toBe("catppuccin-mocha");
    expect(resolveThemeId("does-not-exist")).toBe(DEFAULT_THEME);
    expect(resolveThemeId(undefined)).toBe(DEFAULT_THEME);
    expect(resolveThemeId(null)).toBe(DEFAULT_THEME);
  });
});
