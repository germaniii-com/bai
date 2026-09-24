import {
  Children,
  forwardRef,
  isValidElement,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Box, measureElement, type BoxProps, type DOMElement } from "ink";
import { clampOffset, computeOffsets, findWindow } from "./virtual-list-layout";

/**
 * Virtualized transcript viewport for Ink — the chat view and the subagent
 * dialog render through this. Adapted from `ink-virtual-list`
 * (https://github.com/archcorsair/ink-virtual-list, MIT © Daniel Shneyder):
 *
 *   - Only the items intersecting the viewport (plus a small overscan) are
 *     MOUNTED and measured, so a transcript with hundreds of nodes costs
 *     O(visible) per render instead of O(all nodes).
 *   - Unlike upstream — whose single integer `itemHeight` clips variable-height
 *     items — heights are MEASURED per item (ink's `measureElement`) and cached
 *     by React key, so streaming markdown, bounded tool output, and bordered
 *     user bubbles keep their real height. Unmeasured items fall back to
 *     `estimatedItemHeight` until they enter the window.
 *   - The controlled `scrollOffset` contract (rows from the content TOP) is
 *     unchanged from the previous `ScrollView`, as is the ref surface — plus
 *     `getScrollOffset()` (the correction-aware effective offset).
 *
 * Anchor correction: when an item entirely ABOVE the reading window measures
 * to a different height than assumed, everything below it shifts; an internal
 * correction is folded into the render so the visible rows stay put. The
 * correction resets whenever the controlled `scrollOffset` prop changes (a
 * real scroll / follow-the-bottom snap), so callers stay authoritative.
 *
 * Width-resize invalidation: a width change rewraps every item, so cached
 * heights are dropped and offscreen items re-estimate until they re-enter.
 */

const DEFAULT_ESTIMATED_HEIGHT = 1;
const DEFAULT_OVERSCAN_ITEMS = 2;

/**
 * Internal wrapper measuring one child's rendered height (via `measureElement`
 * in a layout effect) and reporting it to the parent. Re-measures whenever
 * `children` changes identity — streaming text growth and expand/collapse
 * re-measure automatically. Equal heights are deduped by the parent.
 */
const MeasurableItem = ({
  children,
  onMeasure,
  index,
  itemKey,
  width,
  measureKey,
}: {
  children: ReactNode;
  onMeasure: (index: number, itemKey: string | number, height: number) => void;
  index: number;
  itemKey: string | number;
  width: number;
  // Bumped to force re-measurement even if other props haven't changed.
  measureKey?: number;
}) => {
  const ref = useRef<DOMElement>(null);

  useLayoutEffect(() => {
    if (ref.current !== null) {
      const { height } = measureElement(ref.current);
      onMeasure(index, itemKey, height);
    }
  }, [index, itemKey, onMeasure, width, measureKey, children]);

  return (
    <Box ref={ref} flexShrink={0} width="100%" flexDirection="column">
      {children}
    </Box>
  );
};

export interface VirtualListProps extends BoxProps {
  /** Current scroll position in terminal rows from the TOP of the content. */
  scrollOffset: number;
  /**
   * When the content is shorter than the viewport, hug the bottom of the
   * viewport (chat behavior) instead of top-aligning. Item positions reported
   * by `getItemPosition` include the resulting top pad.
   */
  bottomAlign?: boolean;
  /**
   * Rows assumed for items that have not been measured yet. Because the window
   * is computed from uniform estimates, the tail window is index-correct for
   * any value; keeping this at a conservative LOWER bound (the default 1) means
   * reported content height only grows as items measure, so following the
   * bottom never snaps backwards.
   */
  estimatedItemHeight?: number;
  /** Extra items mounted above/below the viewport (measurement runway). */
  overscanItems?: number;
  /** Fired after layout when the measured content height changes. */
  onContentHeightChange?: (height: number, previousHeight: number) => void;
  /**
   * Fired after layout when the effective offset (the controlled `scrollOffset`
   * plus any internal anchor correction) drifts from the controlled value.
   * Callers should store it back into their own offset state so a pending
   * correction is absorbed into the coordinate system they scroll in —
   * without this, a relative scroll (`getScrollOffset() + delta`) can land on
   * the unchanged raw offset and freeze (correction 1 cancels every step).
   * While following the bottom, callers may ignore it (the follow snap wins).
   */
  onScrollOffsetChange?: (offset: number) => void;
  /** Fired after layout when the viewport dimensions change (resize, layout). */
  onViewportSizeChange?: (
    size: { width: number; height: number },
    previousSize: { width: number; height: number },
  ) => void;
  children?: ReactNode;
}

