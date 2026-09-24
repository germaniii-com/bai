import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { Box, Text, useInput } from "ink";
import { useCallback, useRef, useState } from "react";
import { VirtualList, type VirtualListRef } from "../src/components/virtual-list";

/**
 * Contract tests for the variable-height VirtualList
 * (components/virtual-list.tsx):
 *
 *   1. Clipping — content taller than the bounded viewport is clipped; a
 *      sibling below (composer) never bleeds.
 *   2. Continuous scroll — `scrollOffset` is terminal ROWS from the content
 *      top; any row offset is renderable, not just item boundaries.
 *   3. Measurement truth — measured heights/positions match the real layout.
 *   4. Bottom-align — short content hugs the bottom and item positions include
 *      the resulting pad.
 *   5. Reading-window stability — a fixed scrollOffset keeps the same content
 *      visible while the content grows.
 *   6. Bounded mounting — only the visible window (+ overscan) ever renders,
 *      so a 500-item transcript costs O(visible).
 *   7. Variable heights — items keep their real measured height (the reason
 *      upstream ink-virtual-list's fixed itemHeight couldn't be used).
 */

const tick = (ms = 30): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Harness: height-bounded parent (10) = viewport (9) + composer sibling (1). */
function Harness({
  items,
  offset = 0,
  bottomAlign = false,
  onRef,
}: {
  items: string[];
  offset?: number;
  bottomAlign?: boolean;
  onRef?: (ref: VirtualListRef | null) => void;
}) {
  return (
    <Box flexDirection="column" width={40} height={10}>
      <VirtualList
        ref={onRef}
        scrollOffset={offset}
        bottomAlign={bottomAlign}
        flexGrow={1}
        flexShrink={1}
        flexBasis={0}
        minHeight={0}
      >
        {items.map((label) => (
          <Box key={label} flexShrink={0}>
            <Text>{label}</Text>
          </Box>
        ))}
      </VirtualList>
      <Box height={1}>
        <Text>COMPOSER</Text>
      </Box>
    </Box>
  );
}

const items = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => `item-${String(i).padStart(2, "0")}`);

