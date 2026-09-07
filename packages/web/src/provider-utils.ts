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
