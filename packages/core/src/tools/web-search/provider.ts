/**
 * Pluggable web-search providers (hermes's WebSearchProvider ABC, TS-shaped).
 *
 * Contract (hermes parity): search() NEVER throws — failures come back as
 * `{success: false, error}` so the tool can surface them as model-facing
 * error results and the selection ladder can fall back. `isAvailable()`
 * must not perform network I/O (it runs at registration time).
 */

export interface SearchResult {
  title: string;
  url: string;
  description: string;
}

export type SearchOutcome = { success: true; results: SearchResult[] } | { success: false; error: string };

export interface WebSearchProvider {
  /** Stable id ("ddgs", "exa") — the config `tools.webSearch.provider` key. */
  name: string;
  /** Availability probe (module/env presence — NO network I/O). */
  isAvailable(): boolean;
  /** Human-facing note for error messages (e.g. setup hints). */
  note(): string;
  search(query: string, limit: number): Promise<SearchOutcome>;
}
