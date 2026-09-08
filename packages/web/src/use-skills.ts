import { useCallback, useEffect, useState } from "react";
import type { BaiClient } from "@bai/api/client";
import type { SkillInfo } from "@bai/shared";

/**
 * Skills list state. Refresh is explicit — the App calls it on section
 * engagement, on `skills.updated` firehose events, and on reconnect
 * healing — so skill data flows independently of agents/tools.
 */
export function useSkills(client: BaiClient): {
  skills: SkillInfo[];
  refresh: () => Promise<void>;
} {
  const [skills, setSkills] = useState<SkillInfo[]>([]);

  const refresh = useCallback(async () => {
    try {
      setSkills(await client.listSkills());
    } catch {
      // Advisory state; the editor surfaces mutation errors itself.
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { skills, refresh };
}
