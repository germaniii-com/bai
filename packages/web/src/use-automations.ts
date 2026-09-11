import { useCallback, useEffect, useState } from "react";
import type { BaiClient } from "@bai/api/client";
import type { Automation } from "@bai/shared";

/**
 * Automations list state. Refresh is explicit — the App calls it on section
 * engagement, on `automations.updated` firehose events, and on reconnect
 * healing — so scheduled-job data flows independently of the other catalogs.
 */
export function useAutomations(client: BaiClient): {
  automations: Automation[];
  refresh: () => Promise<void>;
} {
  const [automations, setAutomations] = useState<Automation[]>([]);

  const refresh = useCallback(async () => {
    try {
      setAutomations(await client.listAutomations());
    } catch {
      // Advisory state; the editor surfaces mutation errors itself.
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { automations, refresh };
}
