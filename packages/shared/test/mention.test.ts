import { describe, expect, test } from "bun:test";
import {
  applyMention,
  collapseMentions,
  expandMentionPaths,
  formatMentionRange,
  mentionDisplayToken,
  mentionLeaf,
  mentionTrigger,
  parseMentions,
  splitMentionQuery,
  splitMentions,
} from "../src/mention";

describe("mentionTrigger", () => {
  test("fires at the start of the text", () => {
    expect(mentionTrigger("#src", 4)).toEqual({ start: 0, raw: "src" });
  });

  test("fires after whitespace", () => {
    expect(mentionTrigger("look at #src/fo", 15)).toEqual({ start: 8, raw: "src/fo" });
  });

  test("does not fire mid-word", () => {
    expect(mentionTrigger("foo#bar", 7)).toBeNull();
    expect(mentionTrigger("foo@bar", 7)).toBeNull();
  });

  test("closes on whitespace", () => {
    expect(mentionTrigger("#src file", 9)).toBeNull();
    expect(mentionTrigger("# ", 2)).toBeNull();
  });

  test("clamps the cursor and tolerates empty text", () => {
    expect(mentionTrigger("", 0)).toBeNull();
    expect(mentionTrigger("#ab", 99)).toEqual({ start: 0, raw: "ab" });
  });

  test("returns the most recent token", () => {
    expect(mentionTrigger("#one #two", 9)).toEqual({ start: 5, raw: "two" });
  });
});

describe("splitMentionQuery", () => {
  test("no range", () => {
    expect(splitMentionQuery("src/foo.ts")).toEqual({ pathQuery: "src/foo.ts" });
  });

  test("from only", () => {
    expect(splitMentionQuery("src/foo.ts:10")).toEqual({
      pathQuery: "src/foo.ts",
      range: { from: 10 },
    });
  });

  test("inclusive range", () => {
    expect(splitMentionQuery("src/foo.ts:10-20")).toEqual({
      pathQuery: "src/foo.ts",
      range: { from: 10, to: 20 },
    });
  });

  test("open-ended range", () => {
    expect(splitMentionQuery("src/foo.ts:10-")).toEqual({
      pathQuery: "src/foo.ts",
      range: { from: 10 },
    });
  });

  test("non-numeric suffix stays in the path", () => {
    expect(splitMentionQuery("a:b")).toEqual({ pathQuery: "a:b" });
  });

  test("reversed range collapses to from-only", () => {
    expect(splitMentionQuery("a:20-10")).toEqual({ pathQuery: "a", range: { from: 20 } });
  });

  test("clamps zero to line 1", () => {
    expect(splitMentionQuery("a:0-3")).toEqual({ pathQuery: "a", range: { from: 1, to: 3 } });
  });
});

describe("formatMentionRange", () => {
  test("formats both shapes and empty", () => {
    expect(formatMentionRange(undefined)).toBe("");
    expect(formatMentionRange({ from: 3 })).toBe(":3");
    expect(formatMentionRange({ from: 3, to: 9 })).toBe(":3-9");
  });
});

describe("applyMention", () => {
  const trigger = (text: string) => {
    const t = mentionTrigger(text, text.length);
    if (t === null) throw new Error("no trigger");
    return t;
  };

  test("inserts a file path and a trailing space", () => {
    expect(applyMention("#fo", 3, trigger("#fo"), { path: "src/foo.ts", type: "file" })).toEqual({
      text: "#src/foo.ts ",
      cursor: 12,
    });
  });

  test("preserves a typed range", () => {
    const text = "#fo:10-20";
    expect(
      applyMention(text, text.length, trigger(text), { path: "src/foo.ts", type: "file" }, { from: 10, to: 20 }),
    ).toEqual({ text: "#src/foo.ts:10-20 ", cursor: 18 });
  });

  test("directories get a slash and drop the range", () => {
    const text = "#sr";
    expect(
      applyMention(text, text.length, trigger(text), { path: "src", type: "dir" }, { from: 5 }),
    ).toEqual({ text: "#src/", cursor: 5 });
  });

  test("does not double the space when one already follows", () => {
    const text = "#fo rest";
    const result = applyMention(text, 3, mentionTrigger(text, 3)!, { path: "src/foo.ts", type: "file" });
    expect(result.text).toBe("#src/foo.ts rest");
  });
});

