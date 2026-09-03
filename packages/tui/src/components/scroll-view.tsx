import {
  Children,
  forwardRef,
  isValidElement,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type SetStateAction,
} from "react";
import { Box, measureElement, type BoxProps, type DOMElement } from "ink";

/**
 * Scroll container for Ink, vendored from ink-scroll-view v0.3.7
 * (https://github.com/ByteLandTechnology/ink-scroll-view, MIT © Byte Land
 * Technology) and adapted for bai's chat transcript:
 *
 *   - Single CONTROLLED component: the parent owns `scrollOffset` (terminal
 *     rows from the TOP of the content) — needed for the follow-the-bottom
 *     logic and the "↑ earlier messages" indicator.
 *   - `bottomAlign`: when the content is shorter than the viewport the column
 *     hugs the BOTTOM of the viewport (chat behavior), and item positions
 *     include the resulting top pad so consumer math stays exact.
 *   - The measured viewport box is height-constrained (`height="100%"` inside
 *     the flex-bounded outer box) so clipping and measurement agree.
 *   - The viewport-measure layout effect is declared BEFORE the content-height
 *     effect, so `onContentHeightChange` reads a fresh viewport size in the
 *     same commit (follow-the-bottom depends on it).
 *   - Trimmed to what the chat needs: no debug mode, no uncontrolled variant,
 *     no per-item height callback.
 *
 * How it works: every child is wrapped in a `MeasurableItem` box whose height
 * is read back with ink's `measureElement` after each render; the whole
 * content column is shifted by `marginTop={-scrollOffset}` inside an
 * `overflow="hidden"` viewport. Scrolling is therefore CONTINUOUS in terminal
 * rows — partial items at the viewport edges are natural, and any content
 * growth (streaming text, expand/collapse) re-measures automatically because
 * child identity changes.
 */

/** Hook pairing state with a synchronously-updated ref, so imperative reads
 *  (ref methods, layout-effect callbacks) always see the latest value. */
function useStateRef<T>(initialValue: T) {
  const [state, setStateInternal] = useState<T>(initialValue);
  const ref = useRef<T>(initialValue);

  const setState = useCallback((update: SetStateAction<T>) => {
    const nextValue =
      typeof update === "function" ? (update as (prev: T) => T)(ref.current) : update;
    ref.current = nextValue;
    setStateInternal(nextValue);
  }, []);

  const getState = useCallback(() => ref.current, []);

  return [state, setState, getState] as const;
}

/**
 * Internal wrapper measuring one child's rendered height (via
 * `measureElement` in a layout effect) and reporting it to the parent.
 * Re-measures whenever `children` changes identity — streaming text growth
 * and expand/collapse re-measure automatically.
 */
const MeasurableItem = ({
  children,
  onMeasure,
  index,
  width,
  measureKey,
}: {
  children: ReactNode;
  onMeasure: (index: number, height: number) => void;
  index: number;
  width: number;
  // Bumped to force re-measurement even if other props haven't changed.
  measureKey?: number;
}) => {
  const ref = useRef<DOMElement>(null);

  useLayoutEffect(() => {
    if (ref.current) {
      const { height } = measureElement(ref.current);
      onMeasure(index, height);
    }
  }, [index, onMeasure, width, measureKey, children]);

  return (
    <Box ref={ref} flexShrink={0} width="100%" flexDirection="column">
      {children}
    </Box>
  );
};

export interface ScrollViewProps extends BoxProps {
  /** Current scroll position in terminal rows from the TOP of the content. */
  scrollOffset: number;
  /**
   * When the content is shorter than the viewport, hug the bottom of the
   * viewport (chat behavior) instead of top-aligning. Item positions reported
   * by `getItemPosition` include the resulting top pad.
   */
  bottomAlign?: boolean;
  /** Fired after layout when the measured content height changes. */
  onContentHeightChange?: (height: number, previousHeight: number) => void;
  /** Fired after layout when the viewport dimensions change (resize, layout). */
  onViewportSizeChange?: (
    size: { width: number; height: number },
    previousSize: { width: number; height: number },
  ) => void;
  children?: ReactNode;
}

