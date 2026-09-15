/**
 * Shared editor/terminal font config — one source of truth for Monaco and
 * xterm, so the code surfaces can never drift from each other.
 *
 * The family mirrors the `--font-mono` token in styles.css (JetBrains Mono
 * Variable, self-hosted via fonts.css). Monaco and xterm take concrete
 * strings, not CSS variables, so the stack is duplicated here deliberately —
 * keep the two in sync.
 *
 * Size is the `--text-md` step (13px) of the type scale: the dense-body size
 * the rest of the UI uses for controls and code.
 */

/** JetBrains Mono first, then the system mono fallbacks (matches --font-mono). */
export const EDITOR_FONT_FAMILY =
  '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';

/** Editor/terminal font size in px (the --text-md step). */
export const EDITOR_FONT_SIZE = 13;
