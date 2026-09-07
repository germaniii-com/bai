import { createContext, useContext, useEffect, type ReactNode } from "react";
import { THEME_COLORS, type ThemeId } from "@bai/shared";

/**
 * Web theme application (germaniii.com's pattern): the resolved theme id is
 * set as `data-theme` on <html>, where the [data-theme] CSS blocks in
 * styles.css define every color variable. The value also lands in
 * localStorage so the inline script in index.html can apply it before the
 * bundle loads (no flash of the wrong theme); the server config is the
 * source of truth — this cache only covers the pre-config boot frame.
 */

export const THEME_STORAGE_KEY = "bai.theme";

const ThemeContext = createContext<ThemeId>("dark");

export function ThemeProvider({ theme, children }: { theme: ThemeId; children: ReactNode }) {
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Private mode etc. — the config remains the source of truth.
    }
    // The PWA/OS chrome color follows the theme's surface.
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta !== null) meta.setAttribute("content", THEME_COLORS[theme].surface);
  }, [theme]);
  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

/** The active theme id (App-resolved from config with the default fallback). */
export function useTheme(): ThemeId {
  return useContext(ThemeContext);
}
