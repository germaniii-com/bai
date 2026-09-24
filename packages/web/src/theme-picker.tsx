import { useState } from "react";
import { Check, Plus } from "lucide-react";
import {
  THEME_COLORS,
  THEME_OPTIONS,
  resolveThemeId,
  type CustomTheme,
  type CustomThemeInput,
  type ThemeColors,
} from "@bai/shared";
import { Button, ColorInput, Field, Modal, TextInput } from "./components";
import { shouldAutoFocus } from "./pointer";

/**
 * Theme selector modal (germaniii.com's ThemeSelectorModal): a grid of
 * preview cards, each hardcoded inline from that theme's own palette — a
 * self-contained miniature independent of the active theme's variables.
 * Custom themes (~/.config/bai/themes/*.json) render as cards too, and the
 * "+ Custom Theme" card opens a form (name + the 12 palette colors) that
 * saves through the server. Built on the shared `Modal`, which owns the
 * enter/exit animation, Esc/backdrop dismissal, and the focus trap; Esc
 * inside the form steps back to the grid (via `onEscape`).
 */

interface ThemeSelectorModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Active theme id — a built-in ThemeId or a custom theme's file stem. */
  currentTheme: string;
  onSelect: (theme: string) => void;
  /** Custom themes from the server (fetched/refreshed by the caller). */
  customThemes: CustomTheme[];
  /** Persist a new custom theme (server write + list refresh + select). */
  onSaveCustom: (input: CustomThemeInput) => Promise<CustomTheme>;
}

type View = "grid" | "form";

/** The form's color fields, in palette order, with human labels. */
const COLOR_FIELDS: Array<{ slot: keyof ThemeColors; label: string }> = [
  { slot: "surface", label: "page background" },
  { slot: "surfaceSecondary", label: "panels" },
  { slot: "background", label: "inset / wells" },
  { slot: "text", label: "text" },
  { slot: "textMuted", label: "muted text" },
  { slot: "border", label: "borders" },
  { slot: "primary", label: "accent (primary)" },
  { slot: "secondary", label: "secondary" },
  { slot: "accent", label: "accent (alt)" },
  { slot: "success", label: "success" },
  { slot: "danger", label: "danger" },
  { slot: "warning", label: "warning" },
];

