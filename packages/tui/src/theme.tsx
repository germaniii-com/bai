import { createContext, useContext, type ReactNode } from "react";
import { THEME_COLORS, resolveThemeId, type ThemeId } from "@bai/shared";

/**
 * The TUI's theme: an Ink-facing palette derived from the shared theme
 * catalog (shared/src/themes.ts). Foregrounds only — the terminal owns the
 * background (transparency/theme respect), so surface colors never apply
 * here. Ink maps hex values to the nearest terminal color.
 *
 * Roles mirror the hardcoded ANSI colors they replace:
 * accent (was cyan) highlights focus/titles, success (was green) marks
 * done/add/apply, warning (was yellow) badges and arming hints, danger
 * (was red) errors, secondary (was magenta) diff context and chips, dim
 * (was dimColor) muted text, border boxes.
 */
export interface TuiTheme {
  id: ThemeId;
  text: string;
  dim: string;
  accent: string;
  border: string;
  success: string;
  warning: string;
  danger: string;
  secondary: string;
  // Markdown element roles (components/markdown.tsx) — the opencode-style
  // treatment, now driven by the active theme instead of one hardcoded
  // dark palette.
  mdHeading: string;
  mdStrong: string;
  mdEmph: string;
  mdQuote: string;
  mdCode: string;
  mdLink: string;
  mdBullet: string;
  mdEnumeration: string;
}

/**
 * Build the Ink palette for a theme id (unknown ids fall back to the
 * default). Cached per id: the palette object identity is stable across
 * renders, so the context value doesn't invalidate consumers (markdown's
 * parse memo keys on it) for no reason.
 */
const themeCache = new Map<string, TuiTheme>();

export function tuiTheme(id: string | undefined): TuiTheme {
  const themeId = resolveThemeId(id);
  const cached = themeCache.get(themeId);
  if (cached !== undefined) return cached;
  const c = THEME_COLORS[themeId];
  const palette: TuiTheme = {
    id: themeId,
    text: c.text,
    dim: c.textMuted,
    accent: c.primary,
    border: c.border,
    success: c.success,
    warning: c.warning,
    danger: c.danger,
    secondary: c.secondary,
    mdHeading: c.accent,
    mdStrong: c.warning,
    mdEmph: c.warning,
    mdQuote: c.warning,
    mdCode: c.success,
    mdLink: c.secondary,
    mdBullet: c.primary,
    mdEnumeration: c.secondary,
  };
  themeCache.set(themeId, palette);
  return palette;
}

const ThemeContext = createContext<TuiTheme>(tuiTheme(undefined));

/**
 * Theme provider: the App resolves the effective theme (config value, or a
 * ctrl+t picker preview overriding it) and every component reads the palette
 * via useTheme().
 */
export function ThemeProvider({ theme, children }: { theme: TuiTheme; children: ReactNode }) {
  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

export function useTheme(): TuiTheme {
  return useContext(ThemeContext);
}
