import type { MediaProviderInfo, ProviderInfo, ProviderListResponse, RemoteModelInfo } from "@bai/shared";
import type { ComboboxOption } from "./components";

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

/**
 * Model-override combobox options: every model across CONNECTED providers,
 * id-valued with a provider + context/price hint (the Image/Video Gen model
 * selectors' stance). Providers hidden from the pickers
 * (`config.providers[id].hidden`) are excluded. An explicit empty option
 * resets to the inherited model.
 */
export function modelOverrideOptions(list: ProviderListResponse | null): ComboboxOption[] {
  const empty: ComboboxOption = { value: "", label: "(agent/session model)", hint: "no override — inherit" };
  if (list === null) return [empty];
  const models = sortProviders(list.providers.filter((p) => p.connected && p.hidden !== true)).flatMap((p) =>
    p.models.map((m) => {
      const parts: string[] = [p.name];
      if (m.contextWindow !== undefined) parts.push(`${Math.round(m.contextWindow / 1000)}k ctx`);
      if (m.inputCost !== undefined) parts.push(`$${m.inputCost}/1M`);
      return { value: m.id, label: m.id, hint: parts.join(" · ") };
    }),
  );
  return [empty, ...models];
}

/**
 * Fetched-model selection helpers for the custom-provider form (pure, so the
 * checkbox mechanics are unit-testable without rendering).
 */

/**
 * Slug for a config-defined custom provider id, derived from its display
 * name ("My Gateway" → "my-gateway"). Mirrors `slugifyThemeId` (@bai/shared).
 * Empty when the name has no slug-worthy characters.
 */
export function slugifyProviderId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/**
 * Extra-headers key/value rows (custom-provider + provider-file forms):
 * the editor state is a list so rows can be added/removed individually.
 */
export interface HeaderRow {
  key: string;
  value: string;
}

/** Header map → editable rows (edit forms). */
export function headerRowsFrom(headers: Record<string, string> | undefined): HeaderRow[] {
  if (headers === undefined) return [];
  return Object.entries(headers).map(([key, value]) => ({ key, value }));
}

/** Editable rows → header map; blank keys skipped, later keys win. */
export function headersFromRows(rows: HeaderRow[]): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (key.length === 0) continue;
    out[key] = row.value.trim();
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Combobox options for the providers that can actually generate a given
 * modality — the image/video workbench registries (built-in adapters +
 * provider files), never the whole LLM catalog. Shared by the Default model
 * dropdown and the media-provider key manager so both offer the same set.
 */
export function mediaProviderOptions(
  providers: ReadonlyArray<Pick<MediaProviderInfo, "id" | "label">>,
): ComboboxOption[] {
  return providers
    .map((p) => ({ value: p.id, label: p.label }))
    .sort((a, b) => a.value.localeCompare(b.value));
}

/**
 * Starter JSON for a provider file's `video` block — a minimal but complete
 * `videoSpecSchema` (generic template, one t2v model). Pure + exported so the
 * editor's default is unit-tested against the real schema.
 */
export function videoStarter(): string {
  return JSON.stringify(
    {
      template: "generic",
      defaultModel: "my-video-model",
      models: [{ id: "my-video-model", workflows: ["t2v"] }],
      generate: {
        method: "POST",
        path: "/v1/videos",
        contentType: "json",
        body: { prompt: "$prompt", model: "$model" },
      },
      response: { videos: "data[*]", url: "url", mime: "mime_type" },
    },
    null,
    2,
  );
}

/** Strip the "provider/" prefix from a catalog model id (edit-form init). */
export function stripProviderPrefix(providerId: string, modelId: string): string {
  const prefix = `${providerId}/`;
  return modelId.startsWith(prefix) ? modelId.slice(prefix.length) : modelId;
}

/** Toggle one id in a selection (preserves order, never dupes). */
export function toggleModelSelection(selected: string[], id: string, on: boolean): string[] {
  if (on) return selected.includes(id) ? selected : [...selected, id];
  return selected.filter((m) => m !== id);
}

/**
 * Union of the existing selection with freshly fetched ids — every fetched
 * model arrives pre-selected; previously selected ids (e.g. from an earlier
 * fetch) are preserved.
 */
export function mergeModelSelection(existing: string[], fetched: RemoteModelInfo[]): string[] {
  const out = [...existing];
  for (const m of fetched) {
    if (!out.includes(m.id)) out.push(m.id);
  }
  return out;
}

/**
 * Rows for the fetched-models checkbox list: every fetched model, plus any
 * already-selected id the endpoint didn't return (so a selection is never
 * silently dropped from view).
 */
export function modelSelectionRows(available: RemoteModelInfo[], selected: string[]): RemoteModelInfo[] {
  const ids = new Set(available.map((m) => m.id));
  return [...available, ...selected.filter((id) => !ids.has(id)).map((id) => ({ id }))];
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
    if (p.custom === true || p.source === "config" || p.source === "file") custom.push(p);
    else if (oauthSet.has(p.id)) oauth.push(p);
    else catalog.push(p);
  }
  return { custom, oauth, catalog };
}