export interface VirtualListRef {
  /** Total estimated/measured height of all items, in terminal rows. */
  getContentHeight: () => number;
  /** Current measured viewport height, in terminal rows. */
  getViewportHeight: () => number;
  /** Scroll offset that shows the very bottom (`content − viewport`, ≥ 0). */
  getBottomOffset: () => number;
  /** Measured height of one item by index (estimate while unmeasured). */
  getItemHeight: (index: number) => number;
  /**
   * Position of one item: `top` (from the content start, including the
   * bottom-align pad when active) and `height`. Null when out of range.
   */
  getItemPosition: (index: number) => { top: number; height: number } | null;
  /**
   * The effective scroll offset in use (the controlled prop plus any internal
   * anchor correction). Callers that scroll RELATIVELY should add their delta
   * to this so a pending correction can't cause a jump.
   */
  getScrollOffset: () => number;
  /** Re-measure the viewport (terminal resizes; ink re-renders usually suffice). */
  remeasure: () => void;
  /** Force re-measurement of one child (content mutated without a re-render). */
  remeasureItem: (index: number) => void;
}

export const VirtualList = forwardRef<VirtualListRef, VirtualListProps>(
  function VirtualList(
    {
      scrollOffset,
      bottomAlign = false,
      estimatedItemHeight = DEFAULT_ESTIMATED_HEIGHT,
      overscanItems = DEFAULT_OVERSCAN_ITEMS,
      onContentHeightChange,
      onScrollOffsetChange,
      onViewportSizeChange,
      children,
      ...boxProps
    },
    ref,
  ) {
    const est = Math.max(1, Math.floor(estimatedItemHeight));
    const overscan = Math.max(0, Math.floor(overscanItems));
    const viewportRef = useRef<DOMElement>(null);

    // Children flattened to an array; each item's React key is its stable
    // identity for the height cache (chat/subagent supply explicit keys).
    const childArray = useMemo(() => Children.toArray(children), [children]);
    const keys = useMemo<(string | number)[]>(
      () => childArray.map((child, index) => (isValidElement(child) && child.key !== null ? child.key : index)),
      [childArray],
    );
    const keysSignature = keys.join("\u0000");

    // Measured heights keyed by React key, surviving renders/scroll.
    const heightsRef = useRef<Map<string | number, number>>(new Map());
    const [layoutVersion, setLayoutVersion] = useState(0);
    const bumpLayout = useCallback(() => setLayoutVersion((v) => v + 1), []);

    // Reconcile the cache when the key set changes (session switch, prepend,
    // tail eviction): keep the measured heights of surviving keys.
    const prevKeysSignatureRef = useRef<string | null>(null);
    if (prevKeysSignatureRef.current !== keysSignature) {
      const live = new Set<string | number>(keys);
      const next = new Map<string | number, number>();
      for (const [key, height] of heightsRef.current) {
        if (live.has(key)) next.set(key, height);
      }
      heightsRef.current = next;
      prevKeysSignatureRef.current = keysSignature;
    }

    // This commit's per-item heights (measured or estimated) + prefix offsets.
    const heights = useMemo(
      () => keys.map((key) => heightsRef.current.get(key) ?? est),
      // heightsRef is read imperatively; layoutVersion/keysSignature drive it.
      [keysSignature, layoutVersion, est],
    );
    const offsets = useMemo(() => computeOffsets(heights), [heights]);
    const total = offsets[offsets.length - 1] ?? 0;

    // ---- viewport measurement ---------------------------------------------
    const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
    const viewportSizeRef = useRef(viewportSize);
    viewportSizeRef.current = viewportSize;

    const measureViewport = useCallback(() => {
      if (viewportRef.current === null) return;
      const { width, height } = measureElement(viewportRef.current);
      const prev = viewportSizeRef.current;
      if (prev.width === width && prev.height === height) return;
      if (prev.width !== 0 && prev.width !== width) {
        // Width change rewraps everything — cached offscreen heights are stale.
        heightsRef.current = new Map();
        setLayoutVersion((v) => v + 1);
      }
      viewportSizeRef.current = { width, height };
      setViewportSize({ width, height });
      onViewportSizeChange?.({ width, height }, prev);
    }, [onViewportSizeChange]);

    // ORDER MATTERS: the viewport is measured before content height is
    // reported, so callers read a fresh viewport size in the same commit
    // (follow-the-bottom depends on it — ref-synced state is immediately live).
    useLayoutEffect(() => {
      measureViewport();
    });

    const prevTotalRef = useRef(0);
    useLayoutEffect(() => {
      if (total !== prevTotalRef.current) {
        onContentHeightChange?.(total, prevTotalRef.current);
        prevTotalRef.current = total;
      }
    }, [total, onContentHeightChange]);

    // ---- anchor correction + effective offset -----------------------------
    // Reset whenever the controlled offset changes (the caller's scroll/follow
    // already accounts for any correction we folded in).
    const correctionRef = useRef(0);
    const prevScrollPropRef = useRef(scrollOffset);
    if (prevScrollPropRef.current !== scrollOffset) {
      prevScrollPropRef.current = scrollOffset;
      correctionRef.current = 0;
    }
    const maxOffset = Math.max(0, total - viewportSize.height);
    const effectiveOffset = clampOffset(scrollOffset + correctionRef.current, maxOffset);
    const effectiveOffsetRef = useRef(effectiveOffset);
    effectiveOffsetRef.current = effectiveOffset;

    // Push a pending correction back to the caller so its offset state absorbs
    // it. Without this, a relative scroll reads effective = raw + correction,
    // writes raw = effective − delta, and when correction === delta the raw
    // value is unchanged: no re-render, the correction never resets, and
    // scrolling freezes (the "stuck around 50-70%" bug with dense 2-row nodes).
    // Reads correctionRef directly: child measurement effects run before this
    // one, so the freshly-added delta isn't in `effectiveOffset` yet.
    useLayoutEffect(() => {
      if (correctionRef.current === 0) return;
      const target = clampOffset(
        scrollOffset + correctionRef.current,
        Math.max(0, total - viewportSize.height),
      );
      onScrollOffsetChange?.(target);
    }, [effectiveOffset, onScrollOffsetChange, scrollOffset, total, viewportSize.height]);

    // Latest layout values for the stable callback + imperative ref.
    const keysRef = useRef(keys);
    keysRef.current = keys;
    const offsetsRef = useRef(offsets);
    offsetsRef.current = offsets;
    const totalRef = useRef(total);
    totalRef.current = total;
    const estRef = useRef(est);
    estRef.current = est;

    const handleItemMeasure = useCallback(
      (index: number, itemKey: string | number, height: number) => {
        const prev = heightsRef.current.get(itemKey) ?? estRef.current;
        if (prev === height) return; // dedup: stable renders never loop
        const top = offsetsRef.current[index] ?? 0;
        // Entirely above the reading top → content below shifts by the delta;
        // fold it into the correction so the visible rows don't jump.
        if (top + prev <= effectiveOffsetRef.current) {
          correctionRef.current += height - prev;
        }
        heightsRef.current.set(itemKey, height);
        setLayoutVersion((v) => v + 1);
      },
      [],
    );

    const [itemMeasureKeys, setItemMeasureKeys] = useState<Record<number, number>>({});

    useImperativeHandle(
      ref,
      () => ({
        getContentHeight: () => totalRef.current,
        getViewportHeight: () => viewportSizeRef.current.height,
        getBottomOffset: () => Math.max(0, totalRef.current - viewportSizeRef.current.height),
        getScrollOffset: () => effectiveOffsetRef.current,
        getItemHeight: (index: number) => {
          const key = keysRef.current[index];
          if (key === undefined) return 0;
          return heightsRef.current.get(key) ?? estRef.current;
        },
        getItemPosition: (index: number) => {
          if (index < 0 || index >= keysRef.current.length) return null;
          const rawTop = offsetsRef.current[index] ?? 0;
          const key = keysRef.current[index] as string | number;
          const height = heightsRef.current.get(key) ?? estRef.current;
          const pad = bottomAlign
            ? Math.max(0, viewportSizeRef.current.height - totalRef.current)
            : 0;
          return { top: pad + rawTop, height };
        },
        remeasure: () => {
          measureViewport();
          bumpLayout();
        },
        remeasureItem: (index: number) =>
          setItemMeasureKeys((prev) => ({
            ...prev,
            [index]: (prev[index] ?? 0) + 1,
          })),
      }),
      [bottomAlign, measureViewport, bumpLayout],
    );

    // ---- window + render --------------------------------------------------
    const visibleWindow = findWindow(offsets, effectiveOffset, viewportSize.height, overscan);
    const first = visibleWindow?.first ?? 0;
    const last = visibleWindow?.last ?? -1;
    // Bottom-align pad: when the content hugs the bottom of a taller viewport,
    // blank rows go ABOVE the items (a real child — with justifyContent the
    // negative scroll margin is ignored, see the previous ScrollView note).
    const pad = bottomAlign ? Math.max(0, viewportSize.height - total) : 0;

    return (
      <Box {...boxProps}>
        <Box ref={viewportRef} width="100%" height="100%" overflow="hidden">
          <Box width="100%" flexDirection="column" marginTop={-effectiveOffset}>
            {pad > 0 && <Box height={pad} flexShrink={0} />}
            {/* Above-window spacer: keeps the windowed items in content
                coordinates so positions and the negative margin stay exact. */}
            <Box height={offsets[first] ?? 0} flexShrink={0} />
            {visibleWindow !== null &&
              childArray.slice(first, last + 1).map((child, offsetIdx) => {
                const index = first + offsetIdx;
                const itemKey = keys[index] ?? index;
                return (
                  <MeasurableItem
                    key={itemKey}
                    index={index}
                    itemKey={itemKey}
                    width={viewportSize.width}
                    onMeasure={handleItemMeasure}
                    measureKey={itemMeasureKeys[index]}
                  >
                    {child}
                  </MeasurableItem>
                );
              })}
          </Box>
        </Box>
      </Box>
    );
  },
);
