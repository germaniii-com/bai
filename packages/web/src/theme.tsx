import { createContext, useContext, useEffect, type ReactNode } from "react";
import { THEME_COLORS, hexLuminance, modeForColors, type ThemeColors, type ThemeId } from "@bai/shared";

/**
 * Web theme application (germaniii.com's pattern): built-in themes are set
 * as `data-theme` on <html>, where the [data-theme] CSS blocks in
 * styles.css define every color variable. Custom themes (no static CSS
 * block) apply the same variables INLINE on <html> — inline styles win over
 * the stylesheet, and the data-theme attribute is dropped so nothing bleeds
 * through. The value also lands in localStorage so the inline script in
 * index.html can apply it before the bundle loads (no flash of the wrong
 * theme); the server config is the source of truth — this cache only covers
 * the pre-config boot frame.
 */

export const THEME_STORAGE_KEY = "bai.theme";

/** Theme slot → CSS variable (the mapping the [data-theme] blocks implement). */
export function themeCssVars(colors: ThemeColors): Record<string, string> {
  // Readable text on top of the accent/danger fills: dark text on light
  // fills, white on dark ones (perceived luminance, opencode's formula).
  const readableOn = (hex: string): string => (hexLuminance(hex) > 0.5 ? "#1a1a1a" : "#ffffff");
  return {
    "--bg": colors.surface,
    "--panel": colors.surfaceSecondary,
    "--border": colors.border,
    "--text": colors.text,
    "--dim": colors.textMuted,
    "--accent": colors.primary,
    "--user": colors.success,
    "--success": colors.success,
    "--danger": colors.danger,
    "--warning": colors.warning,
    "--secondary": colors.secondary,
    "--on-accent": readableOn(colors.primary),
    "--on-danger": readableOn(colors.danger),
    "--inset": colors.background,
  };
}

const ThemeContext = createContext<string>("dark");

export function ThemeProvider({
  theme,
  customColors,
  children,
}: {
  /** Active theme id — a built-in ThemeId, or a custom theme's file stem. */
  theme: string;
  /** Set when `theme` names a custom theme: its palette applies inline. */
  customColors?: ThemeColors;
  children: ReactNode;
}) {
  useEffect(() => {
    const el = document.documentElement;
    if (customColors !== undefined) {
      // Custom theme: inline variables override every stylesheet rule.
      el.removeAttribute("data-theme");
      for (const [name, value] of Object.entries(themeCssVars(customColors))) {
        el.style.setProperty(name, value);
      }
      el.style.colorScheme = modeForColors(customColors);
    } else {
      // Built-in: clear any custom inline variables so the [data-theme]
      // block applies, then set the attribute.
      for (const name of Object.keys(themeCssVars(THEME_COLORS.dark))) {
        el.style.removeProperty(name);
      }
      el.style.removeProperty("color-scheme");
      el.setAttribute("data-theme", theme);
    }
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Private mode etc. — the config remains the source of truth.
    }
    // The PWA/OS chrome color follows the theme's surface.
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta !== null) meta.setAttribute("content", (customColors?.surface ?? THEME_COLORS[theme as ThemeId]?.surface) ?? "#09090b");
  }, [theme, customColors]);
  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

/** The active theme id (built-in ThemeId or a custom theme's file stem). */
export function useTheme(): string {
  return useContext(ThemeContext);
}
