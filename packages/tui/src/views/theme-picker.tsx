import { SelectDialog } from "../components/dialog";
import { resolveThemeId, THEME_OPTIONS, type CustomTheme } from "@bai/shared";

/**
 * Theme picker (ctrl+t) — a SelectDialog over the theme catalog with
 * opencode's live-preview semantics: moving the cursor (or filtering)
 * IMMEDIATELY applies the highlighted theme App-wide (unpersisted), esc
 * restores the pre-dialog theme, enter confirms and persists it via
 * PUT /api/config (config.updated then syncs every other surface).
 *
 * Custom themes (~/.config/bai/themes/*.json, fetched by the App) list
 * after the built-ins; creating one happens on the web (the "+ Custom
 * Theme" form) or by dropping a JSON file in the directory.
 */
export function ThemePicker({
  current,
  customThemes = [],
  onPreview,
  onPick,
  onClose,
}: {
  /** The active theme id (config value; may be a custom theme's file stem). */
  current: string | undefined;
  /** Custom themes from the server (App-fetched, registry-registered). */
  customThemes?: CustomTheme[];
  /** Live preview: apply the highlighted theme without persisting. */
  onPreview: (value: string) => void;
  /** Confirm: persist the highlighted theme. */
  onPick: (value: string) => void;
  /** esc — restore and close. */
  onClose: () => void;
}) {
  const options = [
    ...THEME_OPTIONS.map((t) => ({ value: t.value, label: t.label, hint: t.mode })),
    ...customThemes.map((t) => ({ value: t.id, label: t.name, hint: `custom · ${t.mode}` })),
  ];
  // Seed the cursor on the active theme — a custom id seeds on its own row
  // when loaded; otherwise resolved through the same fallback the App
  // applies, so an unknown config id previews its actual (default) theme
  // rather than jumping to the top of the list.
  const customCurrent = customThemes.find((t) => t.id === current);
  const seedValue = customCurrent !== undefined ? customCurrent.id : resolveThemeId(current);
  const initialIndex = Math.max(
    0,
    options.findIndex((o) => o.value === seedValue),
  );

  return (
    <SelectDialog
      title="Themes"
      options={options}
      initialIndex={initialIndex}
      onHighlight={onPreview}
      onPick={onPick}
      onClose={onClose}
    />
  );
}
