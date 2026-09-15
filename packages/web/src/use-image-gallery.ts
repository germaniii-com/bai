import { useCallback, useEffect, useRef, useState } from "react";
import type { BaiClient } from "@bai/api/client";
import type { Asset } from "@bai/shared";

const PAGE_SIZE = 60;

/**
 * Fuzzy tag search over the keyset-paged image gallery. `refresh` reloads
 * page 0 (called on mount, on query change, and on live asset events);
 * `loadMore` appends the next older page. `tagQuery` is matched fuzzily by
 * the server (e.g. `gemini` matches a `gemini 3 pro` tag). A request
 * generation drops stale responses when the query changes mid-fetch.
 */
export function useImageGallery(client: BaiClient, tagQuery: string): {
  images: Asset[];
  hasMore: boolean;
  total: number;
  loading: boolean;
  loadingMore: boolean;
  refresh: () => Promise<void>;
  loadMore: () => void;
} {
  const [images, setImages] = useState<Asset[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const cursorRef = useRef<string | null>(null);
  const generationRef = useRef(0);
  const loadingMoreRef = useRef(false);
  const query = tagQuery.trim();

  const refresh = useCallback(async (): Promise<void> => {
    const generation = ++generationRef.current;
    loadingMoreRef.current = false;
    setLoadingMore(false);
    setLoading(true);
    try {
      const page = await client.imageGallery({
        limit: PAGE_SIZE,
        ...(query.length > 0 ? { tags: [query] } : {}),
      });
      if (generation !== generationRef.current) return;
      setImages(page.images);
      setTotal(page.total);
      cursorRef.current = page.nextCursor ?? null;
      setHasMore(page.hasMore === true);
    } catch {
      // Advisory — the page renders whatever is loaded.
    } finally {
      if (generation === generationRef.current) setLoading(false);
    }
  }, [client, query]);

  const loadMore = useCallback((): void => {
    const cursor = cursorRef.current;
    if (cursor === null || loadingMoreRef.current) return;
    const generation = generationRef.current;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    void (async () => {
      try {
        const page = await client.imageGallery({
          limit: PAGE_SIZE,
          before: cursor,
          ...(query.length > 0 ? { tags: [query] } : {}),
        });
        if (generation !== generationRef.current) return;
        setImages((prev) => {
          const seen = new Set(prev.map((a) => a.id));
          return [...prev, ...page.images.filter((a) => !seen.has(a.id))];
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
  }, [client, query]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { images, hasMore, total, loading, loadingMore, refresh, loadMore };
}
