import { describe, expect, test } from "bun:test";
import {
  backspace,
  deleteForward,
  deleteWord,
  deleteWordBefore,
  insert,
  insertMultiline,
  moveLeft,
  moveLineDown,
  moveLineEnd,
  moveLineStart,
  moveLineUp,
  moveRight,
  openAbove,
  openBelow,
  sanitize,
  type Editor,
} from "../src/state/composer";

const e = (text: string, cursor: number): Editor => ({ text, cursor });

describe("deleteWord (readline unix-word-rubout)", () => {
  test("deletes the word before the cursor, keeping the separating space", () => {
    expect(deleteWord("abc def")).toBe("abc ");
    expect(deleteWord("abc def ghi")).toBe("abc def ");
  });
  test("a second press eats the separating space with the previous word", () => {
    expect(deleteWord(deleteWord("abc def"))).toBe("");
  });
  test("trailing whitespace collapses with the word", () => {
    expect(deleteWord("abc   ")).toBe("");
    expect(deleteWord("a  b  ")).toBe("a  ");
  });
  test("edges", () => {
    expect(deleteWord("abc")).toBe("");
    expect(deleteWord("")).toBe("");
    expect(deleteWord("   ")).toBe("");
  });
});

describe("sanitize", () => {
  test("keeps tab and newline, strips other C0 controls and DEL", () => {
    expect(sanitize("a\nb\tc")).toBe("a\nb\tc");
    expect(sanitize("a\x00b\x1bc\x7fd")).toBe("abcd");
    expect(sanitize("a\rb")).toBe("ab"); // \r never belongs in a draft
  });
});

describe("insert", () => {
  test("inserts at the cursor and advances it", () => {
    expect(insert(e("abc", 1), "X")).toEqual(e("aXbc", 2));
    expect(insert(e("abc", 3), "X")).toEqual(e("abcX", 4));
    expect(insert(e("abc", 0), "X")).toEqual(e("Xabc", 1));
  });
  test("literal newlines split at the cursor (paste path)", () => {
    expect(insert(e("abc", 1), "x\ny")).toEqual(e("ax\nybc", 4));
  });
  test("empty string is a no-op", () => {
    expect(insert(e("abc", 1), "")).toEqual(e("abc", 1));
  });
});

describe("insertMultiline (typed path: \\n is structural vim-o)", () => {
  test("lone newline opens a line below the cursor's line", () => {
    expect(insertMultiline(e("abc", 3), "\n")).toEqual(e("abc\n", 4));
  });
  test("mid-line cursor: newline opens at line end, not at the cursor", () => {
    expect(insertMultiline(e("abc", 1), "\n")).toEqual(e("abc\n", 4));
  });
  test("burst 'a\\nb' inserts a, opens below, inserts b", () => {
    expect(insertMultiline(e("", 0), "a\nb")).toEqual(e("a\nb", 3));
  });
  test("burst mid-line opens below the line, preserving the tail", () => {
    // cursor after 'a' on line "abc": 'x' inserts at the cursor ("axbc"),
    // then the newline opens below that line, then 'y' lands on it.
    expect(insertMultiline(e("abc", 1), "x\ny")).toEqual(e("axbc\ny", 6));
  });
});

describe("backspace / deleteForward", () => {
  test("backspace removes the char before the cursor", () => {
    expect(backspace(e("abc", 3))).toEqual(e("ab", 2));
    expect(backspace(e("abc", 1))).toEqual(e("bc", 0));
    expect(backspace(e("abc", 0))).toEqual(e("abc", 0)); // no-op at start
  });
  test("backspace removes a surrogate pair as one unit", () => {
    const s = "a😀b"; // 'a'@0, 😀@1-2, 'b'@3
    expect(backspace(e(s, 3))).toEqual(e("ab", 1)); // cursor after 😀 removes the pair
  });
  test("deleteForward removes the char under the cursor", () => {
    expect(deleteForward(e("abc", 1))).toEqual(e("ac", 1));
    expect(deleteForward(e("abc", 3))).toEqual(e("abc", 3)); // no-op at end
  });
  test("deleteForward removes a surrogate pair as one unit", () => {
    const s = "a😀b";
    expect(deleteForward(e(s, 1))).toEqual(e("ab", 1));
  });
});

describe("deleteWordBefore", () => {
  test("deletes the word before the cursor, keeping the rest", () => {
    expect(deleteWordBefore(e("abc def", 7))).toEqual(e("abc ", 4));
    expect(deleteWordBefore(e("abc def", 4))).toEqual(e("def", 0)); // prefix "abc " → ""
  });
  test("mid-draft cursor only touches the prefix (readline mid-word too)", () => {
    // cursor after 'd' in "def!": only the "d" before the cursor goes.
    expect(deleteWordBefore(e("abc def!", 5))).toEqual(e("abc ef!", 4));
    // cursor at the end of the word: the whole word goes.
    expect(deleteWordBefore(e("abc def!", 8))).toEqual(e("abc ", 4));
  });
  test("no-op on empty prefix", () => {
    expect(deleteWordBefore(e("abc", 0))).toEqual(e("abc", 0));
  });
});

