import { useCallback, useEffect, useRef, useState } from "react";
import type { BaiClient } from "@bai/api/client";
import type { Asset } from "@bai/shared";

// Smaller than the image gallery: each card fetches a full video blob to
// thumbnail, so a dense first page would fetch a lot of bytes at once.
const PAGE_SIZE = 24;

/**
 * Fuzzy tag search over the keyset-paged video gallery. Mirrors
 * {@link useImageGallery} against `client.videoGallery`. `refresh` reloads page
 * 0 (mount, query change, live asset events); `loadMore` appends the next
 * older page; a request generation drops stale responses.
 */
export function useVideoGallery(client: BaiClient, tagQuery: string): {
  videos: Asset[];
  hasMore: boolean;
  total: number;
  loading: boolean;
  loadingMore: boolean;
  refresh: () => Promise<void>;
  loadMore: () => void;
} {
  const [videos, setVideos] = useState<Asset[]>([]);
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
      const page = await client.videoGallery({
        limit: PAGE_SIZE,
        ...(query.length > 0 ? { tags: [query] } : {}),
      });
      if (generation !== generationRef.current) return;
      setVideos(page.videos);
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
        const page = await client.videoGallery({
          limit: PAGE_SIZE,
          before: cursor,
          ...(query.length > 0 ? { tags: [query] } : {}),
        });
        if (generation !== generationRef.current) return;
        setVideos((prev) => {
          const seen = new Set(prev.map((a) => a.id));
          return [...prev, ...page.videos.filter((a) => !seen.has(a.id))];
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

  return { videos, hasMore, total, loading, loadingMore, refresh, loadMore };
}
