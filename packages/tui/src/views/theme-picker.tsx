import { SelectDialog } from "../components/dialog";
import { resolveThemeId, THEME_OPTIONS } from "@bai/shared";

/**
 * Theme picker (ctrl+t) — a SelectDialog over the shared theme catalog with
 * opencode's live-preview semantics: moving the cursor (or filtering)
 * IMMEDIATELY applies the highlighted theme App-wide (unpersisted), esc
 * restores the pre-dialog theme, enter confirms and persists it via
 * PUT /api/config (config.updated then syncs every other surface).
 */
export function ThemePicker({
  current,
  onPreview,
  onPick,
  onClose,
}: {
  /** The active theme id (config value; may be an unknown id). */
  current: string | undefined;
  /** Live preview: apply the highlighted theme without persisting. */
  onPreview: (value: string) => void;
  /** Confirm: persist the highlighted theme. */
  onPick: (value: string) => void;
  /** esc — restore and close. */
  onClose: () => void;
}) {
  const options = THEME_OPTIONS.map((t) => ({
    value: t.value,
    label: t.label,
    hint: t.mode,
  }));
  // Seed the cursor on the active theme — resolved through the same
  // fallback the App applies, so an unknown config id previews its actual
  // (default) theme rather than jumping to the top of the list.
  const resolved = resolveThemeId(current);
  const initialIndex = Math.max(
    0,
    THEME_OPTIONS.findIndex((t) => t.value === resolved),
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