export interface ScrollViewRef {
  /** Total measured height of all items, in terminal rows. */
  getContentHeight: () => number;
  /** Current measured viewport height, in terminal rows. */
  getViewportHeight: () => number;
  /** Scroll offset that shows the very bottom (`content − viewport`, ≥ 0). */
  getBottomOffset: () => number;
  /** Measured height of one item by index. */
  getItemHeight: (index: number) => number;
  /**
   * Absolute position of one item: `top` (from the content start, including
   * the bottom-align pad when active) and `height`. Null when out of range.
   */
  getItemPosition: (index: number) => { top: number; height: number } | null;
  /** Re-measure the viewport (terminal resizes; ink re-renders usually suffice). */
  remeasure: () => void;
  /** Force re-measurement of one child (content mutated without a re-render). */
  remeasureItem: (index: number) => void;
}

export const ScrollView = forwardRef<ScrollViewRef, ScrollViewProps>(
  (
    {
      scrollOffset,
      bottomAlign = false,
      onContentHeightChange,
      onViewportSizeChange,
      children,
      ...boxProps
    },
    ref,
  ) => {
    // Viewport dimensions (measured); ref-synced so layout-effect callbacks
    // and imperative reads see fresh values within the same commit.
    const [viewportSize, setViewportSize, getViewportSize] = useStateRef({
      height: 0,
      width: 0,
    });
    // Total measured height of the scrollable content.
    const [contentHeight, setContentHeight, getContentHeight] = useStateRef(0);

    // Per-item measure keys to force re-measurement of specific items.
    const [itemMeasureKeys, setItemMeasureKeys] = useState<Record<number, number>>({});

    const viewportRef = useRef<DOMElement>(null);

    // Previous content height, to fire the change callback only on real changes.
    const prevContentHeightRef = useRef(0);

    // Item heights keyed by the child's React key (message IDs — stable).
    const itemHeightsRef = useRef<Record<string | number, number>>({});
    // Child index → key, preserving the index ↔ message mapping.
    const itemKeysRef = useRef<(string | number)[]>([]);
    // Lazily-populated accumulated offsets (top of each item from content start).
    const itemOffsetsRef = useRef<number[]>([]);
    // Index from which the offset cache is dirty (an item's height changed).
    const firstInvalidOffsetIndexRef = useRef(0);

    // Reconcile the item list when children change: keep the measured heights
    // of surviving keys, drop the rest, reset the offset cache.
    const prevChildrenRef = useRef<typeof children>(null);
    if (prevChildrenRef.current !== children) {
      prevChildrenRef.current = children;

      const newItemKeys: (string | number)[] = [];
      const newItemHeights: Record<string | number, number> = {};

      Children.forEach(children, (child, index) => {
        if (!child) return;
        const key = isValidElement(child) ? child.key : null;
        const effectiveKey = key !== null ? key : index;

        newItemKeys[index] = effectiveKey;
        newItemHeights[effectiveKey] = itemHeightsRef.current[effectiveKey] ?? 0;
      });

      itemHeightsRef.current = newItemHeights;
      itemKeysRef.current = newItemKeys;
      itemOffsetsRef.current = new Array(newItemKeys.length).fill(0);
      firstInvalidOffsetIndexRef.current = 0;

      let newTotalHeight = 0;
      newItemKeys.forEach((itemKey) => {
        newTotalHeight += newItemHeights[itemKey] ?? 0;
      });

      if (newTotalHeight !== getContentHeight()) {
        setContentHeight(newTotalHeight);
      }
    }

    const handleItemMeasure = useCallback(
      (index: number, height: number) => {
        const key = itemKeysRef.current[index] ?? index;

        // Dedup: only real height changes propagate (keeps streaming renders
        // from looping state updates).
        if (itemHeightsRef.current[key] !== height) {
          itemHeightsRef.current = {
            ...itemHeightsRef.current,
            [key]: height,
          };

          let newTotalHeight = 0;
          for (const itemKey of itemKeysRef.current) {
            newTotalHeight += itemHeightsRef.current[itemKey] ?? 0;
          }
          if (newTotalHeight !== getContentHeight()) {
            setContentHeight(newTotalHeight);
          }

          // Items below the changed one have shifted — dirty the cache.
          firstInvalidOffsetIndexRef.current = Math.min(
            firstInvalidOffsetIndexRef.current,
            index + 1,
          );
        }
      },
      [getContentHeight, setContentHeight],
    );

    const measureViewport = useCallback(() => {
      if (viewportRef.current) {
        const { width, height } = measureElement(viewportRef.current);
        const currentSize = getViewportSize();
        if (width !== currentSize.width || height !== currentSize.height) {
          onViewportSizeChange?.({ width, height }, currentSize);
          setViewportSize({ width, height });
        }
      }
    }, [onViewportSizeChange, getViewportSize, setViewportSize]);

    // ORDER MATTERS: viewport measurement is declared before the content-height
    // effect so `onContentHeightChange` reads a fresh viewport size in the same
    // commit (the ref-synced state makes the value immediately visible).
    useLayoutEffect(() => {
      measureViewport();
    });

    useLayoutEffect(() => {
      if (contentHeight !== prevContentHeightRef.current) {
        onContentHeightChange?.(contentHeight, prevContentHeightRef.current);
        prevContentHeightRef.current = contentHeight;
      }
    }, [contentHeight, onContentHeightChange]);

    useImperativeHandle(
      ref,
      () => ({
        getContentHeight,
        getViewportHeight: () => getViewportSize().height,
        getBottomOffset: () =>
          Math.max(0, getContentHeight() - getViewportSize().height),
        getItemHeight: (index: number) => {
          const key = itemKeysRef.current[index] ?? index;
          return itemHeightsRef.current[key] ?? 0;
        },
        remeasure: measureViewport,
        remeasureItem: (index: number) =>
          setItemMeasureKeys((prev) => ({
            ...prev,
            [index]: (prev[index] ?? 0) + 1,
          })),
        getItemPosition: (index: number) => {
          if (index < 0 || index >= itemKeysRef.current.length) {
            return null;
          }

          if (index >= firstInvalidOffsetIndexRef.current) {
            let currentOffset = 0;
            let startIndex = 0;

            if (firstInvalidOffsetIndexRef.current > 0) {
              startIndex = firstInvalidOffsetIndexRef.current;
              const prevIndex = startIndex - 1;
              const prevKey = itemKeysRef.current[prevIndex] ?? prevIndex;
              currentOffset =
                (itemOffsetsRef.current[prevIndex] ?? 0) +
                (itemHeightsRef.current[prevKey] ?? 0);
            }

            for (let i = startIndex; i <= index; i++) {
              itemOffsetsRef.current[i] = currentOffset;
              const key = itemKeysRef.current[i] ?? i;
              currentOffset += itemHeightsRef.current[key] ?? 0;
            }
            firstInvalidOffsetIndexRef.current = index + 1;
          }

          const rawTop = itemOffsetsRef.current[index] ?? 0;
          const key = itemKeysRef.current[index] ?? index;
          const height = itemHeightsRef.current[key] ?? 0;
          // Bottom-align pad: when the content hugs the bottom of a taller
          // viewport, positions must include the empty rows above it.
          const pad = bottomAlign
            ? Math.max(0, getViewportSize().height - getContentHeight())
            : 0;
          return { top: pad + rawTop, height };
        },
      }),
      [bottomAlign, measureViewport, getContentHeight, getViewportSize],
    );

    return (
      <Box {...boxProps}>
        {/* Measured + clipping viewport: height-bound to the outer box (which
            the parent sizes via flex) so clip and measurement agree. */}
        <Box ref={viewportRef} width="100%" height="100%" overflow="hidden">
          <Box width="100%" flexDirection="column" marginTop={-scrollOffset}>
            {/* Bottom-align pad: when the content hugs the bottom of a taller
                viewport, blank rows go ABOVE the items. A real child (not
                minHeight + justifyContent!) — with justifyContent="flex-end"
                here, Yoga's overflow-hidden At-Most measure collapses this box
                to the viewport height, pins the children to its bottom, and
                the negative scroll margin is ignored (scroll dies). */}
            {(() => {
              const pad = bottomAlign
                ? Math.max(0, viewportSize.height - contentHeight)
                : 0;
              return pad > 0 ? <Box height={pad} flexShrink={0} /> : null;
            })()}
            {Children.map(children, (child, index) => {
              if (!child) return null;
              return (
                <MeasurableItem
                  key={isValidElement(child) ? (child.key ?? index) : index}
                  index={index}
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
