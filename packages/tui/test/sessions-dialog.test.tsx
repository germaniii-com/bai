import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import React from "react";
import type { Session, SessionId } from "@bai/shared";
import { SessionsView } from "../src/views/sessions";

/**
 * The session picker dialog (a SelectDialog over sessions):
 * type-to-filter search, ctrl+j/k navigation (all terminal spellings),
 * enter opens the highlighted session, n starts a draft (empty filter),
 * esc closes, long lists scroll in a sliding window.
 */

const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

function session(id: string, title: string): Session {
  return {
    id: id as SessionId,
    title,
    workbench: "chat",
    createdAt: "t",
    updatedAt: "t",
    meta: {},
  };
}

const sessions = [session("ses_a", "First chat"), session("ses_b", "Second chat")];

describe("SessionsView dialog (ctrl+s)", () => {
  test("renders the list, marks the active session, seeds the cursor on it", async () => {
    const { lastFrame, unmount } = render(
      <SessionsView
        sessions={sessions}
        activeId="ses_b"
        onPick={() => {}}
        onNew={() => {}}
        onDone={() => {}}
      />,
    );
    await tick();
    const frame = lastFrame() ?? "";
    unmount();

    expect(frame).toContain("First chat");
    expect(frame).toContain("Second chat");
    // Active session marked with the green ✓ gutter…
    expect(frame).toContain("✓");
    // …and the cursor seeded on it, not the top.
    const cursorLine = frame.split("\n").find((l) => l.includes("❯"));
    expect(cursorLine).toContain("Second chat");
  });

  test("esc closes the dialog (onDone)", async () => {
    let done = 0;
    const { stdin, unmount } = render(
      <SessionsView
        sessions={sessions}
        onPick={() => {}}
        onNew={() => {}}
        onDone={() => {
          done += 1;
        }}
      />,
    );
    await tick();
    stdin.write("\x1b");
    await tick();
    unmount();
    expect(done).toBe(1);
  });

  test("ctrl+j navigates down (legacy spelling); enter picks; plain j filters", async () => {
    const picked: string[] = [];
    const { stdin, lastFrame, unmount } = render(
      <SessionsView
        sessions={sessions}
        onPick={(s) => {
          picked.push(s.id);
        }}
        onNew={() => {}}
        onDone={() => {}}
      />,
    );
    await tick();

    // Plain j is a FILTER character now (provider/model parity)…
    stdin.write("j");
    await tick();
    expect(lastFrame() ?? "").toContain("filter: j");
    expect(lastFrame() ?? "").toContain("(no matches)");

    // …backspace clears it, then legacy ctrl+j (raw "\n") steps down to the
    // second session and enter picks it.
    stdin.write("\x7f"); // backspace
    await tick();
    stdin.write("\n");
    await tick();
    const cursorLine = (lastFrame() ?? "").split("\n").find((l) => l.includes("❯"));
    expect(cursorLine).toContain("Second chat");
    stdin.write("\r");
    await tick();
    unmount();
    expect(picked).toEqual(["ses_b"]);
  });

  test("search filters by title and enter picks the match", async () => {
    const picked: string[] = [];
    const { stdin, lastFrame, unmount } = render(
      <SessionsView
        sessions={sessions}
        onPick={(s) => {
          picked.push(s.id);
        }}
        onNew={() => {}}
        onDone={() => {}}
      />,
    );
    await tick();
    stdin.write("sec"); // type-to-filter
    await tick();
    const filtered = lastFrame() ?? "";
    expect(filtered).toContain("filter: sec");
    expect(filtered).toContain("Second chat");
    expect(filtered).not.toContain("First chat");

    stdin.write("\r"); // enter picks the remaining match
    await tick();
    unmount();
    expect(picked).toEqual(["ses_b"]);
  });

  test("ctrl+n starts a new (draft) session; plain n filters", async () => {
    let created = 0;
    const { stdin, lastFrame, unmount } = render(
      <SessionsView
        sessions={sessions}
        onPick={() => {}}
        onNew={() => {
          created += 1;
        }}
        onDone={() => {}}
      />,
    );
    await tick();
    // Legacy ctrl+n byte (0x0E → ch:'n', ctrl:true) fires the action…
    stdin.write("\x0e");
    await tick();
    expect(created).toBe(1);

    // …while plain n types into the filter ("Second chat" matches, "First chat" goes).
    stdin.write("n");
    await tick();
    const frame = lastFrame() ?? "";
    unmount();
    expect(frame).toContain("filter: n");
    expect(frame).toContain("Second chat");
    expect(frame).not.toContain("First chat");
  });

  test("long lists scroll in a sliding window around the cursor", async () => {
    const many = Array.from(
      { length: 30 },
      (_, i) => session(`ses_${String(i).padStart(2, "0")}`, `Chat ${i}`),
    );

    // Only the 12-row window renders at the top — with a "more" indicator on
    // the cut side.
    const boot = render(
      <SessionsView sessions={many} onPick={() => {}} onNew={() => {}} onDone={() => {}} />,
    );
    await tick();
    const bootFrame = boot.lastFrame() ?? "";
    boot.unmount();
    expect(bootFrame).toContain("Chat 0");
    expect(bootFrame).toContain("Chat 11");
    expect(bootFrame).not.toContain("Chat 12");
    expect(bootFrame).toContain("↓ 18 more");

    // Navigating deep (legacy ctrl+j ×25) slides the window and keeps the
    // cursor visible; enter picks the ABSOLUTE session under the cursor.
    const picked: string[] = [];
    const deep = render(
      <SessionsView
        sessions={many}
        onPick={(s) => {
          picked.push(s.id);
        }}
        onNew={() => {}}
        onDone={() => {}}
      />,
    );
    await tick();
    for (let i = 0; i < 25; i++) {
      deep.stdin.write("\n");
      await tick();
    }
    const deepFrame = deep.lastFrame() ?? "";
    expect(deepFrame).toContain("Chat 25");
    expect(deepFrame).toContain("↑ 18 more");
    deep.stdin.write("\r");
    await tick();
    deep.unmount();
    expect(picked).toEqual(["ses_25"]);
  });

  test("windowSize caps the list (the overlay shell's height budget)", async () => {
    const many = Array.from(
      { length: 30 },
      (_, i) => session(`ses_${String(i).padStart(2, "0")}`, `Chat ${i}`),
    );
    const { lastFrame, unmount } = render(
      <SessionsView sessions={many} windowSize={4} onPick={() => {}} onNew={() => {}} onDone={() => {}} />,
    );
    await tick();
    const frame = lastFrame() ?? "";
    unmount();
    expect(frame).toContain("Chat 0");
    expect(frame).toContain("Chat 3");
    expect(frame).not.toContain("Chat 4");
    expect(frame).toContain("↓ 26 more");
  });
});
