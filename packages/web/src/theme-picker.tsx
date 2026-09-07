import { useEffect, useRef, useState } from "react";
import { Check, Plus, X } from "lucide-react";
import {
  THEME_COLORS,
  THEME_OPTIONS,
  resolveThemeId,
  type CustomTheme,
  type CustomThemeInput,
  type ThemeColors,
} from "@bai/shared";
import { IconButton, useDialogFocus } from "./ui";

/**
 * Theme selector modal (germaniii.com's ThemeSelectorModal): a grid of
 * preview cards, each hardcoded inline from that theme's own palette — a
 * self-contained miniature independent of the active theme's variables.
 * Custom themes (~/.config/bai/themes/*.json) render as cards too, and the
 * "+ Custom Theme" card opens a form (name + the 12 palette colors) that
 * saves through the server. Phase-based enter/exit animation (timeout-driven
 * so reduced-motion never wedges the phase machine), esc and click-outside
 * to dismiss.
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

type Phase = "hidden" | "entering" | "visible" | "exiting";
type View = "grid" | "form";

const ENTER_MS = 200;
const EXIT_MS = 150;

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
  const [phase, setPhase] = useState<Phase>("hidden");
  const [view, setView] = useState<View>("grid");
  const [name, setName] = useState("");
  const [colors, setColors] = useState<ThemeColors>(THEME_COLORS.dark);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Ref-held close callback: the timers below key on `phase` only, so a
  // parent re-render (new inline onClose identity) can't cancel a pending
  // transition.
  const onCloseRef = useRef(onClose);
  const dialogRef = useRef<HTMLDivElement>(null);
  onCloseRef.current = onClose;
  useDialogFocus(phase !== "hidden", dialogRef);

  // open → entering (the entering effect below carries the timer).
  useEffect(() => {
    if (isOpen && phase === "hidden") setPhase("entering");
  }, [isOpen, phase]);

  // entering → visible after the enter animation window.
  useEffect(() => {
    if (phase !== "entering") return;
    const timer = setTimeout(() => setPhase("visible"), ENTER_MS);
    return () => clearTimeout(timer);
  }, [phase]);

  // close → exiting (the exiting effect below carries the timer).
  useEffect(() => {
    if (!isOpen && (phase === "visible" || phase === "entering")) setPhase("exiting");
  }, [isOpen, phase]);

  // exiting → hidden + report closed after the exit animation window.
  useEffect(() => {
    if (phase !== "exiting") return;
    const timer = setTimeout(() => {
      setPhase("hidden");
      onCloseRef.current();
    }, EXIT_MS);
    return () => clearTimeout(timer);
  }, [phase]);

  useEffect(() => {
    if (phase !== "exiting" && phase !== "visible") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Inside the form esc steps back to the grid; only the grid closes.
      if (view === "form") setView("grid");
      else onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [phase, view, onClose]);

  useEffect(() => {
    if (phase === "hidden") {
      document.body.style.overflow = "";
    } else {
      document.body.style.overflow = "hidden";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [phase]);

  if (phase === "hidden") return null;

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
    <>
      <div className="modal-overlay" onClick={onClose} />
      <div
        ref={dialogRef}
        tabIndex={-1}
        className={
          phase === "entering"
            ? "theme-modal-wrap entering"
            : phase === "exiting"
              ? "theme-modal-wrap exiting"
              : "theme-modal-wrap"
        }
        role="dialog"
        aria-modal="true"
        aria-label="Choose a theme"
      >
        <div className="theme-modal">
          <div className="model-modal-head">
            <h3>{view === "form" ? "Custom theme" : "Choose a theme"}</h3>
             <IconButton
               className="modal-close"
               hint={view === "form" ? "Back to themes" : "Close theme selector"}
               label={view === "form" ? "Back to themes" : "Close theme selector"}
               onClick={() => (view === "form" ? setView("grid") : onClose())}
             >
               <X size={18} aria-hidden="true" />
             </IconButton>
          </div>

          {view === "form" ? (
            <div className="theme-form">
              <p className="dim">
                Twelve colors make a theme. Saved to <code>~/.config/bai/themes/</code> — it
                appears in this picker on every surface (the TUI's ctrl+t too).
              </p>
              <div className="form-grid">
                <label>
                  name
                  <input
                    value={name}
                    placeholder="my theme…"
                    onChange={(e) => setName(e.target.value)}
                    autoFocus
                  />
                </label>
              </div>
              <div className="theme-form-colors">
                {COLOR_FIELDS.map(({ slot, label }) => (
                  <label key={slot}>
                    {label}
                    <input
                      type="color"
                      value={colors[slot]}
                      onChange={(e) => setColors((prev) => ({ ...prev, [slot]: e.target.value }))}
                    />
                  </label>
                ))}
              </div>
               {error !== null && <div className="error" role="alert">{error}</div>}
              <div className="theme-form-actions">
                <button type="button" className="theme-form-cancel" onClick={() => setView("grid")}>
                  cancel
                </button>
                <button
                  type="button"
                  className="theme-form-save"
                  disabled={name.trim().length === 0 || busy}
                  onClick={() => void submitCustom()}
                >
                  {busy ? "saving…" : "save theme"}
                </button>
              </div>
            </div>
          ) : (
            <div className="theme-grid">
              {THEME_OPTIONS.map((opt) => {
                const colors = THEME_COLORS[opt.value];
                const isSelected = selectedCustom === undefined && opt.value === currentTheme;
                return (
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
        </div>
      </div>
    </>
  );
}
