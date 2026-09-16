/**
 * Bounds for the image lightbox's gallery traversal. `index` is the image's
 * 0-based position within the currently loaded `images`; because keyset pages
 * always append in the same newest-first order, that index is also the
 * position within the full result set. `hasNext` additionally accounts for
 * unloaded pages (`hasMore`), so Next stays enabled until the true end.
 */
export interface GalleryNavigation {
  index: number;
  /** Server total for the active filter, never below the loaded count. */
  total: number;
  hasPrevious: boolean;
  hasNext: boolean;
}

/**
 * Navigation bounds for `currentId` within `images`. Returns `undefined` when
 * no image is open or the open image is not in the currently loaded list (for
 * example after a refresh or a filter change), which turns navigation off.
 */
export function galleryNavState(
  images: readonly { id: string }[],
  currentId: string | null,
  opts: { hasMore: boolean; total: number },
): GalleryNavigation | undefined {
  if (currentId === null) return undefined;
  const index = images.findIndex((a) => a.id === currentId);
  if (index < 0) return undefined;
  return {
    index,
    total: Math.max(opts.total, images.length),
    hasPrevious: index > 0,
    hasNext: index < images.length - 1 || opts.hasMore,
  };
}
