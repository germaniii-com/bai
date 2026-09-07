import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import { modeForColors, type ThemeColors } from "@bai/shared";

/**
 * Local Monaco wiring (no CDN — the PWA must work offline):
 *
 * - The editor + language workers are bundled by Vite (`?worker` imports)
 *   and handed to @monaco-editor/react's loader, which would otherwise
 *   fetch monaco from jsdelivr.
 * - `defineBaiTheme(colors)` builds the Monaco theme from the shared
 *   ThemeColors data (packages/shared/src/themes.ts — the single source of
 *   truth: THEME_COLORS for built-ins, a custom theme's colors object) —
 *   NOT from computed CSS. Reading CSS variables raced the ThemeProvider's
 *   effect (child effects fire before parent effects, so the read saw the
 *   PREVIOUS palette and the editor never re-skinned on the fly). Data
 *   passed through props has no such race.
 * - Every call defines a FRESH theme name (versioned suffix) and sets it —
 *   re-defining the same name while editors are live is not reliably
 *   re-applied by Monaco; a new name always fires the theme-change event.
 */

// Vite bundles each worker; Monaco asks for them by language id at runtime.
(self as unknown as { MonacoEnvironment?: monaco.Environment }).MonacoEnvironment = {
  getWorker(_workerId: string, label: string): Worker {
    if (label === "json") return new jsonWorker();
    if (label === "css" || label === "scss" || label === "less") return new cssWorker();
    if (label === "html" || label === "handlebars" || label === "razor") return new htmlWorker();
    if (label === "typescript" || label === "javascript") return new tsWorker();
    return new editorWorker();
  },
};

// Use the locally-bundled monaco instead of the loader's CDN default.
loader.config({ monaco });

/** Prefix for every Monaco theme this app defines (versioned per call). */
export const BAI_MONACO_THEME = "bai";

let themeVersion = 0;

/** Monaco theme-rule colors are hex WITHOUT the leading '#'. */
function hex(color: string): string {
  return color.replace(/^#/, "");
}

/**
 * Define (and activate) the "bai" Monaco theme from a ThemeColors palette.
 * Returns the theme name — always unique per call, so live editors re-skin
 * immediately and the returned name can ride the Editor's `theme` prop.
 * Base theme follows the palette's mode so inherited token colors stay
 * readable; the palette's roles map onto the editor chrome and a modest
 * set of syntax tokens (comments muted, strings success, keywords primary,
 * numbers warning, types secondary, functions accent).
 */
export function defineBaiTheme(colors: ThemeColors): string {
  themeVersion += 1;
  const name = `${BAI_MONACO_THEME}-${themeVersion}`;
  monaco.editor.defineTheme(name, {
    base: modeForColors(colors) === "light" ? "vs" : "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: hex(colors.textMuted), fontStyle: "italic" },
      { token: "string", foreground: hex(colors.success) },
      { token: "keyword", foreground: hex(colors.primary) },
      { token: "number", foreground: hex(colors.warning) },
      { token: "type", foreground: hex(colors.secondary) },
      { token: "tag", foreground: hex(colors.primary) },
      { token: "attribute.name", foreground: hex(colors.secondary) },
      { token: "function", foreground: hex(colors.accent) },
    ],
    colors: {
      "editor.background": colors.surface,
      "editor.foreground": colors.text,
      "editorLineNumber.foreground": colors.textMuted,
      "editorLineNumber.activeForeground": colors.text,
      "editor.lineHighlightBackground": colors.background,
      "editorCursor.foreground": colors.primary,
      "editor.selectionBackground": `${colors.primary}40`,
      "editorIndentGuide.background1": colors.border,
      "editorWidget.background": colors.surfaceSecondary,
      "editorGutter.background": colors.surface,
      "scrollbarSlider.background": `${colors.border}80`,
    },
  });
  monaco.editor.setTheme(name);
  return name;
}
