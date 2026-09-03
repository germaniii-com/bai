import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import React, { useRef, useState } from "react";
import { Box, Text } from "ink";
import { ScrollView, type ScrollViewRef } from "../src/components/scroll-view";

/**
 * Contract tests for the vendored ScrollView (components/scroll-view.tsx):
 *
 *   1. Clipping — content taller than the bounded viewport is clipped at the
 *      viewport's own bounds; a sibling below (composer) never bleeds.
 *   2. Continuous scroll — `scrollOffset` is terminal ROWS from the content
 *      top; any row offset is renderable, not just item boundaries.
 *   3. Measurement truth — measured heights/positions match the real layout.
 *   4. Bottom-align — short content hugs the bottom of the viewport and item
 *      positions include the resulting pad.
 *   5. Reading-window stability — a fixed scrollOffset keeps the same content
 *      visible while the content grows (no auto-follow; follow is the
 *      caller's policy).
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
  onRef?: (ref: ScrollViewRef | null) => void;
}) {
  return (
    <Box flexDirection="column" width={40} height={10}>
      <ScrollView
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
      </ScrollView>
      <Box height={1}>
        <Text>COMPOSER</Text>
      </Box>
    </Box>
  );
}

const items = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => `item-${String(i).padStart(2, "0")}`);

describe("ScrollView (vendored scroll container)", () => {
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
    // Offset 5 lands mid-content: item-05 is the first visible row.
    const { lastFrame, unmount } = render(<Harness items={items(30)} offset={5} />);
    await tick();
    const frame = lastFrame() ?? "";
    unmount();

    const lines = frame.split("\n").filter((l) => l.trim().length > 0);
    expect(lines[0]).toContain("item-05");
    expect(frame).not.toContain("item-04");
  });

  test("measures the viewport, content, and item positions truthfully", async () => {
    let captured: ScrollViewRef | null = null;
    // Stable, block-bodied ref callback (a returned value would trip React 19's
    // ref-cleanup semantics; identity must not churn across re-renders).
    const capture = (r: ScrollViewRef | null) => {
      captured = r;
    };
    // Read through a function: TypeScript's flow analysis can't see the
    // closure assignment and would otherwise narrow `captured` to `null`.
    const getCaptured = (): ScrollViewRef | null => captured;
    const { unmount } = render(<Harness items={items(30)} offset={21} onRef={capture} />);
    await tick();

    const ref = getCaptured();
    if (ref === null) throw new Error("ScrollView ref was never captured");
    expect(ref.getContentHeight()).toBe(30);
    expect(ref.getViewportHeight()).toBe(9);
    expect(ref.getBottomOffset()).toBe(21);
    expect(ref.getItemHeight(3)).toBe(1);
    expect(ref.getItemPosition(10)).toEqual({ top: 10, height: 1 });
    expect(ref.getItemPosition(99)).toBeNull();
    unmount();
  });

  test("bottomAlign hugs the bottom and pads item positions", async () => {
    let captured: ScrollViewRef | null = null;
    const capture = (r: ScrollViewRef | null) => {
      captured = r;
    };
    const getCaptured = (): ScrollViewRef | null => captured;
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
    if (ref === null) throw new Error("ScrollView ref was never captured");
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

    // The window did not move: still items 0..8, newest content NOT auto-shown
    // (following the bottom is the caller's policy, not the component's).
    expect(frame).toContain("item-00");
    expect(frame).not.toContain("item-14");
  });
});
