import { useEffect, useState } from "react";
import type { BaiClient } from "@bai/api/client";

/**
 * Fetch a video asset's generated first-frame poster (server-extracted by the
 * job queue) and return an object URL. Gallery cards show this still image —
 * the `<video>` element is only created inside the full-screen modal, so a
 * dense gallery never downloads or decodes whole clips.
 *
 * `enabled` gates the fetch (cards call it only once they scroll into view);
 * the request is aborted on unmount / disable.
 */
export function useVideoPoster(
  client: BaiClient,
  assetId: string,
  enabled: boolean,
  hasPoster: boolean,
): string | undefined {
  const [url, setUrl] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!enabled || !hasPoster) {
      setUrl(undefined);
      return;
    }
    let active = true;
    let created: string | undefined;
    const ctrl = new AbortController();
    void client
      .assetPoster(assetId, { signal: ctrl.signal })
      .then(async (res) => {
        const blob = await res.blob();
        if (!active) return;
        created = URL.createObjectURL(blob);
        setUrl(created);
      })
      .catch(() => {
        // No poster (or aborted) — the card shows a placeholder.
      });
    return () => {
      active = false;
      ctrl.abort();
      if (created !== undefined) URL.revokeObjectURL(created);
    };
  }, [client, assetId, enabled, hasPoster]);
  return url;
}
