import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { customThemeSchema, modeForColors, type CustomTheme, type CustomThemeInput } from "@bai/shared";

/**
 * Custom theme files: ~/.config/bai/themes/<id>.json — the same directory
 * opencode-style hand-written themes live in. The web's "+ Custom Theme"
 * form writes through PUT /api/theme/custom/:id; hand-edited files are
 * picked up by the next list read (no watcher — pickers fetch on open).
 *
 * File shape: { "name": "...", "colors": { ...12 ThemeColors slots } } —
 * the filename stem is the theme id (and the config.theme value); the
 * light/dark mode is derived from the surface color's luminance.
 */

/** Theme ids are filename stems — strict slug, no traversal surface. */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** XDG-aware default (~/.config/bai/themes), mirroring cli/paths.ts. */
export function defaultThemesDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg !== undefined && xdg !== "" ? path.join(xdg, "bai") : path.join(homedir(), ".config", "bai");
  return path.join(base, "themes");
}

function assertId(id: string): void {
  if (!ID_PATTERN.test(id)) {
    throw new Error("theme id must be lowercase letters, digits, and dashes (max 64)");
  }
}

/** Every valid custom theme file in the dir, sorted by id. Malformed files are skipped. */
export function listCustomThemes(dir: string | undefined): CustomTheme[] {
  const root = dir ?? defaultThemesDir();
  if (!existsSync(root)) return [];
  const themes: CustomTheme[] = [];
  for (const entry of readdirSync(root)) {
    if (!entry.endsWith(".json")) continue;
    const id = entry.slice(0, -".json".length);
    if (!ID_PATTERN.test(id)) continue;
    try {
      const parsed = customThemeSchema.parse(JSON.parse(readFileSync(path.join(root, entry), "utf8")));
      themes.push({ id, name: parsed.name, mode: modeForColors(parsed.colors), colors: parsed.colors });
    } catch {
      // A broken hand-edited file must not break the whole list.
    }
  }
  return themes.sort((a, b) => a.id.localeCompare(b.id));
}

/** Create or replace one custom theme file (atomic write). */
export function saveCustomTheme(dir: string | undefined, id: string, input: CustomThemeInput): CustomTheme {
  assertId(id);
  const root = dir ?? defaultThemesDir();
  mkdirSync(root, { recursive: true });
  const file = path.join(root, `${id}.json`);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify({ name: input.name, colors: input.colors }, null, 2) + "\n");
  renameSync(tmp, file);
  return { id, name: input.name, mode: modeForColors(input.colors), colors: input.colors };
}

/** Remove one custom theme file; false when the id is invalid or unknown. */
export function deleteCustomTheme(dir: string | undefined, id: string): boolean {
  if (!ID_PATTERN.test(id)) return false;
  const root = dir ?? defaultThemesDir();
  const file = path.join(root, `${id}.json`);
  if (!existsSync(file)) return false;
  rmSync(file);
  return true;
}
