import { useCallback, useEffect, useState } from "react";
import type { BaiClient } from "@bai/api/client";
import type { ToolListEntry } from "@bai/shared";

/**
 * Tools list state. Refresh is explicit — the App calls it on section
 * engagement, on `tools.updated` firehose events, and on reconnect
 * healing — so tool data flows independently of agents.
 */
export function useTools(client: BaiClient): {
  tools: ToolListEntry[];
  refresh: () => Promise<void>;
} {
  const [tools, setTools] = useState<ToolListEntry[]>([]);

  const refresh = useCallback(async () => {
    try {
      setTools(await client.listTools());
    } catch {
      // Advisory state; the editor surfaces mutation errors itself.
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { tools, refresh };
}
