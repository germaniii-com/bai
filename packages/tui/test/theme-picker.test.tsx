import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import React from "react";
import { ThemePicker } from "../src/views/theme-picker";

/**
 * The theme picker: the cursor seeds on the active theme (resolved
 * through the same fallback the App applies), navigation live-previews via
 * onHighlight, enter confirms, esc closes.
 */

const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("ThemePicker", () => {
  test("seeds the cursor on the active theme and live-previews on move", async () => {
    const previews: string[] = [];
    const { stdin, lastFrame, unmount } = render(
      <ThemePicker
        current="dracula"
        onPreview={(v) => previews.push(v)}
        onPick={() => {}}
        onClose={() => {}}
      />,
    );
    await tick();
    // Seeded on Dracula (not the top of the list).
    expect(lastFrame() ?? "").toContain("❯ Dracula");
    // Mount fires the initial preview (the active theme — a no-op apply).
    expect(previews[0]).toBe("dracula");

    // ctrl+j (legacy lone "\n") moves down → previews the next theme.
    stdin.write("\n");
    await tick();
    const moved = lastFrame() ?? "";
    unmount();
    expect(moved).toContain("❯ Nord");
    expect(previews).toContain("nord");
  });

  test("an unknown config id seeds on the resolved default, not the top", async () => {
    const previews: string[] = [];
    const { lastFrame, unmount } = render(
      <ThemePicker
        current="made-up-theme"
        onPreview={(v) => previews.push(v)}
        onPick={() => {}}
        onClose={() => {}}
      />,
    );
    await tick();
    const frame = lastFrame() ?? "";
    unmount();
    expect(frame).toContain("❯ Dark");
    expect(previews[0]).toBe("dark");
  });

  test("enter confirms the highlighted theme", async () => {
    const picked: string[] = [];
    const { stdin, unmount } = render(
      <ThemePicker
        current="dark"
        onPreview={() => {}}
        onPick={(v) => picked.push(v)}
        onClose={() => {}}
      />,
    );
    await tick();
    stdin.write("\n"); // down one (legacy ctrl+j)
    await tick();
    stdin.write("\r"); // enter confirms
    await tick();
    unmount();
    expect(picked).toEqual(["catppuccin-latte"]);
  });
});
