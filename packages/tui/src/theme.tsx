import { createContext, useContext, type ReactNode } from "react";
import { THEME_COLORS, resolveThemeId, type CustomTheme, type ThemeColors, type ThemeId } from "@bai/shared";

/**
 * The TUI's theme: an Ink-facing palette derived from the shared theme
 * catalog (shared/src/themes.ts). Ink maps hex values to the nearest
 * terminal color.
 *
 * Roles mirror the hardcoded ANSI colors they replace:
 * accent (was cyan) highlights focus/titles, success (was green) marks
 * done/add/apply, warning (was yellow) badges and arming hints, danger
 * (was red) errors, secondary (was magenta) diff context and chips, dim
 * (was dimColor) muted text, border boxes. `background` is the theme's
 * surface — the App paints it across the whole terminal (opencode's
 * renderer.setBackgroundColor parity), so themes look the same everywhere
 * instead of blending with whatever terminal palette is underneath.
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
  /** Full-terminal background (the theme's surface color). */
  background: string;
  /**
   * Raised surfaces — the shared `surfaceSecondary` (`--panel`) slot: dialog
   * panels, the composer hub, user-turn cards, and selected list rows. Ink has
   * no shadows, so elevation is conveyed by tone + border.
   */
  panel: string;
  /**
   * Recessed surfaces — the shared `background` (`--inset`) slot: code blocks,
   * tool-output bodies, diff bodies, and pending/queued wells.
   */
  inset: string;
  /**
   * The selected-row bar inside a `panel`: the terminal equivalent of the web's
   * `color-mix(in srgb, accent 14%, panel)` (Ink cannot blend at paint time, so
   * the mix is computed from the palette).
   */
  selection: string;
  /** The theme's true accent slot (`c.accent`) — decorative highlights. */
  accentAlt: string;
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
 * Build the Ink palette for a theme id. Built-ins resolve through the
 * shared catalog; custom themes (~/.config/bai/themes/*.json, registered
 * via registerCustomThemes) resolve through the registry; unknown ids fall
 * back to the default. Cached per raw id — the palette object identity is
 * stable across renders, so the context value doesn't invalidate consumers
 * (markdown's parse memo keys on it) for no reason.
 */
const themeCache = new Map<string, TuiTheme>();
const customRegistry = new Map<string, ThemeColors>();

/** Parse a #rrggbb color into [r, g, b], or null when malformed. */
function parseHex(hex: string): [number, number, number] | null {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return null;
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

/**
 * Linear RGB mix: `a` at `amount` (0..1), `b` at `1 - amount`. The terminal
 * equivalent of the web's `color-mix(in srgb, A n%, B)` — Ink maps the result
 * to the nearest terminal color. Falls back to `b` for malformed input.
 */
export function mixHex(a: string, b: string, amount: number): string {
  const ca = parseHex(a);
  const cb = parseHex(b);
  if (ca === null || cb === null) return b;
  const t = Math.max(0, Math.min(1, amount));
  const channel = (i: number): string => {
    const v = Math.round((ca[i] ?? 0) * t + (cb[i] ?? 0) * (1 - t));
    return Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0");
  };
  return `#${channel(0)}${channel(1)}${channel(2)}`;
}

/** Load the server's custom themes into the resolver (clears the cache). */
export function registerCustomThemes(themes: CustomTheme[]): void {
  customRegistry.clear();
  for (const t of themes) customRegistry.set(t.id, t.colors);
  themeCache.clear();
}

export function tuiTheme(id: string | undefined): TuiTheme {
  const key = id ?? "";
  const cached = themeCache.get(key);
  if (cached !== undefined) return cached;
  const custom = customRegistry.get(key);
  const themeId: ThemeId = custom !== undefined ? (key as ThemeId) : resolveThemeId(id);
  const c = custom ?? THEME_COLORS[themeId];
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
    background: c.surface,
    panel: c.surfaceSecondary,
    inset: c.background,
    selection: mixHex(c.primary, c.surfaceSecondary, 0.14),
    accentAlt: c.accent,
    mdHeading: c.accent,
    mdStrong: c.warning,
    mdEmph: c.warning,
    mdQuote: c.warning,
    mdCode: c.success,
    mdLink: c.secondary,
    mdBullet: c.primary,
    mdEnumeration: c.secondary,
  };
  themeCache.set(key, palette);
  return palette;
}

const ThemeContext = createContext<TuiTheme>(tuiTheme(undefined));

/**
 * Theme provider: the App resolves the effective theme (config value, or a
 * theme-picker preview overriding it) and every component reads the palette
 * via useTheme().
 */
export function ThemeProvider({ theme, children }: { theme: TuiTheme; children: ReactNode }) {
  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

export function useTheme(): TuiTheme {
  return useContext(ThemeContext);
}
