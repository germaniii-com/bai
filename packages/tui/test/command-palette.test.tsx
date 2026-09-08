import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import React from "react";
import { buildCommandSpecs, type CommandContext } from "../src/state/commands";
import { CommandPalette } from "../src/views/command-palette";

/**
 * The supermenu (ctrl+p): Suggested-first sectioning, category headers,
 * ctrl+j/k navigation across section boundaries, type-to-filter, enter
 * dispatch, esc close — the SelectDialog interaction vocabulary over the
 * command registry.
 */

const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

const ctx: CommandContext = {
  sessionCount: 0,
  hasActiveSession: false,
  needsSetup: false,
  awayFromChat: false,
};

const specs = buildCommandSpecs(ctx);

function cursorLabel(frame: string): string | null {
  // Rows fill the box width before the right border — strip the padding.
  return frame.match(/❯ (.+)/)?.[1]?.replace(/[│\s]+$/, "") ?? null;
}

describe("CommandPalette", () => {
  test("renders category headers in a sliding window; scrolling reveals the rest", async () => {
    const { stdin, lastFrame, unmount } = render(<CommandPalette specs={specs} onRun={() => {}} onClose={() => {}} />);
    await tick();
    const frame = lastFrame() ?? "";
    // The 12-line window shows the registry's head; the tail is below the
    // fold (the "↓ more" marker).
    expect(frame).toContain("Session");
    expect(frame).toContain("Model");
    expect(frame).toContain("Skills");
    expect(frame).not.toContain("System");
    expect(frame).toContain("↓ more");
    expect(cursorLabel(frame)).toBe("Switch session");

    // Walk to the tail: the window follows the cursor and reveals System.
    for (let i = 0; i < 9; i++) {
      stdin.write("\n"); // legacy ctrl+j
      await tick();
    }
    const tail = lastFrame() ?? "";
    expect(tail).toContain("System");
    expect(tail).toContain("Quit");
    expect(tail).toContain("↑ more");
    unmount();
  });

  test("suggested commands float to the top under their own header and duplicate into their group", async () => {
    const suggested = buildCommandSpecs({ ...ctx, needsSetup: true });
    const { lastFrame, unmount } = render(<CommandPalette specs={suggested} onRun={() => {}} onClose={() => {}} />);
    await tick();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Suggested");
    // Cursor starts on the first suggested entry…
    expect(cursorLabel(frame)).toBe("Connect provider");
    // …and the command still sits in its Provider group further down.
    const suggestedAt = frame.indexOf("Suggested");
    expect(frame.indexOf("Connect provider")).toBeGreaterThan(-1);
    expect(frame.indexOf("Provider", suggestedAt)).toBeGreaterThan(frame.indexOf("Connect provider"));
    unmount();
  });

  test("ctrl+j/k navigate across section boundaries (legacy + kitty spellings)", async () => {
    const { stdin, lastFrame, unmount } = render(
      <CommandPalette specs={specs} onRun={() => {}} onClose={() => {}} />,
    );
    await tick();
    expect(cursorLabel(lastFrame() ?? "")).toBe("Switch session");

    stdin.write("\n"); // legacy ctrl+j byte
    await tick();
    expect(cursorLabel(lastFrame() ?? "")).toBe("New session");

    stdin.write("\x1b[106;5u"); // kitty ctrl+j
    await tick();
    expect(cursorLabel(lastFrame() ?? "")).toBe("Switch model");

    stdin.write("\x0b"); // legacy ctrl+k byte
    await tick();
    expect(cursorLabel(lastFrame() ?? "")).toBe("New session");

    stdin.write("\x0b");
    await tick();
    stdin.write("\x0b"); // clamped at the top
    await tick();
    expect(cursorLabel(lastFrame() ?? "")).toBe("Switch session");
    unmount();
  });

  test("enter runs the highlighted command", async () => {
    const ran: string[] = [];
    const { stdin, unmount } = render(
      <CommandPalette
        specs={specs}
        onRun={(id) => {
          ran.push(id);
        }}
        onClose={() => {}}
      />,
    );
    await tick();
    stdin.write("\n"); // down one (legacy ctrl+j)
    await tick();
    stdin.write("\r"); // enter runs
    await tick();
    unmount();
    expect(ran).toEqual(["session.new"]);
  });

  test("typing filters to a flat list; batched enter applies then runs", async () => {
    const ran: string[] = [];
    const { stdin, lastFrame, unmount } = render(
      <CommandPalette
        specs={specs}
        onRun={(id) => {
          ran.push(id);
        }}
        onClose={() => {}}
      />,
    );
    await tick();
    stdin.write("them\r"); // one chunk: filter "them", then run the sole match
    await tick();
    unmount();
    expect(ran).toEqual(["theme.switch"]);

    // Same filter without enter: flat list, count, no headers, no matches case.
    const { stdin: stdin2, lastFrame: frame2, unmount: unmount2 } = render(
      <CommandPalette specs={specs} onRun={() => {}} onClose={() => {}} />,
    );
    await tick();
    stdin2.write("zzz");
    await tick();
    const noMatch = frame2() ?? "";
    expect(noMatch).toContain("no matches");
    expect(noMatch).not.toContain("Session");
    unmount2();

    const { stdin: stdin3, lastFrame: frame3, unmount: unmount3 } = render(
      <CommandPalette specs={specs} onRun={() => {}} onClose={() => {}} />,
    );
    await tick();
    stdin3.write("mod");
    await tick();
    const filtered = frame3() ?? "";
    expect(filtered).toContain("filter: mod");
    expect(filtered).toContain("1/11");
    expect(filtered).not.toContain("Suggested");
    expect(cursorLabel(filtered)).toBe("Switch model");
    unmount3();
  });

  test("esc closes; plain letters type into the filter instead of navigating", async () => {
    let closed = false;
    const { stdin, lastFrame, unmount } = render(
      <CommandPalette specs={specs} onRun={() => {}} onClose={() => (closed = true)} />,
    );
    await tick();
    stdin.write("s"); // plain s: filter, not navigation
    await tick();
    expect((lastFrame() ?? "")).toContain("filter: s");
    expect(cursorLabel(lastFrame() ?? "")).toBe("Switch session");
    stdin.write("\x1b"); // esc closes
    await tick();
    expect(closed).toBe(true);
    unmount();
  });

  test("no matches: enter is a no-op", async () => {
    const ran: string[] = [];
    const { stdin, unmount } = render(
      <CommandPalette
        specs={specs}
        onRun={(id) => {
          ran.push(id);
        }}
        onClose={() => {}}
      />,
    );
    await tick();
    stdin.write("zzz\r");
    await tick();
    unmount();
    expect(ran).toEqual([]);
  });
});
