import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import React from "react";
import { Box } from "ink";
import { DialogOverlay, overlayWindowSize } from "../src/components/dialog-overlay";
import { SelectDialog } from "../src/components/dialog";

/**
 * The opencode-style overlay shell: geometry math (panel offset ¼ from the
 * top, list window capped to the terminal) and the floating render (the
 * children paint over the frame; the shell itself stays transparent).
 * The overlay mounts inside a terminal-sized root Box — same as the App.
 */
function overlay(children: React.ReactNode, columns = 80, rows = 24) {
  return (
    <Box width={columns} height={rows}>
      <DialogOverlay columns={columns} rows={rows}>{children}</DialogOverlay>
    </Box>
  );
}
describe("overlayWindowSize", () => {
  test("caps the list to ~60% of the terminal, clamped to [3, 12]", () => {
    expect(overlayWindowSize(8)).toBe(3); // tiny terminal: floor
    expect(overlayWindowSize(24)).toBe(9); // 24*0.6-5 = 9.4 → 9
    expect(overlayWindowSize(30)).toBe(12); // 13 → capped at SelectDialog's default
    expect(overlayWindowSize(100)).toBe(12);
  });
});

describe("DialogOverlay", () => {
  test("renders children inside the fixed-width floating panel", async () => {
    const { lastFrame, unmount } = render(
      overlay(
        <SelectDialog
          title="sessions"
          options={[
            { value: "a", label: "Alpha" },
            { value: "b", label: "Beta" },
          ]}
          onPick={() => {}}
          onClose={() => {}}
        />,
      ),
    );
    await tick();
    const frame = lastFrame() ?? "";
    unmount();
    expect(frame).toContain("sessions");
    expect(frame).toContain("Alpha");
    expect(frame).toContain("Beta");
    // The panel is width-capped (72 < 80 terminal): its border spans exactly
    // the panel, not the terminal.
    const borderLine = frame.split("\n").find((l) => l.includes("╭")) ?? "";
    expect(borderLine.trim().length).toBe(72);
  });

  test("windowSize shrinks the list (overlay height cap reaches the dialog)", async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ value: `v${i}`, label: `Option ${i}` }));
    const { lastFrame, unmount } = render(
      overlay(<SelectDialog title="pick" options={many} windowSize={4} onPick={() => {}} onClose={() => {}} />),
    );
    await tick();
    const frame = lastFrame() ?? "";
    unmount();
    expect(frame).toContain("Option 0");
    expect(frame).toContain("Option 3");
    expect(frame).not.toContain("Option 4");
    expect(frame).toContain("↓ 26 more");
  });
});

const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));
