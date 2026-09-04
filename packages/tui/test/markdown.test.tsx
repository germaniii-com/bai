import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import React from "react";
import { Text } from "ink";
import { Markdown } from "../src/components/markdown";

/**
 * Markdown → Ink rendering checks. Assertions run on the ANSI-stripped
 * last frame: what matters is that each construct's CONTENT renders and
 * the raw markdown punctuation does not, plus streaming tolerance
 * (unterminated fences must not crash or print fence markers).
 */

const tick = (ms = 30): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const stripAnsi = (s: string): string =>
  s
    .replace(/\u001b\[[0-9;]*m/g, "")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n");

async function frame(text: string): Promise<string> {
  const { lastFrame, unmount } = render(<Markdown text={text} />);
  await tick();
  const out = stripAnsi(lastFrame() ?? "");
  unmount();
  return out;
}

describe("Markdown (marked → Ink)", () => {
  test("plain paragraph renders verbatim without markdown punctuation", async () => {
    const out = await frame("Just a plain line.");
    expect(out).toContain("Just a plain line.");
  });

  test("headings render their text without # markers", async () => {
    const out = await frame("# Title\n\nBody text.");
    expect(out).toContain("Title");
    expect(out).toContain("Body text.");
    expect(out).not.toContain("# Title");
  });

  test("inline styles: strong/em/del/codespan lose their markers, keep content", async () => {
    const out = await frame("**bold** and *em* and ~~gone~~ and `code()`");
    expect(out).toContain("bold");
    expect(out).toContain("em");
    expect(out).toContain("gone");
    expect(out).toContain("code()");
    expect(out).not.toContain("**");
    expect(out).not.toContain("~~");
    expect(out).not.toContain("`code()`");
  });

  test("fenced code blocks render the language label and content, no backticks", async () => {
    const out = await frame("Before.\n\n```ts\nconst x = 1;\nconst y = 2;\n```\n\nAfter.");
    expect(out).toContain("ts");
    expect(out).toContain("const x = 1;");
    expect(out).toContain("const y = 2;");
    expect(out).not.toContain("```");
  });

  test("blockquotes render content inside the dim rail", async () => {
    const out = await frame("> quoted wisdom");
    expect(out).toContain("quoted wisdom");
    expect(out).toContain("│");
  });

  test("lists render bullet markers and hanging-indent bodies", async () => {
    const out = await frame("- first\n- second\n- third");
    expect(out).toContain("•");
    expect(out).toContain("first");
    expect(out).toContain("third");
    expect(out).not.toContain("- first");
  });

  test("ordered lists render enumeration numbers", async () => {
    const out = await frame("1. one\n2. two");
    expect(out).toContain("1.");
    expect(out).toContain("2.");
    expect(out).toContain("one");
  });

  test("nested lists indent under their parent item", async () => {
    const out = await frame("- outer\n  - inner\n- tail");
    expect(out).toContain("outer");
    expect(out).toContain("inner");
    expect(out).toContain("tail");
    // The nested bullet sits to the right of the outer bullet column.
    const innerRow = out.split("\n").find((line) => line.includes("inner"));
    expect(innerRow).toBeDefined();
    expect((innerRow ?? "").indexOf("•")).toBeGreaterThan(0);
  });

  test("task list items render checkbox glyphs", async () => {
    const out = await frame("- [x] done thing\n- [ ] open thing");
    expect(out).toContain("done thing");
    expect(out).toContain("open thing");
    expect(out).toContain("☑");
    expect(out).toContain("☐");
  });

  test("tables render headers, separator, and cells without pipe syntax", async () => {
    const out = await frame("| name | qty |\n| --- | --- |\n| hop | 3 |\n| malt | 9 |");
    expect(out).toContain("name");
    expect(out).toContain("qty");
    expect(out).toContain("hop");
    expect(out).toContain("malt");
    expect(out).not.toContain("|");
  });

  test("streaming tolerance: unterminated fence renders as a code block", async () => {
    const out = await frame("Partial reply:\n\n```python\ndef f(:");
    expect(out).toContain("python");
    expect(out).toContain("def f(:");
    expect(out).not.toContain("```");
  });

  test("streaming tolerance: unclosed bold keeps literal text, no crash", async () => {
    const out = await frame("streaming **partial");
    expect(out).toContain("streaming");
    expect(out).toContain("partial");
  });

  test("links render cyan text plus a dim URL, no markdown syntax", async () => {
    const out = await frame("see [the docs](https://example.com) now");
    expect(out).toContain("the docs");
    expect(out).toContain("(https://example.com)");
    expect(out).not.toContain("[the docs]");
  });

  test("horizontal rules render as a dim line, no --- text", async () => {
    const out = await frame("above\n\n---\n\nbelow");
    expect(out).toContain("above");
    expect(out).toContain("below");
    expect(out).toContain("─");
  });

  test("focus marker renders as a hanging-indent column", async () => {
    const { lastFrame, unmount } = render(
      <Markdown text={"line one\nline two"} marker={<Text>❯ </Text>} />,
    );
    await tick();
    const out = stripAnsi(lastFrame() ?? "");
    unmount();
    const rows = out.split("\n");
    // Marker column first, then the wrapped body starting after it.
    expect(rows[0]).toContain("❯");
    expect(out).toContain("line one");
    expect(out).toContain("line two");
  });

  test("empty and whitespace-only text render nothing", async () => {
    const out = await frame("   \n  ");
    expect(out.trim().length).toBe(0);
  });
});
