import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { THEME_COLORS, THEME_OPTIONS, type ThemeId } from "@bai/shared";

/**
 * The [data-theme] CSS blocks in styles.css are the web's application layer
 * of the shared theme catalog — this test pins them together so a theme
 * added to shared/src/themes.ts without its CSS block (or with drifted
 * values) fails here.
 */

const cssPath = fileURLToPath(new URL("../src/styles.css", import.meta.url));
const css = readFileSync(cssPath, "utf8");

/** Extract `--name: value` pairs from one [data-theme="id"] block. */
function blockVars(id: string): Record<string, string> {
  const match = css.match(new RegExp(`\\[data-theme="${id}"\\]\\s*\\{([^}]*)\\}`));
  if (match === null) throw new Error(`no [data-theme="${id}"] block in styles.css`);
  const vars: Record<string, string> = {};
  for (const m of match[1]!.matchAll(/--([a-z-]+):\s*(#[0-9a-fA-F]{6})/g)) {
    vars[m[1]!] = m[2]!.toLowerCase();
  }
  return vars;
}

/** Theme slot → CSS var (the documented mapping in styles.css). */
const SLOT_TO_VAR: Array<[keyof ThemeColors, string]> = [
  ["surface", "bg"],
  ["surfaceSecondary", "panel"],
  ["border", "border"],
  ["text", "text"],
  ["textMuted", "dim"],
  ["primary", "accent"],
  ["success", "user"],
  ["success", "success"],
  ["danger", "danger"],
  ["warning", "warning"],
  ["secondary", "secondary"],
];

type ThemeColors = (typeof THEME_COLORS)[ThemeId];

describe("theme CSS blocks", () => {
  test("every theme has a [data-theme] block", () => {
    for (const opt of THEME_OPTIONS) {
      expect(() => blockVars(opt.value)).not.toThrow();
    }
  });

  test("every block matches the shared palette (slot → var mapping)", () => {
    for (const id of THEME_OPTIONS.map((o) => o.value)) {
      const colors = THEME_COLORS[id];
      const vars = blockVars(id);
      for (const [slot, varName] of SLOT_TO_VAR) {
        expect(vars[varName]).toBe(colors[slot].toLowerCase());
      }
    }
  });

  test("blocks carry the right color-scheme for their mode", () => {
    for (const opt of THEME_OPTIONS) {
      const match = css.match(
        new RegExp(`\\[data-theme="${opt.value}"\\]\\s*\\{[^}]*color-scheme:\\s*(light|dark)`),
      );
      expect(match?.[1]).toBe(opt.mode);
    }
  });

  test(":root defaults equal the default theme (dark)", () => {
    const root = css.match(/:root\s*\{([^}]*)\}/);
    expect(root).not.toBeNull();
    const rootVars: Record<string, string> = {};
    for (const m of root![1]!.matchAll(/--([a-z-]+):\s*(#[0-9a-fA-F]{6})/g)) {
      rootVars[m[1]!] = m[2]!.toLowerCase();
    }
    const dark = blockVars("dark");
    for (const [, varName] of SLOT_TO_VAR) {
      expect(rootVars[varName]).toBe(dark[varName]);
    }
  });

  test("stylesheet contains global focus and typography contracts", () => {
    expect(css).toContain("--font-sans:");
    expect(css).toContain("--font-mono:");
    expect(css).toMatch(/button:focus-visible[\s\S]*outline: 3px solid/);
    expect(css).toContain(".icon-button::after");
  });
});
