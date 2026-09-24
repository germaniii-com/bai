/**
 * The web nav rail's items — the single source of truth shared by the rail
 * (App's MasterNav), the basic/advanced gating, and the Settings → General
 * per-item visibility list (config `ui.hiddenNav`).
 *
 * Settings and the Theme button are always-visible utilities and are not
 * listed here (Settings hosts the control, so it can never hide itself).
 */
export interface NavItemDef {
  /** Section id — matches App's `Section` (and the route). */
  id: string;
  label: string;
  /** Only shown when `ui.advancedMode` is on. */
  advanced: boolean;
}

/** Canonical rail order. */
export const NAV_ITEMS: NavItemDef[] = [
  { id: "chat", label: "Chat", advanced: false },
  { id: "workspace", label: "Workspace", advanced: false },
  { id: "image", label: "Image Gen", advanced: false },
  { id: "video", label: "Video Gen", advanced: false },
  { id: "agents", label: "Agents", advanced: true },
  { id: "tools", label: "Tools", advanced: true },
  { id: "skills", label: "Skills", advanced: true },
  { id: "automations", label: "Automations", advanced: true },
  { id: "analytics", label: "Analytics", advanced: true },
  { id: "shell", label: "Shell", advanced: true },
];

/** Ids of the advanced-only items (drives the rail divider + basic gating). */
export const ADVANCED_NAV_IDS: string[] = NAV_ITEMS.filter((i) => i.advanced).map((i) => i.id);

/**
 * The ids visible for a mode + hidden set. `advanced` items require advanced
 * mode; anything in `hiddenNav` is dropped.
 */
export function visibleNavIds(advanced: boolean, hiddenNav: readonly string[] = []): Set<string> {
  const hidden = new Set(hiddenNav);
  return new Set(
    NAV_ITEMS.filter((item) => (!item.advanced || advanced) && !hidden.has(item.id)).map((item) => item.id),
  );
}
