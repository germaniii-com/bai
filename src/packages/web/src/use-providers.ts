import { useCallback, useEffect, useRef, useState } from "react";
import { followGlobal, type BaiClient } from "@bai/api/client";
import type { ProviderListResponse } from "@bai/shared";

/**
 * Providers/config state + live refresh — ON DEMAND. The full list (200+
 * providers, thousands of models) is not fetched at startup; `ensure()`
 * loads it on first provider-UI engagement (settings view, model picker).
 * Afterwards the firehose keeps it live: account or config changes from ANY
 * surface (TUI ctrl+p, another browser, the phone) arrive as
 * provider.updated / config.updated and re-render here — no restart, no
 * manual refresh.
 */
export function useProviders(client: BaiClient): {
  list: ProviderListResponse | null;
  refresh: () => Promise<void>;
  /** Fetch on first engagement; no-op once loaded. */
  ensure: () => Promise<void>;
} {
  const [list, setList] = useState<ProviderListResponse | null>(null);
  const loadedRef = useRef(false);
  loadedRef.current = list !== null;

  const refresh = useCallback(async () => {
    try {
      setList(await client.providers());
    } catch {
      // Advisory state; the settings view surfaces errors on mutation.
    }
  }, [client]);

  const ensure = useCallback(async () => {
    if (loadedRef.current) return;
    await refresh();
  }, [refresh]);

  useEffect(() => {
    const ctrl = new AbortController();
    void followGlobal(client, {
      signal: ctrl.signal,
      onEvent: (evt) => {
        if (evt.type === "provider.updated" || evt.type === "config.updated") {
          // On-demand: keep the list fresh only once it has been loaded.
          if (loadedRef.current) void refresh();
        }
      },
    });
    return () => ctrl.abort();
  }, [client, refresh]);

  return { list, refresh, ensure };
}
