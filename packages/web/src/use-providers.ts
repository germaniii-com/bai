import { useCallback, useEffect, useRef, useState } from "react";
import { eventMux, type BaiClient } from "@bai/api/client";
import type { ProviderListResponse } from "@bai/shared";

/**
 * Providers/config state + live refresh — ON DEMAND, refetch on engagement.
 * The full list (200+ providers, thousands of models) is never fetched at
 * startup. Every engagement with the provider UI (settings view, model
 * picker) refetches — mirroring the TUI's ctrl+p — and `fetching` reports
 * when a fetch is in flight so surfaces can show an updating hint.
 * Between engagements the shared firehose mux keeps a loaded list live:
 * account or config changes from ANY surface (TUI ctrl+p, another browser,
 * the phone) arrive as provider.updated / config.updated and re-render here
 * — no restart, no manual refresh.
 */
export function useProviders(client: BaiClient): {
  list: ProviderListResponse | null;
  refresh: () => Promise<void>;
  /** True while a provider-list fetch is in flight. */
  fetching: boolean;
} {
  const [list, setList] = useState<ProviderListResponse | null>(null);
  const [fetching, setFetching] = useState(false);
  const loadedRef = useRef(false);
  loadedRef.current = list !== null;

  const refresh = useCallback(async () => {
    setFetching(true);
    try {
      setList(await client.providers());
    } catch {
      // Advisory state; the settings view surfaces errors on mutation.
    } finally {
      setFetching(false);
    }
  }, [client]);

  useEffect(() => {
    // The shared firehose mux (one global SSE connection for the whole
    // page) — this hook used to open its own duplicate connection.
    const unsubscribe = eventMux(client).subscribe((evt) => {
      if (evt.type === "provider.updated" || evt.type === "config.updated") {
        // On-demand: keep the list fresh only once it has been loaded.
        if (loadedRef.current) void refresh();
      }
    });
    return unsubscribe;
  }, [client, refresh]);

  return { list, refresh, fetching };
}
