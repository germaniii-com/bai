import { useCallback, useEffect, useState } from "react";
import type { BaiClient } from "@bai/api/client";
import type { UsageAnalyticsQuery, UsageAnalyticsResponse } from "@bai/shared";

/**
 * Usage analytics state (D26 data). Unlike the catalogs, the query is part
 * of the state — the Analytics pane's filters and granularity re-fetch
 * server-side by changing it. Refresh is explicit (section engagement,
 * reconnect healing, manual re-run); analytics is read-only, so no firehose
 * event drives it.
 */
export function useUsage(
  client: BaiClient,
  query: UsageAnalyticsQuery,
): {
  usage: UsageAnalyticsResponse | null;
  refreshing: boolean;
  refresh: () => Promise<void>;
} {
  const [usage, setUsage] = useState<UsageAnalyticsResponse | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      setUsage(await client.usageAnalytics(query));
    } catch {
      // Advisory state — the pane renders its empty/error stance.
    } finally {
      setRefreshing(false);
    }
  }, [client, query]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { usage, refreshing, refresh };
}
