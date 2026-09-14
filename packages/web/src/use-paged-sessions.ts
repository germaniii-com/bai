import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { BaiClient } from "@bai/api/client";
import type { Session } from "@bai/shared";

/**
 * Cursor-paged session list for a sidebar (chat section, workspace section).
 * Loads the first page (`refresh`) and appends older pages on demand
 * (`loadMore`); live `session.updated` patches flow through the exposed
 * `setSessions`. `q` re-fetches page 0 server-side so filtering matches rows
 * beyond the loaded window; `roots` excludes child (subagent) sessions so
 * pages stay dense.
 *
 * A monotonically increasing request generation drops stale responses when
 * the filter/cwd changes mid-fetch.
 */
export interface PagedSessions {
  sessions: Session[];
  setSessions: Dispatch<SetStateAction<Session[]>>;
  hasMore: boolean;
  loading: boolean;
  loadingMore: boolean;
  refresh: () => Promise<void>;
  loadMore: () => void;
}

export function usePagedSessions(
  client: BaiClient,
  opts: { workbench?: string; cwd?: string; q?: string; pageSize?: number; enabled?: boolean } = {},
): PagedSessions {
  const pageSize = opts.pageSize ?? 50;
  const enabled = opts.enabled ?? true;
  const { workbench, cwd, q } = opts;
  const [sessions, setSessions] = useState<Session[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const cursorRef = useRef<string | null>(null);
  const generationRef = useRef(0);
  const loadingMoreRef = useRef(false);

  const refresh = useCallback(async (): Promise<void> => {
    const generation = ++generationRef.current;
    loadingMoreRef.current = false;
    setLoadingMore(false);
    if (!enabled) {
      setSessions([]);
      setHasMore(false);
      cursorRef.current = null;
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const page = await client.listSessionsPage(pageSize, {
        ...(workbench !== undefined ? { workbench } : {}),
        ...(cwd !== undefined ? { cwd } : {}),
        ...(q !== undefined && q.length > 0 ? { q } : {}),
        roots: true,
      });
      if (generation !== generationRef.current) return;
      setSessions(page.sessions);
      cursorRef.current = page.nextCursor ?? null;
      setHasMore(page.hasMore === true);
    } catch {
      // Advisory; the sidebar renders whatever is loaded.
    } finally {
      if (generation === generationRef.current) setLoading(false);
    }
  }, [client, pageSize, workbench, cwd, q, enabled]);

  const loadMore = useCallback((): void => {
    const cursor = cursorRef.current;
    if (cursor === null || loadingMoreRef.current || !enabled) return;
    const generation = generationRef.current;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    void (async () => {
      try {
        const page = await client.listSessionsPage(pageSize, {
          before: cursor,
          ...(workbench !== undefined ? { workbench } : {}),
          ...(cwd !== undefined ? { cwd } : {}),
          ...(q !== undefined && q.length > 0 ? { q } : {}),
          roots: true,
        });
        if (generation !== generationRef.current) return;
        setSessions((prev) => {
          const seen = new Set(prev.map((s) => s.id));
          return [...prev, ...page.sessions.filter((s) => !seen.has(s.id))];
        });
        cursorRef.current = page.nextCursor ?? null;
        setHasMore(page.hasMore === true);
      } catch {
        // Leave the cursor in place; a retry re-triggers on click.
      } finally {
        if (generation === generationRef.current) {
          loadingMoreRef.current = false;
          setLoadingMore(false);
        }
      }
    })();
  }, [client, pageSize, workbench, cwd, q, enabled]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { sessions, setSessions, hasMore, loading, loadingMore, refresh, loadMore };
}
