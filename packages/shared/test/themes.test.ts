import { describe, expect, test } from "bun:test";
import {
  customThemeSchema,
  DEFAULT_THEME,
  isThemeId,
  modeForColors,
  resolveThemeId,
  slugifyThemeId,
  THEME_COLORS,
  THEME_OPTIONS,
  type ThemeColors,
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

describe("custom themes", () => {
  const palette: ThemeColors = {
    surface: "#101010",
    surfaceSecondary: "#1a1a1a",
    background: "#0a0a0a",
    text: "#eeeeee",
    textMuted: "#888888",
    border: "#2a2a2a",
    success: "#00cc88",
    danger: "#ff4455",
    warning: "#ffcc00",
    primary: "#4488ff",
    secondary: "#44ccff",
    accent: "#8844ff",
  };

  test("customThemeSchema accepts a full palette and rejects bad hex", () => {
    expect(customThemeSchema.parse({ name: "My Theme", colors: palette }).name).toBe("My Theme");
    expect(() => customThemeSchema.parse({ name: "x", colors: { ...palette, surface: "nope" } })).toThrow();
    expect(() => customThemeSchema.parse({ name: "", colors: palette })).toThrow();
    expect(() => customThemeSchema.parse({ name: "x", colors: { ...palette, warning: undefined } })).toThrow();
  });

  test("modeForColors derives light/dark from the surface luminance", () => {
    expect(modeForColors(palette)).toBe("dark");
    expect(modeForColors({ ...palette, surface: "#f4f4f5" })).toBe("light");
    expect(modeForColors(THEME_COLORS.light)).toBe("light");
    expect(modeForColors(THEME_COLORS.dark)).toBe("dark");
  });

  test("slugifyThemeId produces filename-safe stems", () => {
    expect(slugifyThemeId("My Theme!")).toBe("my-theme");
    expect(slugifyThemeId("  --Weird   Name--  ")).toBe("weird-name");
    expect(slugifyThemeId("日本語")).toBe("");
    const long = slugifyThemeId("a".repeat(100));
    expect(long.length).toBe(64);
  });
});
