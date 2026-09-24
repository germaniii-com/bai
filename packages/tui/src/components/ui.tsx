import { Box, Text, type BoxProps } from "ink";
import type { ReactNode } from "react";
import { useTheme, type TuiTheme } from "../theme";

/**
 * Shared TUI chrome — the terminal counterpart of the web's component library
 * (docs/DESIGN-SYSTEM.md §8 "TUI mapping"). Every bordered surface, list row,
 * hint line, and empty state goes through these so the elevation triad
 * (`panel` raised / `inset` recessed), selection bar, and typography stay
 * uniform instead of being re-hand-rolled per view.
 */

/** Semantic tone for a surface's border/title (maps to a theme role). */
export type Tone = "border" | "accent" | "success" | "warning" | "danger" | "secondary";

function toneColor(t: TuiTheme, tone: Tone): string {
  switch (tone) {
    case "accent":
      return t.accent;
    case "success":
      return t.success;
    case "warning":
      return t.warning;
    case "danger":
      return t.danger;
    case "secondary":
      return t.secondary;
    case "border":
    default:
      return t.border;
  }
}

/**
 * The one bordered surface: a square-bordered panel on the raised `panel` tone with a
 * tone-colored border and an optional bold title + dim suffix + hint footer.
 * Panels float over the live view (transparent backdrop) — the raised tone is
 * what lifts them off the page, since Ink has no shadows.
 */
export function Panel({
  title,
  titleSuffix,
  tone = "border",
  titleTone,
  hint,
  paddingX = 1,
  children,
  ...boxProps
}: {
  title?: ReactNode;
  /** Dim inline text after the title (counts, state, key hints). */
  titleSuffix?: ReactNode;
  /** Border color role. */
  tone?: Tone;
  /** Title color role (defaults to `tone` — e.g. accent titles on neutral panels). */
  titleTone?: Tone;
  /** Standard dim hint line rendered after the children. */
  hint?: ReactNode;
  /** Horizontal inner padding (default 1, matching the old chrome). */
  paddingX?: number;
  children?: ReactNode;
} & BoxProps) {
  const t = useTheme();
  const color = toneColor(t, tone);
  const heading = toneColor(t, titleTone ?? tone);
  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={color}
      borderBackgroundColor={t.panel}
      backgroundColor={t.panel}
      paddingX={paddingX}
      {...boxProps}
    >
      {title !== undefined && (
        <Text wrap="truncate">
          <Text bold color={heading}>
            {title}
          </Text>
          {titleSuffix !== undefined && <Text color={t.dim}> {titleSuffix}</Text>}
        </Text>
      )}
      {children}
      {hint !== undefined && <HintRow>{hint}</HintRow>}
    </Box>
  );
}

/**
 * One list row: a full-width `selection`-tinted bar when highlighted, a `❯`
 * cursor, and dim trailing meta. `gutter`/`badge` are the leading/trailing
 * status columns (e.g. `✓` active, `△ 2` pending asks).
 */
export function ListRow({
  selected = false,
  gutter,
  badge,
  hint,
  children,
  ...boxProps
}: {
  selected?: boolean;
  /** Leading status glyph column (colored success). */
  gutter?: ReactNode;
  /** Trailing status text (colored warning). */
  badge?: ReactNode;
  /** Dim trailing meta (kept dim even when selected). */
  hint?: ReactNode;
  children: ReactNode;
} & BoxProps) {
  const t = useTheme();
  return (
    <Box
      width="100%"
      flexShrink={0}
      backgroundColor={selected ? t.selection : undefined}
      {...boxProps}
    >
      <Text wrap="truncate" color={selected ? t.accent : t.text}>
        {selected ? "❯ " : "  "}
        {gutter !== undefined ? <Text color={t.success}>{gutter} </Text> : null}
        {children}
        {badge !== undefined ? <Text color={t.warning}> {badge}</Text> : null}
        {hint !== undefined ? <Text color={t.dim}> {hint}</Text> : null}
      </Text>
    </Box>
  );
}

/** A standard dim, truncating hint line (the `·`-joined key guide). */
export function HintRow({ children }: { children: ReactNode }) {
  const t = useTheme();
  return (
    <Text color={t.dim} wrap="truncate">
      {children}
    </Text>
  );
}

/**
 * A calm centered empty state for a whole view/panel: a title, a dim body
 * line, and an optional dim hint line.
 */
export function EmptyState({
  title,
  body,
  hints,
}: {
  title?: ReactNode;
  body?: ReactNode;
  hints?: ReactNode;
}) {
  const t = useTheme();
  return (
    <Box flexDirection="column" justifyContent="center" alignItems="center" flexGrow={1}>
      {title !== undefined && (
        <Text bold color={t.text}>
          {title}
        </Text>
      )}
      {body !== undefined && (
        <Text color={t.dim} wrap="wrap">
          {body}
        </Text>
      )}
      {hints !== undefined && (
        <Text color={t.dim} wrap="wrap">
          {hints}
        </Text>
      )}
    </Box>
  );
}