describe("parseMentions", () => {
  test("extracts every mention with ranges", () => {
    const text = "compare #src/a.ts and #src/b.ts:5-9, then rest";
    expect(parseMentions(text)).toEqual([
      { raw: "#src/a.ts", path: "src/a.ts" },
      { raw: "#src/b.ts:5-9", path: "src/b.ts", from: 5, to: 9 },
    ]);
  });

  test("skips a bare hash and keeps non-numeric colons in the path", () => {
    expect(parseMentions("a # and #a:b")).toEqual([{ raw: "#a:b", path: "a:b" }]);
  });

  test("trims trailing sentence punctuation", () => {
    expect(parseMentions("see #src/foo.ts.")).toEqual([{ raw: "#src/foo.ts", path: "src/foo.ts" }]);
  });
});

describe("leaf display + submit expansion", () => {
  test("mentionLeaf returns the basename", () => {
    expect(mentionLeaf("src/components/button.tsx")).toBe("button.tsx");
    expect(mentionLeaf("README.md")).toBe("README.md");
  });

  test("mentionDisplayToken uses the shortest unique suffix", () => {
    expect(mentionDisplayToken("src/components/button.tsx", [])).toBe("button.tsx");
    expect(mentionDisplayToken("src/components/button.tsx", ["button.tsx"])).toBe("components/button.tsx");
    expect(mentionDisplayToken("a/b/c.ts", ["c.ts", "b/c.ts"])).toBe("a/b/c.ts");
  });

  test("expandMentionPaths rewrites leaf tokens, preserving ranges", () => {
    const map = { "button.tsx": "src/components/button.tsx", "index.ts": "src/index.ts" };
    expect(expandMentionPaths("read #button.tsx:10-20 and #index.ts", map)).toBe(
      "read #src/components/button.tsx:10-20 and #src/index.ts",
    );
  });

  test("expandMentionPaths leaves unmapped and full-path tokens alone", () => {
    const map = { "button.tsx": "src/components/button.tsx" };
    expect(expandMentionPaths("see #src/other.ts and #typed", map)).toBe("see #src/other.ts and #typed");
  });
});

describe("collapseMentions", () => {
  test("collapses full paths to unique leaves and maps them back", () => {
    const r = collapseMentions("read #Japan2027/food.md and #Japan2027/itinerary.md");
    expect(r.text).toBe("read #food.md and #itinerary.md");
    expect(r.paths).toEqual({
      "food.md": "Japan2027/food.md",
      "itinerary.md": "Japan2027/itinerary.md",
    });
  });

  test("disambiguates colliding basenames", () => {
    const r = collapseMentions("see #a/food.md then #b/food.md");
    expect(r.text).toBe("see #food.md then #b/food.md");
    expect(r.paths).toEqual({ "food.md": "a/food.md", "b/food.md": "b/food.md" });
  });

  test("preserves ranges and leaves bare leaves / dir refs alone", () => {
    const r = collapseMentions("x #src/a.ts:10-20 y #plain z #src/");
    expect(r.text).toBe("x #a.ts:10-20 y #plain z #src/");
    expect(r.paths).toEqual({ "a.ts": "src/a.ts" });
  });

  test("round-trips through expandMentionPaths", () => {
    const r = collapseMentions("read #Japan2027/food.md:2-4");
    expect(expandMentionPaths(r.text, r.paths)).toBe("read #Japan2027/food.md:2-4");
  });
});

describe("splitMentions", () => {
  test("splits text and mentions with ranges", () => {
    expect(splitMentions("read #src/a.ts:10-20 and #b.ts, done")).toEqual([
      { type: "text", text: "read " },
      { type: "mention", text: "#src/a.ts:10-20", path: "src/a.ts", from: 10, to: 20 },
      { type: "text", text: " and " },
      { type: "mention", text: "#b.ts", path: "b.ts" },
      { type: "text", text: ", done" },
    ]);
  });

  test("returns one text segment when there are no mentions", () => {
    expect(splitMentions("just words")).toEqual([{ type: "text", text: "just words" }]);
    expect(splitMentions("")).toEqual([]);
  });
});