describe("VirtualList (variable-height virtualized scroll container)", () => {
  test("clips overflow at the viewport bounds — composer sibling stays clean", async () => {
    const { lastFrame, unmount } = render(<Harness items={items(30)} offset={21} />);
    await tick();
    const frame = lastFrame() ?? "";
    unmount();

    const lines = frame.split("\n");
    // Viewport (9 rows) + the composer row below.
    expect(lines.length).toBe(10);
    // Scrolled to the bottom offset (30 − 9 = 21): newest items visible.
    expect(frame).toContain("item-21");
    expect(frame).toContain("item-29");
    expect(frame).not.toContain("item-20");
    // The composer row contains ONLY the composer marker.
    const composerRow = lines[lines.length - 1];
    expect(composerRow?.trim()).toBe("COMPOSER");
  });

  test("scrollOffset shifts by single rows (continuous, not item-quantized)", async () => {
    const { lastFrame, unmount } = render(<Harness items={items(30)} offset={5} />);
    await tick();
    const frame = lastFrame() ?? "";
    unmount();

    const lines = frame.split("\n").filter((l) => l.trim().length > 0);
    expect(lines[0]).toContain("item-05");
    expect(frame).not.toContain("item-04");
  });

  test("measures the viewport, content, and item positions truthfully", async () => {
    let captured: VirtualListRef | null = null;
    // Stable, block-bodied ref callback (a returned value would trip React 19's
    // ref-cleanup semantics; identity must not churn across re-renders).
    const capture = (r: VirtualListRef | null) => {
      captured = r;
    };
    const getCaptured = (): VirtualListRef | null => captured;
    const { unmount } = render(<Harness items={items(30)} offset={21} onRef={capture} />);
    await tick();

    const ref = getCaptured();
    if (ref === null) throw new Error("VirtualList ref was never captured");
    expect(ref.getContentHeight()).toBe(30);
    expect(ref.getViewportHeight()).toBe(9);
    expect(ref.getBottomOffset()).toBe(21);
    expect(ref.getItemHeight(3)).toBe(1);
    expect(ref.getItemPosition(10)).toEqual({ top: 10, height: 1 });
    expect(ref.getItemPosition(99)).toBeNull();
    unmount();
  });

  test("bottomAlign hugs the bottom and pads item positions", async () => {
    let captured: VirtualListRef | null = null;
    const capture = (r: VirtualListRef | null) => {
      captured = r;
    };
    const getCaptured = (): VirtualListRef | null => captured;
    const { lastFrame, unmount } = render(
      <Harness items={items(3)} offset={0} bottomAlign onRef={capture} />,
    );
    await tick();
    const frame = lastFrame() ?? "";

    // 3 items in a 9-row viewport: 6 blank rows above, items on the last 3.
    const lines = frame.split("\n");
    const composerRow = lines.length - 1;
    expect(lines[composerRow - 1]?.trim()).toBe("item-02");
    expect(lines[composerRow - 3]?.trim()).toBe("item-00");

    // Positions include the bottom-align pad (9 − 3 = 6).
    const ref = getCaptured();
    if (ref === null) throw new Error("VirtualList ref was never captured");
    expect(ref.getItemPosition(0)).toEqual({ top: 6, height: 1 });
    expect(ref.getItemPosition(2)).toEqual({ top: 8, height: 1 });
    unmount();
  });

  test("fixed scrollOffset keeps the reading window stable while content grows", async () => {
    const { lastFrame, rerender, unmount } = render(<Harness items={items(10)} offset={0} />);
    await tick();
    expect(lastFrame()).not.toContain("item-09"); // clipped below the viewport

    rerender(<Harness items={items(15)} offset={0} />);
    await tick();
    const frame = lastFrame() ?? "";
    unmount();

    // The window did not move: still items 0..8, newest content NOT auto-shown.
    expect(frame).toContain("item-00");
    expect(frame).not.toContain("item-14");
  });

  test("mounts only the visible window (+ overscan) for a huge list", async () => {
    const seen = new Set<string>();
    const onRender = (label: string): void => {
      seen.add(label);
    };
    const Counted = ({ label }: { label: string }) => {
      onRender(label);
      return <Text>{label}</Text>;
    };
    const { lastFrame, unmount } = render(
      <Box flexDirection="column" width={40} height={10}>
        <VirtualList scrollOffset={0} flexGrow={1} flexShrink={1} flexBasis={0} minHeight={0}>
          {Array.from({ length: 500 }, (_, i) => (
            <Counted key={`row-${i}`} label={`row-${String(i).padStart(3, "0")}`} />
          ))}
        </VirtualList>
        <Box height={1}>
          <Text>COMPOSER</Text>
        </Box>
      </Box>,
    );
    await tick();
    const frame = lastFrame() ?? "";
    unmount();

    // The top of the list is on screen…
    expect(frame).toContain("row-000");
    expect(frame).not.toContain("row-499");
    // …and at most the viewport rows + overscan ever mounted (not 500).
    expect(seen.size).toBeLessThan(25);
  });

  test("holding k keeps scrolling up through unmeasured items (no freeze)", async () => {
    // Regression: dense 2-row nodes vs. the 1-row estimate made every pass over
    // an unmeasured node add a +1 anchor correction. Because a relative scroll
    // read the corrected offset and wrote back the raw one, correction===1
    // cancelled each step and the list froze. The list must instead absorb the
    // correction (onScrollOffsetChange) and keep moving.
    const heights = Array.from({ length: 160 }, () => 2);
    function ScrollHarness() {
      const ref = useRef<VirtualListRef>(null);
      const [offset, setOffset] = useState(0);
      const [content, setContent] = useState(0);
      const followRef = useRef(true);
      const offsetRef = useRef(0);
      offsetRef.current = offset;
      const bottom = Math.max(0, content - (ref.current?.getViewportHeight() ?? 0));

      const scrollTo = useCallback((o: number) => {
        const b = ref.current?.getBottomOffset() ?? 0;
        const next = Math.max(0, Math.min(o, b));
        followRef.current = next >= b;
        setOffset(next);
      }, []);

      const onContent = useCallback((h: number) => {
        setContent(h);
        if (followRef.current) {
          setOffset(Math.max(0, h - (ref.current?.getViewportHeight() ?? 0)));
        }
      }, []);

      useInput((ch) => {
        if (ch === "k") scrollTo((ref.current?.getScrollOffset() ?? offsetRef.current) - 1);
      });

      return (
        <Box flexDirection="column" width={30} height={12}>
          <VirtualList
            ref={ref}
            scrollOffset={Math.min(offset, bottom)}
            onContentHeightChange={onContent}
            onScrollOffsetChange={(o) => {
              if (!followRef.current) setOffset(o);
            }}
            onViewportSizeChange={() => {}}
            flexGrow={1}
            flexShrink={1}
            flexBasis={0}
            minHeight={0}
          >
            {heights.map((h, i) => (
              <Box key={`row-${String(i).padStart(3, "0")}`} height={h} flexShrink={0}>
                <Text>{`row-${String(i).padStart(3, "0")}`}</Text>
              </Box>
            ))}
          </VirtualList>
        </Box>
      );
    }

    const firstRow = (frame: string): number => {
      for (const line of frame.split("\n")) {
        const m = /row-(\d+)/.exec(line);
        if (m) return Number(m[1]);
      }
      return -1;
    };

    const { stdin, lastFrame, unmount } = render(<ScrollHarness />);
    await tick(30);
    const start = firstRow(lastFrame() ?? "");

    // 160 items × 2 rows = 320 rows; the single-row presses must reach the top
    // region (the freeze stalled after ~10 presses at ~index 185).
    for (let press = 0; press < 340; press++) {
      stdin.write("k");
      await tick(6);
    }
    const end = firstRow(lastFrame() ?? "");
    unmount();

    expect(start).toBeGreaterThan(140); // started pinned near the tail
    expect(end).toBeLessThan(start - 140); // moved up through the whole list
    expect(end).toBeLessThanOrEqual(3); // and reached the top region
  });

  test("variable-height items keep their measured heights", async () => {
    const rows = [2, 3, 1, 4, 2];
    let captured: VirtualListRef | null = null;
    const capture = (r: VirtualListRef | null) => {
      captured = r;
    };
    const getCaptured = (): VirtualListRef | null => captured;
    const { unmount } = render(
      <Box flexDirection="column" width={40} height={10}>
        <VirtualList
          ref={capture}
          scrollOffset={0}
          flexGrow={1}
          flexShrink={1}
          flexBasis={0}
          minHeight={0}
        >
          {rows.map((h, i) => (
            <Box key={`block-${i}`} height={h} flexShrink={0}>
              <Text>{`block-${i}`}</Text>
            </Box>
          ))}
        </VirtualList>
      </Box>,
    );
    await tick();

    const ref = getCaptured();
    if (ref === null) throw new Error("VirtualList ref was never captured");
    // offsets: [0, 2, 5, 6, 10, 12]
    expect(ref.getContentHeight()).toBe(12);
    expect(ref.getItemHeight(1)).toBe(3);
    expect(ref.getItemPosition(3)).toEqual({ top: 6, height: 4 });
    expect(ref.getItemPosition(4)).toEqual({ top: 10, height: 2 });
    unmount();
  });
});
