import { useState, type ReactNode } from "react";
import { useCoarsePointer } from "../pointer";

/**
 * Mobile key bar for the shell (and any future terminal surfaces).
 *
 * A horizontal strip of the keys mobile keyboards don't expose: Esc, Tab,
 * Ctrl, arrows, `/`, `-`, `|`, Enter, Backspace. Sticky toggles (Ctrl / Esc)
 * latch until the next keypress so multi-key sequences (`Ctrl+C`) work with
 * one thumb.
 *
 * Hidden on fine pointers via CSS (`.key-bar { display: none }` under
 * `@media (hover: hover) and (pointer: fine)`); always rendered so the DOM
 * is stable. Heights/radii come from design tokens; each key clears 44px.
 *
 * Emits raw terminal bytes via `onKey` (same contract as xterm's `onData`).
 */
export function KeyBar({ onKey, disabled = false }: { onKey: (data: string) => void; disabled?: boolean }): ReactNode {
  const coarse = useCoarsePointer();
  const [ctrl, setCtrl] = useState(false);
  const [esc, setEsc] = useState(false);

  const send = (raw: string): void => {
    if (disabled) return;
    onKey(raw);
    // Sticky modifiers release after the next key (or immediately for Esc
    // when it was a one-shot).
    if (ctrl) setCtrl(false);
    if (esc) setEsc(false);
  };

  const withMods = (ch: string): string => {
    if (ctrl) {
      // Ctrl+letter → ASCII control code (Ctrl+C = 0x03).
      const code = ch.toUpperCase().charCodeAt(0);
      if (code >= 64 && code < 96) return String.fromCharCode(code - 64);
      if (ch === "[") return "\x1b"; // Ctrl+[
      if (ch === "\\") return "\x1c";
      if (ch === "]") return "\x1d";
      if (ch === "?") return "\x7f";
    }
    return ch;
  };

  const keys: Array<{ label: string; title: string; run: () => void; active?: boolean }> = [
    {
      label: "Esc",
      title: "Escape",
      active: esc,
      run: () => (esc && !ctrl ? send("\x1b") : setEsc((v) => !v)),
    },
    { label: "Tab", title: "Tab", run: () => send(withMods("\t")) },
    { label: "Ctrl", title: "Control (sticky)", active: ctrl, run: () => setCtrl((v) => !v) },
    { label: "↑", title: "Up", run: () => send("\x1b[A") },
    { label: "↓", title: "Down", run: () => send("\x1b[B") },
    { label: "/", title: "Slash", run: () => send(withMods("/")) },
    { label: "-", title: "Dash", run: () => send(withMods("-")) },
    { label: "|", title: "Pipe", run: () => send(withMods("|")) },
    { label: "⏎", title: "Enter", run: () => send("\r") },
    { label: "⌫", title: "Backspace", run: () => send("\x7f") },
  ];

  return (
    <div className="key-bar" role="toolbar" aria-label="Terminal keys" data-coarse={coarse ? "1" : "0"}>
      {keys.map((k) => (
        <button
          key={k.label}
          type="button"
          className={k.active === true ? "key-bar-key active" : "key-bar-key"}
          aria-pressed={k.active === true ? true : undefined}
          title={k.title}
          disabled={disabled}
          onClick={k.run}
        >
          {k.label}
        </button>
      ))}
    </div>
  );
}
