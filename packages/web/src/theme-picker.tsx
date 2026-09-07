import { useEffect, useRef, useState } from "react";
import { Check, X } from "lucide-react";
import { THEME_COLORS, THEME_OPTIONS, type ThemeId } from "@bai/shared";

/**
 * Theme selector modal (germaniii.com's ThemeSelectorModal): a grid of
 * preview cards, each scoped with [data-theme] so the CSS variables inside
 * render that theme's palette — a live miniature of the real UI. Phase-based
 * enter/exit animation (timeout-driven so reduced-motion never wedges the
 * phase machine), esc and click-outside to dismiss.
 */

interface ThemeSelectorModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentTheme: ThemeId;
  onSelect: (theme: ThemeId) => void;
}

type Phase = "hidden" | "entering" | "visible" | "exiting";

const ENTER_MS = 200;
const EXIT_MS = 150;

export function ThemeSelectorModal({
  isOpen,
  onClose,
  currentTheme,
  onSelect,
}: ThemeSelectorModalProps) {
  const [phase, setPhase] = useState<Phase>("hidden");
  // Ref-held close callback: the timers below key on `phase` only, so a
  // parent re-render (new inline onClose identity) can't cancel a pending
  // transition.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

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
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [phase, onClose]);

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

  return (
    <>
      <div className="modal-overlay" onClick={onClose} />
      <div
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
            <h3>Choose a theme</h3>
            <button className="modal-close" onClick={onClose} aria-label="Close theme selector">
              <X size={18} aria-hidden="true" />
            </button>
          </div>
          <div className="theme-grid">
            {THEME_OPTIONS.map((opt) => {
              const colors = THEME_COLORS[opt.value];
              const isSelected = opt.value === currentTheme;
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
          </div>
        </div>
      </div>
    </>
  );
}
