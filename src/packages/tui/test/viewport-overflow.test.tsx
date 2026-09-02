import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import React from "react";
import { Box, Text } from "ink";

/**
 * The viewport's overflow contract — the DETERMINISTIC guard against
 * streaming text bleeding into the composer (the fix for garbled overlap):
 *
 *   <Box justifyContent="flex-end" overflowY="hidden" flexShrink={0} children>
 *
 * When the transcript is taller than the viewport, content is clipped at the
 * viewport's own bounds: the NEWEST message stays pinned and visible, and
 * nothing renders below the box (where the composer sits). The height
 * estimate decides how much HISTORY is visible, never whether the newest is.
 */

/** Mini replica of the chat viewport + a composer sibling below it. */
function Viewport({ messages, rows, columns, overflow }: { messages: string[]; rows: number; columns: number; overflow: "visible" | "hidden" }) {
  return (
    <Box flexDirection="column" width={columns + 10}>
      <Box
        width={columns}
        height={rows}
        flexDirection="column"
        justifyContent="flex-end"
        overflowY={overflow}
        flexShrink={0}
      >
        {messages.map((m, i) => (
          <Box key={i} flexShrink={0} flexDirection="column">
            <Text wrap="wrap">{m}</Text>
          </Box>
        ))}
      </Box>
      {/* The composer sibling — any bleed lands HERE and garbles it. */}
      <Box height={1}>
        <Text>COMPOSER</Text>
      </Box>
    </Box>
  );
}

const prose =
  "Round 2 results: 3/5 with a confession. Two of my questions were unanswerable as written — " +
  "I gave you character names where I asked for something else. Flagging them and grading honestly: " +
  "the slow-dance moment for George and Marty landing in 1955 staring in the space-time continuum.";

const messages = [
  "You scored 3/5.",
  `The two misses: Q2 and Q4. Let me explain each in detail with a generous helping of prose so it wraps: ${prose}`,
  "NEWEST: OK here is the final tally with the full markdown table and everything wrapped properly so it fills the whole viewport and then some.",
];

describe("chat viewport overflow clipping", () => {
  test("overflow hidden: exactly `rows` lines, newest visible, no composer bleed", () => {
    const { lastFrame, unmount } = render(
      <Viewport messages={messages} rows={10} columns={60} overflow="hidden" />,
    );
    const frame = lastFrame() ?? "";
    unmount();

    const lines = frame.split("\n");
    // The viewport (10 rows) + the composer row below.
    expect(lines.length).toBe(11);
    expect(frame).toContain("NEWEST");
    expect(frame).toContain("COMPOSER");
    // The composer row must contain ONLY the composer marker — no message
    // text bled into it.
    const composerRow = lines[lines.length - 1];
    expect(composerRow?.trim()).toBe("COMPOSER");
  });

  test("overflow visible (regression): the newest can still be cut or bleed into the composer", () => {
    const { lastFrame, unmount } = render(
      <Viewport messages={messages} rows={10} columns={60} overflow="visible" />,
    );
    const frame = lastFrame() ?? "";
    unmount();
    const lines = frame.split("\n").filter((l) => l.trim().length > 0);
    // Under visible overflow the frame exceeds the viewport height — this is
    // the pre-fix failure mode the hidden clip eliminates.
    expect(lines.length).toBeGreaterThan(10);
  });
});