describe("openBelow (vim o)", () => {
  test("cursor at end: appends a line and lands on it", () => {
    expect(openBelow(e("abc", 3))).toEqual(e("abc\n", 4));
  });
  test("empty draft still opens a line", () => {
    expect(openBelow(e("", 0))).toEqual(e("\n", 1));
  });
  test("mid-line cursor opens below the whole line", () => {
    expect(openBelow(e("abc", 1))).toEqual(e("abc\n", 4));
  });
  test("multi-line: opens below the cursor's own line", () => {
    // cursor on line 2 ("def") → new empty line between def and ghi
    expect(openBelow(e("abc\ndef\nghi", 5))).toEqual(e("abc\ndef\n\nghi", 8));
  });
});

describe("openAbove (vim O)", () => {
  test("single line: new empty line on top, cursor on it (typeable)", () => {
    expect(openAbove(e("abc", 3))).toEqual(e("\nabc", 0));
  });
  test("empty draft still opens a line", () => {
    expect(openAbove(e("", 0))).toEqual(e("\n", 0));
  });
  test("multi-line: opens above the cursor's own line", () => {
    // cursor on line 2 ("def") → new empty line between abc and def
    expect(openAbove(e("abc\ndef\nghi", 5))).toEqual(e("abc\n\ndef\nghi", 4));
  });
  test("typing lands on the new line", () => {
    expect(insert(openAbove(e("abc", 3)), "X")).toEqual(e("X\nabc", 1));
  });
});

describe("movement", () => {
  test("moveLeft/moveRight step one char and clamp at bounds", () => {
    expect(moveLeft(e("abc", 1))).toEqual(e("abc", 0));
    expect(moveLeft(e("abc", 0))).toEqual(e("abc", 0));
    expect(moveRight(e("abc", 2))).toEqual(e("abc", 3));
    expect(moveRight(e("abc", 3))).toEqual(e("abc", 3));
  });
  test("movement is surrogate-pair aware", () => {
    const s = "a😀b"; // 'a'@0, 😀@1-2, 'b'@3
    expect(moveLeft(e(s, 3))).toEqual(e(s, 1)); // over 😀 in one step
    expect(moveRight(e(s, 1))).toEqual(e(s, 3));
  });
  test("moveLineStart/moveLineEnd are per-line (readline semantics)", () => {
    const s = "abc\ndef\nghi";
    expect(moveLineStart(e(s, 5))).toEqual(e(s, 4)); // start of "def"
    expect(moveLineEnd(e(s, 5))).toEqual(e(s, 7)); // end of "def" (before \n)
    expect(moveLineStart(e(s, 0))).toEqual(e(s, 0));
    expect(moveLineEnd(e(s, 11))).toEqual(e(s, 11));
  });

  test("moveLineUp keeps the column, clamped to the line above", () => {
    const s = "abc\ndef\nghi";
    expect(moveLineUp(e(s, 5))).toEqual(e(s, 1)); // column 1 preserved
    expect(moveLineUp(e(s, 4))).toEqual(e(s, 0)); // column 0 preserved
    expect(moveLineUp(e(s, 6))).toEqual(e(s, 2)); // column 2 preserved
    expect(moveLineUp(e(s, 7))).toEqual(e(s, 3)); // line-end lands on line-end (\n)
    // clamped: line above is shorter than the column
    const t = "ab\nabcdef";
    expect(moveLineUp(e(t, 7))).toEqual(e(t, 2)); // column 5 → clamped to "ab" end
  });

  test("moveLineUp is a no-op on the first line", () => {
    expect(moveLineUp(e("abc", 1))).toEqual(e("abc", 1));
    expect(moveLineUp(e("abc\ndef", 1))).toEqual(e("abc\ndef", 1)); // cursor on line 1
  });

  test("moveLineDown keeps the column, clamped to the line below", () => {
    const s = "abc\ndef\nghi";
    expect(moveLineDown(e(s, 1))).toEqual(e(s, 5)); // column 1 preserved
    expect(moveLineDown(e(s, 3))).toEqual(e(s, 7)); // line-end → line-end (\n)
    // clamped: line below is shorter than the column
    const t = "abcdef\nab";
    expect(moveLineDown(e(t, 3))).toEqual(e(t, 9)); // column 3 → clamped to "ab" end
  });

  test("moveLineDown is a no-op on the last line", () => {
    expect(moveLineDown(e("abc", 1))).toEqual(e("abc", 1));
    expect(moveLineDown(e("abc\ndef", 5))).toEqual(e("abc\ndef", 5));
  });

  test("moveLineDown reaches a trailing empty line", () => {
    expect(moveLineDown(e("abc\n", 1))).toEqual(e("abc\n", 4));
  });
});
