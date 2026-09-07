import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import React from "react";
import type { PickerOption } from "../src/state/providers";
import { SelectDialog } from "../src/components/dialog";

/**
 * The shared select dialog (providers / accounts / the flat model list): ctrl+j/k
 * navigate down/up — including ctrl+j's legacy lone-"\n" spelling — while
 * plain j/k still type into the filter, and enter picks the highlighted
 * option.
 */

const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

const options: PickerOption[] = Array.from({ length: 15 }, (_, i) => ({
  value: `opt-${String(i).padStart(2, "0")}`,
  label: `Option ${String(i).padStart(2, "0")}`,
}));

function cursorLabel(frame: string): string | null {
  return frame.match(/❯ (Option \d+)/)?.[1] ?? null;
}

describe("SelectDialog ctrl+j/k navigation", () => {
  test("ctrl+j moves down, ctrl+k moves up (legacy + kitty spellings)", async () => {
    const { stdin, lastFrame, unmount } = render(
      <SelectDialog title="pick" options={options} onPick={() => {}} onClose={() => {}} />,
    );
    await tick();
    expect(cursorLabel(lastFrame() ?? "")).toBe("Option 00");

    // Legacy ctrl+j byte arrives as a raw linefeed ("\n").
    stdin.write("\n");
    await tick();
    expect(cursorLabel(lastFrame() ?? "")).toBe("Option 01");

    // Kitty-protocol ctrl+j (CSI u, codepoint 106, modifier 5 = ctrl).
    stdin.write("\x1b[106;5u");
    await tick();
    expect(cursorLabel(lastFrame() ?? "")).toBe("Option 02");

    // Legacy ctrl+k byte (0x0B → ch:'k', ctrl:true).
    stdin.write("\x0b");
    await tick();
    expect(cursorLabel(lastFrame() ?? "")).toBe("Option 01");

    // Clamped at the top: ctrl+k past the first option stays there.
    stdin.write("\x0b");
    await tick();
    stdin.write("\x0b");
    await tick();
    expect(cursorLabel(lastFrame() ?? "")).toBe("Option 00");
    unmount();
  });

  test("enter picks the highlighted option after ctrl+j navigation", async () => {
    const picked: string[] = [];
    const { stdin, unmount } = render(
      <SelectDialog
        title="pick"
        options={options}
        onPick={(v) => {
          picked.push(v);
        }}
        onClose={() => {}}
      />,
    );
    await tick();
    stdin.write("\n"); // down one (legacy ctrl+j)
    await tick();
    stdin.write("\n"); // down two
    await tick();
    stdin.write("\r"); // enter picks
    await tick();
    unmount();
    expect(picked).toEqual(["opt-02"]);
  });

  test("plain j/k still type into the filter (no navigation)", async () => {
    const { stdin, lastFrame, unmount } = render(
      <SelectDialog title="pick" options={options} onPick={() => {}} onClose={() => {}} />,
    );
    await tick();
    stdin.write("j");
    await tick();
    const frame = lastFrame() ?? "";
    unmount();

    expect(frame).toContain("filter: j");
    // "Option NN" contains no "j" — the filter matched nothing.
    expect(frame).toContain("(no matches)");
    expect(cursorLabel(frame)).toBeNull();
  });

  test("ctrl-chord actions fire (ctrl+a add) and plain letters type", async () => {
    const fired: string[] = [];
    const { stdin, lastFrame, unmount } = render(
      <SelectDialog
        title="pick"
        options={[]}
        actions={[{ key: "a", label: "add", onAction: (v) => fired.push(v) }]}
        onPick={() => {}}
        onClose={() => {}}
      />,
    );
    await tick();

    // Empty list: the empty hint advertises the ctrl chord…
    expect(lastFrame() ?? "").toContain("(none yet — ctrl+a to add)");
    expect(lastFrame() ?? "").toContain("ctrl+a add");

    // …legacy ctrl+a byte (0x01 → ch:'a', ctrl:true) fires it with ""…
    stdin.write("\x01");
    await tick();
    expect(fired).toEqual([""]);

    // …and plain a types into the filter instead.
    stdin.write("a");
    await tick();
    const frame = lastFrame() ?? "";
    unmount();
    expect(frame).toContain("filter: a");
  });
});
