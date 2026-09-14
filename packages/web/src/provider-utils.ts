import type { ProviderInfo } from "@bai/shared";

/**
 * Provider-list helpers shared by the settings panes and the model picker —
 * one sort stance everywhere: connected first (stable), the echo stub last,
 * then alphabetical by id (the TUI picker's stance, tui/state/providers.ts).
 */

/** Connected first, stub last, then alphabetical by id (deterministic). */
export function sortProviders(providers: ProviderInfo[]): ProviderInfo[] {
  return [...providers].sort((a, b) => {
    const ac = a.connected ? 0 : 1;
    const bc = b.connected ? 0 : 1;
    if (ac !== bc) return ac - bc;
    if (a.id === "stub") return 1;
    if (b.id === "stub") return -1;
    return a.id.localeCompare(b.id);
  });
}

/**
 * The Model Providers page's three sections. A provider is:
 *  - `custom` when it is a user config-defined endpoint (`source === "config"`);
 *  - `oauth` when the OAuth catalog knows it (and it isn't custom);
 *  - `catalog` otherwise (models.dev ⊕ curated overlay).
 *
 * Custom wins over OAuth so a user endpoint with an OAuth-capable id is not
 * duplicated. Input order is preserved (callers pass a sorted list).
 */
export interface ProviderPartition {
  custom: ProviderInfo[];
  oauth: ProviderInfo[];
  catalog: ProviderInfo[];
}

export function partitionProviders(
  providers: ProviderInfo[],
  oauthIds: Iterable<string>,
): ProviderPartition {
  const oauthSet = new Set(oauthIds);
  const custom: ProviderInfo[] = [];
  const oauth: ProviderInfo[] = [];
  const catalog: ProviderInfo[] = [];
  for (const p of providers) {
    if (p.custom === true || p.source === "config") custom.push(p);
    else if (oauthSet.has(p.id)) oauth.push(p);
    else catalog.push(p);
  }
  return { custom, oauth, catalog };
}