export function ThemeSelectorModal({
  isOpen,
  onClose,
  currentTheme,
  onSelect,
  customThemes,
  onSaveCustom,
}: ThemeSelectorModalProps) {
  const [view, setView] = useState<View>("grid");
  const [name, setName] = useState("");
  const [colors, setColors] = useState<ThemeColors>(THEME_COLORS.dark);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Open the form prefilled from the active theme's palette. */
  const openForm = () => {
    const custom = customThemes.find((t) => t.id === currentTheme);
    setColors(custom?.colors ?? THEME_COLORS[resolveThemeId(currentTheme)]);
    setName(custom !== undefined ? custom.name : "");
    setError(null);
    setView("form");
  };

  const submitCustom = () => {
    const trimmed = name.trim();
    if (trimmed.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    onSaveCustom({ name: trimmed, colors })
      .then(() => setView("grid"))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  const selectedCustom = customThemes.find((t) => t.id === currentTheme);

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      title={view === "form" ? "Custom theme" : "Choose a theme"}
      size="lg"
      bodyClassName="unpadded"
      onEscape={() => {
        if (view === "form") {
          setView("grid");
          return true;
        }
      }}
    >
      {view === "form" ? (
        <div className="theme-form">
          <p className="dim">
            Twelve colors make a theme. Saved to <code>~/.config/bai/themes/</code> — it
            appears in this picker on every surface (the TUI's ctrl+t too).
          </p>
          <div className="form-grid">
            <Field label="Name">
              <TextInput
                value={name}
                placeholder="my theme…"
                onChange={(e) => setName(e.target.value)}
                autoFocus={shouldAutoFocus()}
              />
            </Field>
          </div>
          <div className="theme-form-colors">
            {COLOR_FIELDS.map(({ slot, label }) => (
              <Field key={slot} label={label}>
                <ColorInput
                  value={colors[slot]}
                  onChange={(e) => setColors((prev) => ({ ...prev, [slot]: e.target.value }))}
                />
              </Field>
            ))}
          </div>
          {error !== null && <div className="error" role="alert">{error}</div>}
          <div className="theme-form-actions">
            <Button variant="outline" onClick={() => setView("grid")}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={name.trim().length === 0}
              loading={busy}
              onClick={() => void submitCustom()}
            >
              Save theme
            </Button>
          </div>
        </div>
      ) : (
        <div className="theme-grid">
          {THEME_OPTIONS.map((opt) => {
            const colors = THEME_COLORS[opt.value];
            const isSelected = selectedCustom === undefined && opt.value === currentTheme;
            return (
              // @ui-raw: self-contained theme preview card (hardcodes that theme's whole palette inline).
              <button
                key={opt.value}
                type="button"
                data-theme={opt.value}
                className={isSelected ? "theme-card-preview selected" : "theme-card-preview"}
                onClick={() => {
                  onSelect(opt.value);
                  onClose();
                }}
                aria-pressed={isSelected}
                // Every color on the card is hardcoded from THAT theme's
                // palette (germaniii.com's approach) — the card is a
                // self-contained miniature, independent of the currently
                // active theme's CSS variables.
                style={{
                  backgroundColor: colors.surface,
                  border: `1px solid ${colors.border}`,
                }}
              >
                <span className="swatches">
                  <span style={{ backgroundColor: colors.surfaceSecondary }} />
                  <span style={{ backgroundColor: colors.border }} />
                  <span style={{ backgroundColor: colors.success }} />
                  <span style={{ backgroundColor: colors.danger }} />
                </span>
                <span className="theme-name" style={{ color: colors.text }}>
                  {opt.label}
                </span>
                <span className="theme-sample" style={{ color: colors.textMuted }}>
                  Aa
                </span>
                {isSelected && (
                  <span className="theme-check" style={{ backgroundColor: colors.text }}>
                    <Check size={12} style={{ color: colors.surface }} aria-hidden="true" />
                  </span>
                )}
              </button>
            );
          })}
          {customThemes.map((t) => {
            const isSelected = t.id === currentTheme;
            return (
              // @ui-raw: self-contained theme preview card (hardcodes that theme's whole palette inline).
              <button
                key={t.id}
                type="button"
                className={isSelected ? "theme-card-preview selected" : "theme-card-preview"}
                onClick={() => {
                  onSelect(t.id);
                  onClose();
                }}
                aria-pressed={isSelected}
                style={{
                  backgroundColor: t.colors.surface,
                  border: `1px solid ${t.colors.border}`,
                }}
              >
                <span className="swatches">
                  <span style={{ backgroundColor: t.colors.surfaceSecondary }} />
                  <span style={{ backgroundColor: t.colors.border }} />
                  <span style={{ backgroundColor: t.colors.success }} />
                  <span style={{ backgroundColor: t.colors.danger }} />
                </span>
                <span className="theme-name" style={{ color: t.colors.text }}>
                  {t.name}
                </span>
                <span className="theme-sample" style={{ color: t.colors.textMuted }}>
                  Aa
                </span>
                {isSelected && (
                  <span className="theme-check" style={{ backgroundColor: t.colors.text }}>
                    <Check size={12} style={{ color: t.colors.surface }} aria-hidden="true" />
                  </span>
                )}
              </button>
            );
          })}
          {/* @ui-raw: bespoke "add theme" card affordance (no card-shaped button primitive). */}
          <button
            type="button"
            className="theme-card-add"
            onClick={openForm}
            aria-label="Create a custom theme"
          >
            <Plus size={20} aria-hidden="true" />
            <span>Custom Theme</span>
          </button>
        </div>
      )}
    </Modal>
  );
}
