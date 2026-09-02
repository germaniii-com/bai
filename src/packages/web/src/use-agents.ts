import { useCallback, useEffect, useState } from "react";
import type { BaiClient } from "@bai/api/client";
import type { AgentInfo } from "@bai/shared";

/**
 * Agents list state. Refresh is explicit — the App calls it on section
 * engagement, on `agents.updated` firehose events, and on reconnect
 * healing — so agent data flows independently of tools.
 */
export function useAgents(client: BaiClient): {
  agents: AgentInfo[];
  refresh: () => Promise<void>;
} {
  const [agents, setAgents] = useState<AgentInfo[]>([]);

  const refresh = useCallback(async () => {
    try {
      setAgents(await client.listAgents());
    } catch {
      // Advisory state; the editor surfaces mutation errors itself.
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { agents, refresh };
}
