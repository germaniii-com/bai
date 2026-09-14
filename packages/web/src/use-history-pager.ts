import { useCallback, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { BaiClient } from "@bai/api/client";
import type { Message } from "@bai/shared";

/**
 * Scroll-back paging for a session transcript (TUI parity: newest window
 * first, older pages load on demand). The caller owns `messages` (so live
 * stream events keep working through its own reducer); this hook owns the
 * older-page cursor, `hasMore`, and the in-flight guard.
 *
 * `seed` is called after the initial snapshot; `loadOlder` prepends the next
 * older page (deduped by id). Refs back the async read so a stale response
 * after a session switch is dropped, and `loadOlder` stays referentially
 * stable (safe in effect deps).
 */
export interface HistoryPager {
  hasMore: boolean;
  loadingOlder: boolean;
  loadOlder: () => void;
  seed: (hasMore: boolean, nextCursor: string | null) => void;
  reset: () => void;
}

export function useHistoryPager(opts: {
  client: BaiClient;
  sessionId: string | undefined;
  setMessages: Dispatch<SetStateAction<Message[]>>;
  /** Messages per page (initial snapshot uses this too). Default 100. */
  pageSize?: number;
}): HistoryPager {
  const { client, sessionId, setMessages } = opts;
  const pageSize = opts.pageSize ?? 100;
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const cursorRef = useRef<string | null>(null);
  const hasMoreRef = useRef(false);
  const loadingRef = useRef(false);
  const sessionRef = useRef<string | undefined>(sessionId);
  sessionRef.current = sessionId;

  const seed = useCallback((more: boolean, nextCursor: string | null) => {
    cursorRef.current = nextCursor;
    hasMoreRef.current = more;
    setHasMore(more);
  }, []);

  const reset = useCallback(() => {
    cursorRef.current = null;
    hasMoreRef.current = false;
    loadingRef.current = false;
    setHasMore(false);
    setLoadingOlder(false);
  }, []);

  const loadOlder = useCallback((): void => {
    const id = sessionRef.current;
    if (id === undefined || !hasMoreRef.current || cursorRef.current === null || loadingRef.current) return;
    loadingRef.current = true;
    setLoadingOlder(true);
    const cursor = cursorRef.current;
    void (async () => {
      try {
        const page = await client.historySnapshot(id, { limit: pageSize, before: cursor });
        if (sessionRef.current !== id) return; // switched mid-fetch — stale
        setMessages((prev) => {
          const seen = new Set(prev.map((m) => m.id));
          const fresh = page.messages.filter((m) => !seen.has(m.id));
          return fresh.length > 0 ? [...fresh, ...prev] : prev;
        });
        cursorRef.current = page.nextCursor ?? null;
        hasMoreRef.current = page.hasMore === true;
        setHasMore(page.hasMore === true);
      } catch {
        // The transcript stays usable; a retry re-triggers on the next scroll.
      } finally {
        loadingRef.current = false;
        setLoadingOlder(false);
      }
    })();
  }, [client, pageSize, setMessages]);

  return useMemo(
    () => ({ hasMore, loadingOlder, loadOlder, seed, reset }),
    [hasMore, loadingOlder, loadOlder, seed, reset],
  );
}
