import { useCallback, useEffect, useState } from "react";
import { followGlobal, type BaiClient } from "@bai/api/client";
import type { ProviderListResponse } from "@bai/shared";

/**
 * Providers/config state + live refresh. Account or config changes from ANY
 * surface (TUI ctrl+p, another browser, the phone) arrive as
 * provider.updated / config.updated on the firehose and re-render here —
 * no restart, no manual refresh.
 */
export function useProviders(client: BaiClient): {
  list: ProviderListResponse | null;
  refresh: () => Promise<void>;
} {
  const [list, setList] = useState<ProviderListResponse | null>(null);

  const refresh = useCallback(async () => {
    try {
      setList(await client.providers());
    } catch {
      // Advisory state; the settings view surfaces errors on mutation.
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const ctrl = new AbortController();
    void followGlobal(client, {
      signal: ctrl.signal,
      onEvent: (evt) => {
        if (evt.type === "provider.updated" || evt.type === "config.updated") void refresh();
      },
    });
    return () => ctrl.abort();
  }, [client, refresh]);

  return { list, refresh };
}
