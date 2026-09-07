/**
 * Pure logic for the supermenu — the ctrl+p command palette that replaced
 * the ctrl+** command family. The registry is data-only (no callbacks): the
 * App builds the specs with live context flags, renders them through the
 * palette view, and dispatches a picked id to the same openers the hub
 * chips use. Everything here is pure so the Suggested/grouping/filter math
 * is unit-testable without a terminal (the state/hub.ts pattern).
 *
 * Shape mirrors opencode's command registry (`{ name, title, category,
 * suggested }`): with an empty filter the contextual commands float to the
 * top under a "Suggested" header and the full registry follows, grouped by
 * category in registry order (suggested entries DUPLICATE into their
 * category group — opencode's exact semantics). With a filter the palette
 * is one flat, filtered list.
 */

export type CommandCategory = "Session" | "Model" | "Agent" | "Provider" | "Theme" | "View" | "System";

export interface CommandSpec {
  /** Stable dispatch id — the App's runCommand switch keys on it. */
  id: string;
  title: string;
  category: CommandCategory;
  /** Floats to the "Suggested" section while the filter is empty. */
  suggested?: boolean;
}

/** Context flags the App resolves per render — the Suggested computation. */
export interface CommandContext {
  sessionCount: number;
  hasActiveSession: boolean;
  needsSetup: boolean;
  /** Any non-chat surface (gallery/settings) is open. */
  awayFromChat: boolean;
}

/** The v1 registry, in display order (groups follow this order). */
export function buildCommandSpecs(ctx: CommandContext): CommandSpec[] {
  return [
    { id: "session.switch", title: "Switch session", category: "Session", suggested: ctx.sessionCount > 0 },
    { id: "session.new", title: "New session", category: "Session", suggested: ctx.hasActiveSession },
    { id: "model.switch", title: "Switch model", category: "Model" },
    { id: "provider.connect", title: "Connect provider", category: "Provider", suggested: ctx.needsSetup },
    { id: "agent.switch", title: "Switch agent", category: "Agent" },
    { id: "theme.switch", title: "Switch theme", category: "Theme" },
    { id: "view.gallery", title: "Open gallery", category: "View" },
    { id: "view.settings", title: "Open settings", category: "View" },
    { id: "view.chat", title: "Back to chat", category: "View", suggested: ctx.awayFromChat },
    { id: "app.quit", title: "Quit", category: "System" },
  ];
}

export const SUGGESTED_LABEL = "Suggested";

/**
 * One renderable group of commands; `label: null` is the headerless flat
 * list the filtered palette shows.
 */
export interface PaletteSection {
  label: string | null;
  commands: CommandSpec[];
}

/**
 * The palette's sections for `query`. Empty query: "Suggested" first (when
 * any spec is suggested), then the registry grouped by category — category
 * groups follow registry order and are never merged across a gap. Non-empty
 * query: one flat section filtered by case-insensitive substring match on
 * title, category, or id.
 */
export function paletteSections(specs: CommandSpec[], query: string): PaletteSection[] {
  const trimmed = query.trim().toLowerCase();
  if (trimmed.length > 0) {
    return [
      {
        label: null,
        commands: specs.filter(
          (c) =>
            c.title.toLowerCase().includes(trimmed) ||
            c.category.toLowerCase().includes(trimmed) ||
            c.id.toLowerCase().includes(trimmed),
        ),
      },
    ];
  }
  const groups: PaletteSection[] = [];
  for (const spec of specs) {
    const last = groups[groups.length - 1];
    if (last !== undefined && last.label === spec.category) last.commands.push(spec);
    else groups.push({ label: spec.category, commands: [spec] });
  }
  const suggested = specs.filter((c) => c.suggested === true);
  if (suggested.length === 0) return groups;
  return [{ label: SUGGESTED_LABEL, commands: suggested }, ...groups];
}

/**
 * Navigation order across sections — the flat list the cursor walks and the
 * sliding window indexes. Section headers render above the row that opens
 * their group, derived from this flattening.
 */
export function flattenSections(sections: PaletteSection[]): CommandSpec[] {
  return sections.flatMap((s) => s.commands);
}
